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
} from "@/lib/video/shared";
import {
  QUALITY_CHOICES,
  VIDEO_EDIT_PRESETS,
  compareSizes,
  estimateOutputRange,
  fpsChoicesFor,
  missingChoice,
  plannedDimensions,
  resolutionChoicesFor,
  type QualityChoice,
  type VideoEditFocus,
  type VideoEditSettings,
  type VideoEditToolId,
} from "@/lib/video/edit-settings";
import { formatDuration } from "@/lib/video/estimate";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

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
    setSettings((cur) => ({ ...cur, resolution: preset.initial.resolution, fps: preset.initial.fps }));
    setDetecting(true);
    try {
      const info = await inspectVideoFile(selected);
      info.input.dispose();
      const [mp4, webm] = await Promise.all([
        canEncodeVideoInto("mp4", info.displayWidth, info.displayHeight),
        canEncodeVideoInto("webm", info.displayWidth, info.displayHeight),
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
        encodable: { mp4, webm },
      });
    } catch (e) {
      if (runIdRef.current !== selectId) return;
      setError(e instanceof Error ? e.message : "動画の読み込みに失敗しました");
    } finally {
      if (runIdRef.current === selectId) setDetecting(false);
    }
  }

  async function handleRun(options: { dropAudio?: boolean } = {}) {
    if (!file || missingChoice(settings)) return;
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
  }

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  const outputName = (container: OutputContainer) => {
    const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === container)?.ext ?? "mp4";
    return `${stripExtension(file?.name ?? "video")}${preset.fileSuffix}.${ext}`;
  };

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, outputName(result.outputContainer));
  }

  // 作り直しが必要か（画質・解像度・フレームレートのどれかを変えるとき）
  const needsTranscode = settings.quality !== "original" || typeof settings.resolution === "number" || typeof settings.fps === "number";
  const containerAvailable = (c: OutputContainer) =>
    !source || source.encodable[c] || (!needsTranscode && canCopyVideoInto(c, source.codec));
  const selectedContainerUnavailable = !containerAvailable(settings.container);
  const missing = missingChoice(settings);
  const resolutionOptions = source ? resolutionChoicesFor(source.width, source.height) : [];
  const fpsOptions = source ? fpsChoicesFor(source.fps) : [];

  const sections: Record<VideoEditFocus, ReactNode> = {
    container: (
      <ChoiceGroup
        key="container"
        legend="出力形式"
        name={`${toolId}-container`}
        options={OUTPUT_CONTAINER_OPTIONS.map((o) => ({ value: o.value, label: o.label, disabled: !containerAvailable(o.value) }))}
        value={settings.container}
        onChange={(v) => update({ container: v as OutputContainer })}
        note={
          OUTPUT_CONTAINER_OPTIONS.some((o) => !containerAvailable(o.value))
            ? "選べない形式は、お使いのブラウザでは、この設定で書き出せません。画質・解像度・フレームレートを「元のまま」にすると選べる場合があります。"
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
        note={QUALITY_CHOICES.find((o) => o.value === settings.quality)?.description}
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
            : "元の動画より大きい解像度は選べません（拡大はしません）。縦横の比率はそのまま保ちます。"
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
        note="元の動画より高いフレームレートは選べません（コマを増やすことはしません）。"
      />
    ),
  };
  const otherSections = (["container", "quality", "resolution", "fps"] as const).filter((k) => k !== preset.focus);

  // 変換後の予定（目安）。実際の結果は、書き出したあとに読み直して表示する
  const planRows = (() => {
    if (!file || !source) return undefined;
    const dims = plannedDimensions(settings, source.width, source.height);
    const range = estimateOutputRange(settings, { bytes: file.size, width: source.width, height: source.height, fps: source.fps });
    return [
      { label: "形式", value: settings.container.toUpperCase() },
      { label: "画質", value: QUALITY_CHOICES.find((o) => o.value === settings.quality)?.label ?? "" },
      {
        label: "解像度",
        value: settings.resolution === null ? "（選んでください）" : `${dims.width}×${dims.height}${settings.resolution === "original" ? "（変更なし）" : ""}`,
      },
      {
        label: "フレームレート",
        value: settings.fps === null ? "（選んでください）" : settings.fps === "original" ? `${fpsText(source.fps)}（変更なし）` : `${settings.fps}fps`,
      },
      { label: "音声", value: source.hasAudio ? "残す" : "なし（元の動画に音声がありません）" },
      ...(range ? [{ label: "サイズの目安", value: `約 ${formatBytes(range[0])}〜${formatBytes(range[1])}` }] : []),
    ];
  })();

  const busy = status === "processing";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
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
          <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
              あわせて変えられる設定（変えなければ元のまま。すべての設定を1回の変換でまとめて反映します）
            </p>
            {otherSections.map((k) => sections[k])}
          </div>
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
        />
      )}

      {file && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => handleRun()}
            disabled={busy || detecting || !source || missing !== null || selectedContainerUnavailable}
            aria-busy={busy || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {preset.actionLabel}
          </button>
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

/** 選択肢のボタン（ラジオボタン）。従来の動画ツールと同じ見た目 */
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
      <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              opt.disabled
                ? "cursor-not-allowed border-neutral-200 text-neutral-400 dark:border-neutral-800 dark:text-neutral-600"
                : value === opt.value
                  ? "cursor-pointer border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                  : "cursor-pointer border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
            }`}
          >
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
      {note && <p className="text-xs text-neutral-500 dark:text-neutral-400">{note}</p>}
    </fieldset>
  );
}
