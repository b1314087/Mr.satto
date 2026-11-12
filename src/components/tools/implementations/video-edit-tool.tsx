"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { VideoAudioLossNotice } from "@/components/tools/implementations/shared/video-audio-loss-notice";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { VideoOutputPlayer, VideoPreviewPanel } from "@/components/tools/implementations/shared/video-preview-panel";
import { VideoEditProcessor, type VideoEditOutput } from "@/lib/processors/browser/video-edit";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_DROPZONE_MAX_MB,
  VIDEO_INPUT_ACCEPT,
  VideoAudioWouldBeLostError,
  VideoCanceledByUserError,
  canCopyVideoInto,
  canEncodeVideoInto,
  inspectVideoFile,
  type OutputContainer,
  CONVERT_CONTAINER_OPTIONS,
  isIsobmffContainer,
} from "@/lib/video/shared";
import {
  QUALITY_CHOICES,
  VIDEO_EDIT_PRESETS,
  compareSizes,
  estimateOutputRange,
  formatTimeInput,
  fpsChoicesFor,
  hasTrim,
  missingChoice,
  needsReencode,
  parseTimeInput,
  plannedDimensions,
  plannedDuration,
  resolutionChoicesFor,
  trimError,
  type QualityChoice,
  type RotateChoice,
  type VideoEditFocus,
  type VideoEditSettings,
  type VideoEditToolId,
} from "@/lib/video/edit-settings";
import { formatDuration, resizedDimensions } from "@/lib/video/estimate";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { AdvancedSettings } from "@/components/ui/advanced-settings";

/** 選んだ動画を調べた結果（解像度・fps・音声の有無・映像のコーデック・書き出せる形式） */
interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  codec: string | null;
  encodable: Record<OutputContainer, boolean>;
}

const fpsText = (fps: number | null | undefined) => (fps ? `${Math.round(fps * 100) / 100}fps` : "不明");

/**
 * 動画の変換・編集（動画編集 工程2）。
 * 形式変換・圧縮・解像度変更・フレームレート変更の4ページが、この1つの画面を使う。
 * ページごとに違うのは、最初に選ばれている設定と、いちばん上に目立たせる設定だけ（edit-settings.ts）。
 * 出力形式・画質・解像度・フレームレートを自由に組み合わせ、最後に1回だけ動画を作り直す。
 *
 * 工程1の仕組み（音声を残せないときの案内・「音声なしで書き出す」・キャンセル・動画を消したときの
 * 結果のリセット・古い処理の結果を出さない仕組み）は、従来の4ツールと同じ形でここに持つ。
 */
export function VideoEditTool({ toolId }: { toolId: VideoEditToolId }) {
  const preset = VIDEO_EDIT_PRESETS[toolId];
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [settings, setSettings] = useState<VideoEditSettings>(preset.initial);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoEditOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);
  // 実行ごとの番号。動画を消した・選び直したあとに、前の処理の結果が遅れて届いても表示しないために使う
  const runIdRef = useRef(0);
  // 音声を書き出せないときの案内（音声なしで書き出すかを選んでもらう）
  const [audioLoss, setAudioLoss] = useState<string | null>(null);
  // 切り取りの入力欄の文字（入力途中の「1:」なども残せるよう、設定とは別に持つ）
  const [trimText, setTrimText] = useState({ start: "", end: "" });
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  useRevokeObjectUrlOnChange(result?.url);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);

  // ページを離れるときにも、実行中の処理を実際に止める
  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  function update(patch: Partial<VideoEditSettings>) {
    setSettings((cur) => ({ ...cur, ...patch }));
    // 設定を変えたら、前の設定で作った結果は使わない
    setResult(null);
    setAudioLoss(null);
    if (status === "success") setStatus("idle");
  }

  async function handleSelect(files: File[]) {
    // 前の動画の処理が残っていれば止め、その結果を新しい動画に表示しない
    const selectId = ++runIdRef.current;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    const selected = files[0];
    setFile(selected);
    setSource(null);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    setAudioLoss(null);
    // 解像度・フレームレートの選択肢は動画によって変わるため、ページの初期値に戻す（形式・画質はそのまま）
    // 切り取りの範囲も動画ごとに違うため、最初から最後までに戻す
    setSettings((cur) => ({ ...cur, resolution: preset.initial.resolution, fps: preset.initial.fps, trimStart: 0, trimEnd: null }));
    setTrimText({ start: "", end: "" });
    setDetecting(true);
    try {
      const info = await inspectVideoFile(selected);
      info.input.dispose();
      const [mp4, webm, mov, mkv] = await Promise.all([
        canEncodeVideoInto("mp4", info.displayWidth, info.displayHeight),
        canEncodeVideoInto("webm", info.displayWidth, info.displayHeight),
        canEncodeVideoInto("mov", info.displayWidth, info.displayHeight),
        canEncodeVideoInto("mkv", info.displayWidth, info.displayHeight),
      ]);
      // 調べている間に動画を消した・選び直した場合は、古い結果を使わない
      if (runIdRef.current !== selectId) return;
      setSource({
        width: info.displayWidth,
        height: info.displayHeight,
        fps: info.bestGuessFrameRate,
        durationSec: info.durationSec,
        hasAudio: info.hasAudio,
        codec: info.codec,
        encodable: { mp4, webm, mov, mkv },
      });
    } catch (e) {
      if (runIdRef.current !== selectId) return;
      setError(e instanceof Error ? e.message : "動画の読み込みに失敗しました");
    } finally {
      if (runIdRef.current === selectId) setDetecting(false);
    }
  }

  /** 切り取りの入力欄の変更（読める時間だけ設定に反映する） */
  function changeTrimText(which: "start" | "end", text: string) {
    setTrimText((cur) => ({ ...cur, [which]: text }));
    const sec = parseTimeInput(text);
    if (which === "start") update({ trimStart: sec === null ? 0 : sec });
    else update({ trimEnd: sec });
  }

  /** プレビューの今の再生位置を、開始または終了にする */
  function setTrimFromPlayer(which: "start" | "end") {
    const t = previewVideoRef.current?.currentTime;
    if (t === undefined || !Number.isFinite(t)) return;
    changeTrimText(which, formatTimeInput(t));
  }

  function resetTrim() {
    setTrimText({ start: "", end: "" });
    update({ trimStart: 0, trimEnd: null });
  }

  async function handleRun(options: { dropAudio?: boolean } = {}) {
    if (!file || missingChoice(settings) || (source && trimError(settings, source.durationSec))) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    setAudioLoss(null);

    try {
      const output = await new VideoEditProcessor().process({
        file,
        settings,
        onProgress: setProgress,
        cancelSignal: controller.signal,
        dropAudio: options.dropAudio,
      });
      if (runIdRef.current !== runId) return;
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoAudioWouldBeLostError) {
        setAudioLoss(e.message);
        setStatus("idle");
      } else if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        cancelControllerRef.current = null;
      }
    }
  }

  // 選んだ動画を消したときは、前の動画の結果・進み具合・エラー・案内をすべて消し、処理中なら止める
  function handleRemove() {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(null);
    setSource(null);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    setAudioLoss(null);
    setDetecting(false);
    setTrimText({ start: "", end: "" });
    setSettings((cur) => ({ ...cur, trimStart: 0, trimEnd: null }));
  }

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  const outputName = (container: OutputContainer) => {
    const ext = CONVERT_CONTAINER_OPTIONS.find((o) => o.value === container)?.ext ?? "mp4";
    return `${stripExtension(file?.name ?? "video")}${preset.fileSuffix}.${ext}`;
  };

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, outputName(result.outputContainer));
  }

  // 作り直しが必要か（画質・解像度・フレームレートを変える、正確に途中から切り取る、WebMで回転する）
  const needsTranscode = needsReencode(settings);
  const containerAvailable = (c: OutputContainer) =>
    !source || source.encodable[c] || (!needsTranscode && canCopyVideoInto(c, source.codec));
  const selectedContainerUnavailable = !containerAvailable(settings.container);
  const missing = missingChoice(settings);
  const resolutionOptions = source ? resolutionChoicesFor(source.width, source.height) : [];
  const fpsOptions = source ? fpsChoicesFor(source.fps) : [];
  const trimProblem = source ? trimError(settings, source.durationSec) : null;
  const trimInvalidText = (text: string) => text.trim() !== "" && Number.isNaN(parseTimeInput(text) ?? 0);

  // 工程3：切り取り（動画のすぐ下に置き、再生位置を見ながら決められるようにする）
  const trimControls = source && preset.trim && (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800" data-testid="video-edit-trim">
      <legend className="px-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">切り取り（トリミング）</legend>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        再生して止め「今の位置」でも入れられます（例: 1:05.5。空なら最初から・最後まで）。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        {(["start", "end"] as const).map((which) => (
          <div key={which} className="flex flex-col gap-1">
            <label className="text-xs text-neutral-600 dark:text-neutral-300" htmlFor={`${toolId}-trim-${which}`}>
              {which === "start" ? "開始" : "終了"}
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id={`${toolId}-trim-${which}`}
                type="text"
                inputMode="decimal"
                value={trimText[which]}
                placeholder={which === "start" ? "0:00.0" : formatTimeInput(source.durationSec)}
                onChange={(e) => changeTrimText(which, e.target.value)}
                aria-invalid={trimInvalidText(trimText[which]) || undefined}
                className={`w-24 rounded-md border px-2 py-1.5 text-sm dark:bg-neutral-900 dark:text-neutral-100 ${
                  trimInvalidText(trimText[which]) ? "border-red-400" : "border-neutral-300 dark:border-neutral-700"
                }`}
                data-testid={`video-edit-trim-${which}`}
              />
              <button
                type="button"
                onClick={() => setTrimFromPlayer(which)}
                className="rounded-md bg-neutral-100 px-2 py-1.5 text-xs text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
                data-testid={`video-edit-trim-${which}-now`}
              >
                今の位置
              </button>
            </div>
          </div>
        ))}
        {hasTrim(settings, source.durationSec) && (
          <button type="button" onClick={resetTrim} className="text-xs text-blue-600 underline dark:text-blue-400" data-testid="video-edit-trim-reset">
            切り取りをやめる
          </button>
        )}
      </div>
      {trimProblem ? (
        <p className="text-xs text-red-600 dark:text-red-400" data-testid="video-edit-trim-error">
          {trimProblem}
        </p>
      ) : (
        hasTrim(settings, source.durationSec) && (
          <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="video-edit-trim-summary">
            {formatTimeInput(settings.trimStart)} 〜 {formatTimeInput(settings.trimEnd ?? source.durationSec)}（{formatTimeInput(plannedDuration(settings, source.durationSec))}）を残します
          </p>
        )
      )}
      <label className="flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input type="checkbox" checked={settings.fastTrim} onChange={(e) => update({ fastTrim: e.target.checked })} className="mt-0.5" data-testid="video-edit-trim-fast" />
        <span>速さを優先する（画質は変わらず速いが、開始が数秒前にずれることがあります）</span>
      </label>
    </fieldset>
  );

  // 総合改修 16：形式変換では MOV・MKV も選べる（ほかの動画編集ページは、これまでどおり MP4・WebM）
  const containerOptions = toolId === "video-convert" ? CONVERT_CONTAINER_OPTIONS : OUTPUT_CONTAINER_OPTIONS;

  const sections: Record<VideoEditFocus, ReactNode> = {
    container: (
      <ChoiceGroup
        key="container"
        legend="出力形式"
        name={`${toolId}-container`}
        options={containerOptions.map((o) => ({ value: o.value, label: o.label, disabled: !containerAvailable(o.value) }))}
        value={settings.container}
        onChange={(v) => update({ container: v as OutputContainer })}
        note={
          containerOptions.some((o) => !containerAvailable(o.value))
            ? "選べない形式は、このブラウザでは書き出せません（画質などを「元のまま」にすると選べる場合があります）。"
            : undefined
        }
      />
    ),
    quality: (
      <ChoiceGroup
        key="quality"
        legend="画質・圧縮"
        name={`${toolId}-quality`}
        options={QUALITY_CHOICES.map((o) => ({ value: o.value, label: o.label }))}
        value={settings.quality}
        onChange={(v) => update({ quality: v as QualityChoice })}
        note={undefined}
      />
    ),
    resolution: (
      <ChoiceGroup
        key="resolution"
        legend={source ? `解像度（元: ${source.width}×${source.height}）` : "解像度"}
        name={`${toolId}-resolution`}
        options={[
          { value: "original", label: "元の解像度" },
          ...resolutionOptions.map((p) => ({ value: String(p), label: `${p}p` })),
        ]}
        value={settings.resolution === null ? null : String(settings.resolution)}
        onChange={(v) => update({ resolution: v === "original" ? "original" : Number(v) })}
        note={
          source && resolutionOptions.length === 0
            ? "この動画はすでに解像度が小さいため、縮小できる選択肢がありません（拡大はしません）。"
            : source
              ? `できあがる大きさ：${resolutionOptions.map((p) => { const d = resizedDimensions(source.width, source.height, p); return `${p}p＝${d.width}×${d.height}`; }).join("、")}（縦横の比率はそのまま）`
              : undefined
        }
      />
    ),
    fps: (
      <ChoiceGroup
        key="fps"
        legend={source ? `フレームレート（元: ${fpsText(source.fps)}）` : "フレームレート"}
        name={`${toolId}-fps`}
        options={[{ value: "original", label: "元のフレームレート" }, ...fpsOptions.map((f) => ({ value: String(f), label: `${f}fps` }))]}
        value={settings.fps === null ? null : String(settings.fps)}
        onChange={(v) => update({ fps: v === "original" ? "original" : Number(v) })}
        note={undefined}
      />
    ),
  };

  // 工程3：音声・回転（どのページでも「あわせて変えられる設定」に置く）
  const editSections = (
    <>
      <ChoiceGroup
        key="rotate"
        legend="回転"
        name={`${toolId}-rotate`}
        options={[
          { value: "0", label: "回転しない" },
          { value: "90", label: "右に90°" },
          { value: "180", label: "180°" },
          { value: "270", label: "左に90°" },
        ]}
        value={String(settings.rotate)}
        onChange={(v) => update({ rotate: Number(v) as RotateChoice })}
        note={settings.rotate !== 0 && isIsobmffContainer(settings.container) ? "MP4・MOVは向きの情報を付けて回転します（速く、画質も変わりません）。" : undefined}
      />
      <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={settings.muted}
          disabled={source?.hasAudio === false}
          onChange={(e) => update({ muted: e.target.checked })}
          data-testid="video-edit-mute"
        />
        音声を消す（無音の動画にする）
        {source?.hasAudio === false && <span className="text-xs text-neutral-500 dark:text-neutral-400">（元の動画に音声がありません）</span>}
      </label>
    </>
  );
  const otherSections = (["container", "quality", "resolution", "fps"] as const).filter((k) => k !== preset.focus);

  // 変換後の予定（目安）。実際の結果は、書き出したあとに読み直して表示する
  const planRows = (() => {
    if (!file || !source) return undefined;
    const dims = plannedDimensions(settings, source.width, source.height);
    const range = estimateOutputRange(settings, { bytes: file.size, width: source.width, height: source.height, fps: source.fps, durationSec: source.durationSec });
    const trimmed = hasTrim(settings, source.durationSec) && !trimProblem;
    return [
      { label: "形式", value: settings.container.toUpperCase() },
      { label: "画質", value: QUALITY_CHOICES.find((o) => o.value === settings.quality)?.label ?? "" },
      {
        label: "解像度",
        value: settings.resolution === null ? "（選んでください）" : `${dims.width}×${dims.height}${settings.resolution === "original" && settings.rotate === 0 ? "（変更なし）" : ""}`,
      },
      {
        label: "フレームレート",
        value: settings.fps === null ? "（選んでください）" : settings.fps === "original" ? `${fpsText(source.fps)}（変更なし）` : `${settings.fps}fps`,
      },
      ...(trimmed
        ? [{ label: "長さ", value: `${formatTimeInput(plannedDuration(settings, source.durationSec))}（${formatTimeInput(settings.trimStart)}〜${formatTimeInput(settings.trimEnd ?? source.durationSec)}）` }]
        : []),
      ...(settings.rotate !== 0 ? [{ label: "回転", value: settings.rotate === 90 ? "右に90°" : settings.rotate === 180 ? "180°" : "左に90°" }] : []),
      { label: "音声", value: !source.hasAudio ? "なし（元の動画に音声がありません）" : settings.muted ? "消す" : "残す" },
      ...(range ? [{ label: "サイズの目安", value: `約 ${formatBytes(range[0])}〜${formatBytes(range[1])}` }] : []),
    ];
  })();

  // 詳細設定の見出しの横に出す、今の値の要約（例：「MP4・元の解像度・元のfps・回転なし・音声あり」）
  const advancedSummary = [
    ...otherSections.map((k) =>
      k === "container"
        ? settings.container.toUpperCase()
        : k === "quality"
          ? (QUALITY_CHOICES.find((o) => o.value === settings.quality)?.label ?? "")
          : k === "resolution"
            ? settings.resolution === null
              ? "解像度を選んでください"
              : settings.resolution === "original"
                ? "元の解像度"
                : `${settings.resolution}p`
            : settings.fps === null
              ? "fpsを選んでください"
              : settings.fps === "original"
                ? "元のfps"
                : `${settings.fps}fps`
    ),
    settings.rotate === 0 ? "回転なし" : settings.rotate === 90 ? "右に90°" : settings.rotate === 180 ? "180°" : "左に90°",
    settings.muted ? "音声なし" : "音声あり",
  ].join("・");

  const busy = status === "processing";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={!!file}
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_DROPZONE_MAX_MB}
        label="動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP4 / MOV / WebM）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={handleRemove} />}
      {file && <VideoSizeWarning sizeBytes={file.size} />}
      {file && detecting && <p className="text-xs text-neutral-500 dark:text-neutral-400">動画の情報を調べています…</p>}

      {file && (
        <div className="flex flex-col gap-4" data-testid="video-edit-settings">
          <div className="flex flex-col gap-2 rounded-xl border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-900 dark:bg-blue-950/20" data-testid={`video-edit-focus-${preset.focus}`}>
            {sections[preset.focus]}
          </div>
          {/* あわせて変えられる設定は「詳細設定」にまとめ、ふだんは閉じておく。閉じていても今の値を右に出す。
              値は閉じても消えず、書き出しのときにまとめて反映する */}
          <AdvancedSettings
            title="詳細設定"
            summary={advancedSummary}
            testId="video-edit-advanced"
            defaultOpen={otherSections.some((k) => (k === "resolution" && settings.resolution === null) || (k === "fps" && settings.fps === null))}
          >
            {otherSections.map((k) => sections[k])}
            {editSections}
          </AdvancedSettings>
        </div>
      )}

      {file && (
        <VideoPreviewPanel
          file={file}
          previewUrl={previewUrl}
          meta={meta}
          onLoadedMetadata={handleLoadedMetadata}
          fps={source?.fps ?? null}
          hasAudio={source?.hasAudio ?? null}
          outputRows={planRows}
          outputNote="サイズは目安です。元の動画の画質・内容によって大きく前後し、増える場合もあります。"
          videoRef={previewVideoRef}
        >
          {trimControls}
        </VideoPreviewPanel>
      )}

      {file && (
        <div className="flex flex-col gap-2">
          <RunBar>
            <button
              type="button"
              onClick={() => handleRun()}
              disabled={busy || detecting || !source || missing !== null || selectedContainerUnavailable || trimProblem !== null}
              aria-busy={busy || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {preset.actionLabel}
            </button>
          </RunBar>
          {source && missing && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="video-edit-missing">
              {missing === "resolution" ? "変更後の解像度を選んでください。" : "変更後のフレームレートを選んでください。"}
            </p>
          )}
          {source && selectedContainerUnavailable && (
            <p className="text-xs text-amber-700 dark:text-amber-400">選んだ出力形式は、この設定では書き出せません。別の形式を選んでください。</p>
          )}
        </div>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`${preset.progressLabel}... ${Math.round(progress * 100)}%`}
        successLabel={preset.successLabel}
        onCancel={handleCancel}
        canceling={canceling}
      />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          処理をキャンセルしました。
        </div>
      )}
      {error && <ErrorMessage message={error} />}
      {audioLoss && (
        <VideoAudioLossNotice message={audioLoss} onProceed={() => handleRun({ dropAudio: true })} onDismiss={() => setAudioLoss(null)} />
      )}

      {result && file && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <ResultSummary result={result} outputName={outputName(result.outputContainer)} />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}

/** 変換前後の情報と、ファイルサイズの比較（実際に書き出したファイルを読み直した値） */
function ResultSummary({ result, outputName }: { result: VideoEditOutput; outputName: string }) {
  const cmp = compareSizes(result.inputSizeBytes, result.sizeBytes);
  const rows: [string, string, string][] = [
    ["サイズ", formatBytes(result.inputSizeBytes), formatBytes(result.sizeBytes)],
    ["解像度", `${result.input.width}×${result.input.height}`, `${result.output.width}×${result.output.height}`],
    ["フレームレート", fpsText(result.input.fps), fpsText(result.output.fps)],
    ["音声", result.input.hasAudio ? "あり" : "なし", result.output.hasAudio ? "あり" : "なし"],
    ["長さ", formatDuration(result.input.durationSec), formatDuration(result.output.durationSec)],
  ];
  return (
    <div className="flex w-full flex-col gap-2 text-sm" data-testid="video-edit-result">
      <p className="break-all text-xs text-neutral-500 dark:text-neutral-400">保存するファイル名: {outputName}</p>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="text-neutral-500 dark:text-neutral-400">
            <th className="py-1 font-normal"></th>
            <th className="py-1 font-normal">変換前</th>
            <th className="py-1 font-normal">変換後</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, before, after]) => (
            <tr key={label} className="border-t border-neutral-200 dark:border-neutral-800" data-testid={`video-edit-row-${label}`}>
              <th scope="row" className="py-1 pr-2 font-normal text-neutral-500 dark:text-neutral-400">{label}</th>
              <td className="py-1 pr-2">{before}</td>
              <td className="py-1 font-medium">{after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p data-testid="video-edit-size-compare" className={cmp.kind === "smaller" ? "font-medium text-green-700 dark:text-green-400" : "text-neutral-600 dark:text-neutral-300"}>
        {cmp.kind === "smaller"
          ? `${formatBytes(cmp.savedBytes)} 削減（${cmp.percent.toFixed(1)}%）`
          : cmp.kind === "same"
            ? "サイズは変わりませんでした。"
            : `サイズは小さくなりませんでした（${formatBytes(cmp.increasedBytes)} 増えました）。`}
      </p>
    </div>
  );
}

/** 選択肢のボタン（ラジオボタン）。見た目は全ページ共通のセグメントボタン */
function ChoiceGroup({
  legend,
  name,
  options,
  value,
  onChange,
  note,
}: {
  legend: string;
  name: string;
  options: { value: string; label: string; disabled?: boolean }[];
  value: string | null;
  onChange: (value: string) => void;
  note?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium text-ms-text">{legend}</legend>
      {/* セグメントボタンの見た目（.ms-seg-radio）。中身はこれまでどおりのラジオボタン */}
      <div className="ms-seg-radio">
        {options.map((opt) => (
          <label key={opt.value}>
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              disabled={opt.disabled}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            {opt.label}
          </label>
        ))}
      </div>
      {note && <p className="mt-1.5 text-xs text-ms-muted">{note}</p>}
    </fieldset>
  );
}
