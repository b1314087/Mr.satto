"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { VideoAudioLossNotice } from "@/components/tools/implementations/shared/video-audio-loss-notice";
import { VideoOutputPlayer } from "@/components/tools/implementations/shared/video-preview-panel";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { SliderField } from "@/components/common/slider-field";
import { PositionSliders } from "@/components/common/position-sliders";
import { TextColorField } from "@/components/common/text-color-field";
import { VideoTimeline } from "@/components/common/video-timeline";
import {
  SUBTITLE_CONTAINER_OPTIONS,
  VideoSubtitleBurnProcessor,
  VideoSubtitleProcessor,
  probeSubtitleSource,
  type SubtitleContainer,
  type SubtitleSourceProbe,
  type VideoSubtitleBurnOutput,
  type VideoSubtitleOutput,
} from "@/lib/processors/browser/video-subtitle";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_DROPZONE_MAX_MB,
  VideoAudioWouldBeLostError,
  VideoCanceledByUserError,
  type OutputContainer,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import {
  DEFAULT_CUE_LOOK,
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_CUES_MAX,
  SUBTITLE_FADE_MAX,
  SUBTITLE_FONT_OPTIONS,
  SUBTITLE_LANGUAGE_OPTIONS,
  SUBTITLE_SIZE_MAX,
  SUBTITLE_SIZE_MIN,
  SUBTITLE_TEXT_MAX,
  activeCuesAt,
  buildSrt,
  buildWebVtt,
  checkCues,
  formatSubtitleTime,
  newCueId,
  normalizeLook,
  parseSubtitleTime,
  previewCues,
  sortCuesByTime,
  type CueLook,
  type SubtitleCue,
  type SubtitleLanguage,
} from "@/lib/video/subtitles";
import { drawSubtitles, type SubtitleBackground } from "@/lib/video/subtitle-render";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";

/** 新しく足す字幕の長さ（秒） */
const NEW_CUE_LENGTH_SEC = 2;

type OutputMode = "burn" | "track";

const OUTPUT_MODE_OPTIONS: { value: OutputMode; label: string }[] = [
  { value: "burn", label: "映像に焼き付ける（見た目どおり）" },
  { value: "track", label: "字幕トラックとして入れる（ON・OFFできる）" },
];

/**
 * 動画字幕追加（総合改修 11 で大幅に改善）。
 *
 * - 字幕ごとに、文字・フォント・大きさ・文字色・縁取り（色）・位置（X・Yのバー）・表示時間・フェードを別々に設定できる。
 * - タイムライン：動画全体の再生位置と、字幕ごとのバーを出す。バーをドラッグして表示時間を変えられる（数字の入力は必須ではない）。
 * - プレビューは動画の上に重ねたキャンバスに、書き出しと同じ描画関数で描く。再生中でも、字幕の編集・設定の変更ができる。
 * - 書き出し：
 *   1. 映像に焼き付ける（既定）：見た目どおり。どの再生アプリ・SNSでも表示される。映像は作り直す（MP4・WebM）。
 *   2. 字幕トラックとして入れる：従来どおり。映像・音声はそのまま、ON・OFFできる字幕トラック（MKV・WebM）。
 *      フォント・縁取り・フェードは字幕トラックでは表せない（再生アプリにより反映されない）。
 *   3. 字幕ファイル（.srt・.vtt）も保存できる。
 * - 動画はサーバーへ送らず、ブラウザの中だけで処理する。
 */
export function VideoSubtitleTool() {
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<{ file: File; result: SubtitleSourceProbe | null; error: string | null } | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [background, setBackground] = useState<SubtitleBackground>({ color: DEFAULT_SUBTITLE_STYLE.backgroundColor, opacity: 0 });
  const [language, setLanguage] = useState<SubtitleLanguage>("jpn");
  const [mode, setMode] = useState<OutputMode>("burn");
  const [rawContainer, setContainer] = useState<SubtitleContainer>("mkv");
  const [burnContainer, setBurnContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLoss, setAudioLoss] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [result, setResult] = useState<VideoSubtitleOutput | null>(null);
  const [burnResult, setBurnResult] = useState<VideoSubtitleBurnOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const cancelControllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  useRevokeObjectUrlOnChange(result?.url);
  useRevokeObjectUrlOnChange(burnResult?.url);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);

  const probeState = file && probe?.file === file ? probe : null;
  const probing = file !== null && probeState === null;
  const durationSec = probeState?.result?.durationSec ?? (meta && meta.durationSec > 0 ? meta.durationSec : null);
  const containers = probeState?.result?.containers ?? ["mkv"];
  const container: SubtitleContainer = containers.includes(rawContainer) ? rawContainer : containers[0];
  const previewReady = probeState?.result != null;

  const check = useMemo(() => checkCues(cues, durationSec), [cues, durationSec]);
  const shown = useMemo(() => previewCues(cues), [cues]);
  const active = activeCuesAt(shown, currentTime);

  // 動画を選んだら、形式・長さ・音声の有無を調べる（このときに初めて動画の部品を読み込む）
  useEffect(() => {
    if (!file) return;
    let canceled = false;
    probeSubtitleSource(file).then(
      (result) => {
        if (!canceled) setProbe({ file, result, error: null });
      },
      (e: unknown) => {
        if (!canceled) setProbe({ file, result: null, error: e instanceof Error ? e.message : "動画を読み込めませんでした。" });
      }
    );
    return () => {
      canceled = true;
    };
  }, [file]);

  // 再生中は、画面の書き換えに合わせて現在の時間を読み、字幕の表示を動画とそろえる（フェードもなめらかに見える）
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      setCurrentTime(video.currentTime);
      if (!video.paused && !video.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onUpdate = () => setCurrentTime(video.currentTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("seeked", onUpdate);
    video.addEventListener("timeupdate", onUpdate);
    video.addEventListener("pause", onUpdate);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("seeked", onUpdate);
      video.removeEventListener("timeupdate", onUpdate);
      video.removeEventListener("pause", onUpdate);
    };
  }, [previewUrl, previewReady]);

  // プレビューの字幕：書き出し（焼き付け）と同じ描画関数で、動画の表示サイズのキャンバスに描く
  useEffect(() => {
    const c = overlayRef.current;
    if (!c || !meta || meta.width <= 0 || meta.height <= 0) return;
    if (c.width !== meta.width) c.width = meta.width;
    if (c.height !== meta.height) c.height = meta.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    drawSubtitles(ctx, c.width, c.height, shown, currentTime, background);
  }, [shown, currentTime, background, meta]);

  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  function clearResults() {
    setResult(null);
    setBurnResult(null);
  }

  function resetRun() {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    clearResults();
    setStatus("idle");
    setError(null);
    setAudioLoss(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
  }

  function handleSelect(files: File[]) {
    resetRun();
    setFile(files[0]);
    setCurrentTime(0);
  }

  function handleRemove() {
    resetRun();
    setFile(null);
    setCurrentTime(0);
  }

  // 字幕を変えたら、前の結果は捨てる（違う字幕の結果をダウンロードさせない）
  function changeCues(next: SubtitleCue[]) {
    setCues(next);
    if (result || burnResult) {
      clearResults();
      setStatus("idle");
    }
  }

  function updateCue(id: string, patch: Partial<SubtitleCue>) {
    changeCues(cues.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  /** 字幕1件の見た目だけを変える（ほかの字幕には影響しない） */
  function updateLook(id: string, patch: Partial<CueLook>) {
    changeCues(cues.map((c) => (c.id === id ? { ...c, look: { ...normalizeLook(c.look), ...patch } } : c)));
  }

  function changeBackground(next: Partial<SubtitleBackground>) {
    setBackground((prev) => ({ ...prev, ...next }));
    if (result || burnResult) {
      clearResults();
      setStatus("idle");
    }
  }

  function addCue() {
    if (cues.length >= SUBTITLE_CUES_MAX) return;
    const lastEnd = cues.reduce((max, c) => Math.max(max, parseSubtitleTime(c.end) ?? 0), 0);
    // 動画を止めた位置があればそこから、なければ最後の字幕の終わりから
    let start = currentTime > 0 ? currentTime : lastEnd;
    if (durationSec !== null && start >= durationSec) start = Math.max(0, durationSec - NEW_CUE_LENGTH_SEC);
    let end = start + NEW_CUE_LENGTH_SEC;
    if (durationSec !== null) end = Math.min(end, durationSec);
    const id = newCueId();
    changeCues([...cues, { id, start: formatSubtitleTime(start), end: formatSubtitleTime(end), text: "", look: { ...DEFAULT_CUE_LOOK } }]);
    setSelectedId(id);
  }

  function duplicateCue(index: number) {
    if (cues.length >= SUBTITLE_CUES_MAX) return;
    const next = [...cues];
    const id = newCueId();
    next.splice(index + 1, 0, { ...cues[index], id, look: { ...normalizeLook(cues[index].look) } });
    changeCues(next);
    setSelectedId(id);
  }

  function moveCue(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= cues.length) return;
    const next = [...cues];
    [next[index], next[to]] = [next[to], next[index]];
    changeCues(next);
  }

  function removeCue(id: string) {
    changeCues(cues.filter((c) => c.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function setCueTimeToCurrent(id: string, field: "start" | "end") {
    updateCue(id, { [field]: formatSubtitleTime(videoRef.current?.currentTime ?? currentTime) });
  }

  function seekTo(sec: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = sec;
    setCurrentTime(sec);
  }

  function validateBeforeExport(): boolean {
    setShowProblems(true);
    setError(null);
    setAudioLoss(null);
    if (cues.length === 0) {
      setError("字幕が1件も登録されていません。「字幕を追加」から字幕を入力してください。");
      return false;
    }
    if (check.errors.length > 0) {
      setError("字幕の入力に直すところがあります。赤字の案内を確認してください。");
      return false;
    }
    return true;
  }

  async function handleRun(options: { dropAudio?: boolean } = {}) {
    if (!file || !validateBeforeExport()) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    clearResults();
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    try {
      if (mode === "burn") {
        const output = await new VideoSubtitleBurnProcessor().process({
          file,
          cues: check.resolved,
          background,
          container: burnContainer,
          onProgress: setProgress,
          cancelSignal: controller.signal,
          dropAudio: options.dropAudio,
        });
        if (runIdRef.current !== runId) return;
        setBurnResult(output);
      } else {
        const output = await new VideoSubtitleProcessor().process({
          file,
          cues: check.resolved,
          background,
          language,
          container,
          onProgress: setProgress,
          cancelSignal: controller.signal,
        });
        if (runIdRef.current !== runId) return;
        setResult(output);
      }
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else if (e instanceof VideoAudioWouldBeLostError && mode === "burn") {
        setAudioLoss(e.message);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "字幕の追加に失敗しました");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        cancelControllerRef.current = null;
      }
    }
  }

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  function handleDownload() {
    if (!file) return;
    if (burnResult) {
      const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === burnResult.container)?.ext ?? "mp4";
      downloadBlob(burnResult.blob, `${stripExtension(file.name)}-subtitled.${ext}`);
      return;
    }
    if (!result) return;
    const ext = SUBTITLE_CONTAINER_OPTIONS.find((o) => o.value === result.container)?.ext ?? "mkv";
    downloadBlob(result.blob, `${stripExtension(file.name)}-subtitled.${ext}`);
  }

  function downloadSubtitleFile(kind: "vtt" | "srt") {
    if (!validateBeforeExport()) return;
    const text = kind === "vtt" ? buildWebVtt(check.resolved, background) : buildSrt(check.resolved);
    const base = file ? stripExtension(file.name) : "subtitles";
    downloadBlob(new Blob([text], { type: kind === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8" }), `${base}.${kind}`);
  }

  const problemsById = new Map<string, Set<string>>();
  for (const p of check.errors) {
    if (!problemsById.has(p.id)) problemsById.set(p.id, new Set());
    problemsById.get(p.id)!.add(p.field);
  }
  const busy = status === "processing";
  const ready = !!file && !!probeState?.result;

  const timelineRows = cues.flatMap((c, i) => {
    const s = parseSubtitleTime(c.start);
    const e = parseSubtitleTime(c.end);
    if (s === null || e === null || e <= s) return [];
    return [{ id: c.id, label: String(i + 1), start: s, end: e, text: c.text || "（未入力）", selected: c.id === selectedId }];
  });

  // プレビュー（動画・字幕の重ね表示・タイムライン）。PCでは右に固定し、スマホでは上に固定して、字幕を入力しながら見られるようにする
  const previewNode =
    file && previewUrl && probeState?.result ? (
        <section
        data-testid="tool-preview"
        aria-label="字幕のプレビュー"
        // 動画の高さ：PCは画面の5割まで、スマホは上に固定したプレビューにタイムラインも収まるよう、画面の2割5分まで
        className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 [--vs-video-h:25vh] lg:[--vs-video-h:50vh] dark:border-neutral-800"
      >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（再生しながら字幕を編集できます）</p>
          <div
            className="relative mx-auto w-full overflow-hidden rounded-lg bg-black"
            style={{ maxWidth: meta && meta.width > 0 && meta.height > 0 ? `calc(min(var(--vs-video-h), 28rem) * ${meta.width / meta.height})` : undefined }}
          >
            <video
              ref={videoRef}
              data-testid="vs-video"
              src={previewUrl}
              onLoadedMetadata={handleLoadedMetadata}
              controls
              playsInline
              preload="metadata"
              className="block h-auto max-h-[min(var(--vs-video-h),28rem)] w-full"
            />
            {/* 動画の上に重ねる字幕（書き出しと同じ描画）。操作バーの上でも邪魔にならないよう、クリックは下の動画に通す */}
            <canvas ref={overlayRef} aria-hidden="true" data-testid="vs-overlay-canvas" className="pointer-events-none absolute inset-0 h-full w-full" style={{ height: "calc(100% - 0px)" }} />
          </div>
          {/* いま表示している字幕（読み上げ・確認用） */}
          <ul className="sr-only" data-testid="vs-overlay" aria-live="polite">
            {active.map((cue) => (
              <li key={cue.id} data-testid="vs-overlay-cue" data-x={cue.look.x} data-y={cue.look.y} data-size={cue.look.size} data-color={cue.look.color} data-font={cue.look.font}>
                {cue.text}
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            現在の時間：<span data-testid="vs-current-time" className="font-mono">{formatSubtitleTime(currentTime)}</span>
            {durationSec !== null && (
              <>
                {" "}／ 動画の長さ：<span className="font-mono">{formatSubtitleTime(durationSec)}</span>
              </>
            )}
          </p>
          {durationSec !== null && durationSec > 0 && (
            <VideoTimeline
              testId="vs-timeline"
              rowTestId="vs-timeline-row"
              duration={durationSec}
              currentTime={currentTime}
              onSeek={seekTo}
              rows={timelineRows}
              onSelect={setSelectedId}
              onChange={(id, s, e) => updateCue(id, { start: formatSubtitleTime(s), end: formatSubtitleTime(e) })}
              emptyText="字幕を追加すると、ここに字幕ごとのバーが出ます。バーの端をドラッグして表示時間を変えられます。"
            />
          )}
        </section>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        字幕ごとにフォント・大きさ・色・縁取り・位置・フェードを決め、タイムラインで表示時間を調整できます。見た目どおりに映像へ焼き付けるか、ON・OFFできる字幕トラック（MKV・WebM）として入れるかを選べます。字幕ファイル（.srt・.vtt）も保存できます。
      </p>

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
      {probing && <p className="text-sm text-neutral-500 dark:text-neutral-400">動画の情報を調べています…</p>}
      {probeState?.error && <ErrorMessage message={probeState.error} />}

      {ready && previewNode && (
        <PreviewSplitLayout previewWidth="lg" mobileSticky preview={previewNode}>
          {ready && (
            <section aria-label="字幕の一覧" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-bold text-neutral-800 dark:text-neutral-100">字幕（{cues.length}件）</h2>
                <button type="button" data-testid="vs-add" onClick={addCue} disabled={cues.length >= SUBTITLE_CUES_MAX} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  ＋ 字幕を追加
                </button>
                <button type="button" data-testid="vs-sort" onClick={() => changeCues(sortCuesByTime(cues))} disabled={cues.length < 2} className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200">
                  時間順に並べ替え
                </button>
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                表示時間は、タイムラインのバーをドラッグするか、「時:分:秒.ミリ秒」（例：00:00:01.500）で入れられます。動画を止めて「今の時間」でも入れられます。
              </p>

              {cues.length === 0 ? (
                <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  まだ字幕がありません。「字幕を追加」を押して入力してください。
                </p>
              ) : (
                <ol className="flex flex-col gap-3" data-testid="vs-cues">
                  {cues.map((cue, i) => {
                    const bad = problemsById.get(cue.id);
                    const showBad = (field: string) => showProblems && bad?.has(field);
                    const startSec = parseSubtitleTime(cue.start);
                    const endSec = parseSubtitleTime(cue.end);
                    const cueDur = startSec !== null && endSec !== null && endSec > startSec ? endSec - startSec : SUBTITLE_FADE_MAX;
                    const look = normalizeLook(cue.look);
                    const fadeMax = Math.max(0.1, Math.min(SUBTITLE_FADE_MAX, Math.floor(cueDur * 10) / 10));
                    const selected = cue.id === selectedId;
                    return (
                      <li
                        key={cue.id}
                        data-testid="vs-cue"
                        data-selected={selected || undefined}
                        onFocusCapture={() => setSelectedId(cue.id)}
                        onPointerDown={() => setSelectedId(cue.id)}
                        className={`flex flex-col gap-2 rounded-xl border p-3 ${selected ? "border-blue-400 ring-1 ring-blue-300 dark:border-blue-600" : "border-neutral-200 dark:border-neutral-800"}`}
                      >
                        <div className="flex flex-wrap items-end gap-2">
                          <span className="w-8 text-sm font-semibold text-neutral-500">{i + 1}</span>
                          <label className="flex flex-col text-xs text-neutral-600 dark:text-neutral-300">
                            開始時間
                            <input
                              type="text"
                              inputMode="decimal"
                              data-testid="vs-cue-start"
                              value={cue.start}
                              onChange={(e) => updateCue(cue.id, { start: e.target.value })}
                              aria-invalid={showBad("start") || undefined}
                              className={`ms-focus-ring w-36 rounded-md border px-2 py-1 font-mono text-sm dark:bg-neutral-900 ${showBad("start") ? "border-red-500" : "border-neutral-300 dark:border-neutral-700"}`}
                            />
                          </label>
                          <button type="button" onClick={() => setCueTimeToCurrent(cue.id, "start")} className="rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">今の時間</button>
                          <label className="flex flex-col text-xs text-neutral-600 dark:text-neutral-300">
                            終了時間
                            <input
                              type="text"
                              inputMode="decimal"
                              data-testid="vs-cue-end"
                              value={cue.end}
                              onChange={(e) => updateCue(cue.id, { end: e.target.value })}
                              aria-invalid={showBad("end") || undefined}
                              className={`ms-focus-ring w-36 rounded-md border px-2 py-1 font-mono text-sm dark:bg-neutral-900 ${showBad("end") ? "border-red-500" : "border-neutral-300 dark:border-neutral-700"}`}
                            />
                          </label>
                          <button type="button" onClick={() => setCueTimeToCurrent(cue.id, "end")} className="rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">今の時間</button>
                          {startSec !== null && (
                            <button type="button" data-testid="vs-cue-seek" onClick={() => seekTo(startSec)} className="rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">この字幕へ移動</button>
                          )}
                        </div>
                        <label className="flex flex-col text-xs text-neutral-600 dark:text-neutral-300">
                          字幕
                          <textarea
                            data-testid="vs-cue-text"
                            value={cue.text}
                            maxLength={SUBTITLE_TEXT_MAX}
                            rows={2}
                            onChange={(e) => updateCue(cue.id, { text: e.target.value })}
                            aria-invalid={showBad("text") || undefined}
                            placeholder="例）こんにちは"
                            className={`ms-focus-ring rounded-md border px-2 py-1 text-base dark:bg-neutral-900 ${showBad("text") ? "border-red-500" : "border-neutral-300 dark:border-neutral-700"}`}
                          />
                        </label>

                        <SettingsSection
                          title={`${i + 1}番目の見た目`}
                          summary={`${SUBTITLE_FONT_OPTIONS.find((f) => f.value === look.font)?.label}・${look.size}%・${look.outline ? "縁取りあり" : "縁取りなし"}${look.fadeIn || look.fadeOut ? "・フェード" : ""}`}
                          defaultOpen={false}
                          testId="vs-cue-look"
                        >
                          <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
                            フォント
                            <select
                              data-testid="vs-cue-font"
                              value={look.font}
                              onChange={(e) => updateLook(cue.id, { font: e.target.value as CueLook["font"] })}
                              className="w-fit rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                            >
                              {SUBTITLE_FONT_OPTIONS.map((f) => (
                                <option key={f.value} value={f.value}>
                                  {f.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <SliderField
                            label="文字の大きさ"
                            ariaLabel={`${i + 1}番目の文字の大きさ`}
                            value={look.size}
                            min={SUBTITLE_SIZE_MIN}
                            max={SUBTITLE_SIZE_MAX}
                            step={0.5}
                            unit="%"
                            onChange={(v) => updateLook(cue.id, { size: v })}
                            hint="動画の高さに対する文字の高さです。"
                          />
                          <TextColorField label="文字の色" value={look.color} onChange={(c) => updateLook(cue.id, { color: c })} testId="vs-cue-color" />
                          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                            <input type="checkbox" data-testid="vs-cue-outline" checked={look.outline} onChange={(e) => updateLook(cue.id, { outline: e.target.checked })} />
                            縁取りを付ける
                          </label>
                          {look.outline && (
                            <TextColorField label="縁取りの色" value={look.outlineColor} onChange={(c) => updateLook(cue.id, { outlineColor: c })} testId="vs-cue-outline-color" />
                          )}
                          <PositionSliders
                            testId="vs-cue-xy"
                            x={look.x}
                            y={look.y}
                            xAriaLabel={`${i + 1}番目の横の位置（X）`}
                            yAriaLabel={`${i + 1}番目の縦の位置（Y）`}
                            onChange={(p) => updateLook(cue.id, p)}
                            hint="文字のまとまりの中心の位置です（0%＝左端・上端、100%＝右端・下端）。"
                          />
                          <SliderField
                            label="フェードイン"
                            ariaLabel={`${i + 1}番目のフェードイン`}
                            value={Math.min(look.fadeIn, fadeMax)}
                            min={0}
                            max={fadeMax}
                            step={0.1}
                            unit="秒"
                            onChange={(v) => updateLook(cue.id, { fadeIn: v })}
                          />
                          <SliderField
                            label="フェードアウト"
                            ariaLabel={`${i + 1}番目のフェードアウト`}
                            value={Math.min(look.fadeOut, fadeMax)}
                            min={0}
                            max={fadeMax}
                            step={0.1}
                            unit="秒"
                            onChange={(v) => updateLook(cue.id, { fadeOut: v })}
                            hint="透明から徐々に表示し、徐々に透明にして消します。合計が表示時間より長いときは、表示時間に収まるよう短くします。"
                          />
                        </SettingsSection>

                        <div className="flex flex-wrap gap-2 text-xs">
                          <button type="button" data-testid="vs-cue-up" aria-label={`${i + 1}番目の字幕を上へ`} onClick={() => moveCue(i, -1)} disabled={i === 0} className="rounded bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800">↑ 上へ</button>
                          <button type="button" data-testid="vs-cue-down" aria-label={`${i + 1}番目の字幕を下へ`} onClick={() => moveCue(i, 1)} disabled={i === cues.length - 1} className="rounded bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800">↓ 下へ</button>
                          <button type="button" data-testid="vs-cue-duplicate" onClick={() => duplicateCue(i)} className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">複製</button>
                          <button type="button" data-testid="vs-cue-delete" onClick={() => removeCue(cue.id)} className="rounded bg-red-50 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">削除</button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {check.overlaps.length > 0 && (
                <p data-testid="vs-overlap-warning" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                  表示時間が重なっている字幕があります（{check.overlaps.map((o) => `${o.a}番目と${o.b}番目`).join("、")}）。重なった時間は、字幕が同時に表示されます。意図したものであれば、このまま書き出せます。
                </p>
              )}
              {check.outOfOrder && (
                <p data-testid="vs-order-note" className="text-xs text-neutral-600 dark:text-neutral-300">
                  一覧が時間順になっていません。書き出すときは、開始時間の順に並べて保存します（「時間順に並べ替え」で一覧もそろえられます）。
                </p>
              )}
              {showProblems && check.errors.length > 0 && (
                <ul data-testid="vs-errors" role="alert" className="flex flex-col gap-1 text-xs text-red-700 dark:text-red-400">
                  {check.errors.map((p, k) => (
                    <li key={`${p.id}-${p.field}-${k}`}>{p.message}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {ready && (
            <SettingsStack>
              <SettingsSection title="字幕の背景（すべての字幕に共通）" summary={background.opacity > 0 ? `${background.color}・${background.opacity}%` : "なし"} defaultOpen={false} testId="vs-background">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    背景色
                    <input type="color" data-testid="vs-bg-color" value={background.color} onChange={(e) => changeBackground({ color: e.target.value })} className="h-8 w-12" />
                  </label>
                  <label className="flex items-center gap-2">
                    背景の濃さ
                    <input type="range" min={0} max={100} step={5} data-testid="vs-bg-opacity" value={background.opacity} onChange={(e) => changeBackground({ opacity: Number(e.target.value) })} />
                    <span className="w-10 text-xs">{background.opacity}%</span>
                  </label>
                </div>
              </SettingsSection>

              <SettingsSection title="書き出し" testId="vs-output">
                <Segmented ariaLabel="書き出し方" size="sm" testId="vs-mode" value={mode} onChange={(v) => setMode(v)} options={OUTPUT_MODE_OPTIONS} />
                {mode === "burn" ? (
                  <>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      プレビューの見た目（フォント・縁取り・位置・フェード）のまま、字幕を映像に描き込みます。どの再生アプリ・SNSでも表示されます（字幕のON・OFFはできません）。映像は作り直すため、時間がかかります。
                    </p>
                    <fieldset className="flex flex-wrap items-center gap-3 text-sm">
                      <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">出力形式</legend>
                      {OUTPUT_CONTAINER_OPTIONS.map((o) => (
                        <label key={o.value} className="flex items-center gap-1">
                          <input type="radio" name="vs-burn-container" data-testid={`vs-burn-container-${o.value}`} checked={burnContainer === o.value} onChange={() => setBurnContainer(o.value)} />
                          {o.label}
                        </label>
                      ))}
                    </fieldset>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      映像・音声は作り直さずにそのまま使い、ON・OFFできる字幕トラックとして入れます（VLCなどで表示。ブラウザ・SNSでは表示されません）。文字色・大きさ・位置・背景は字幕トラックに書きますが、フォント・縁取り・フェードは表せません。
                    </p>
                    <fieldset className="flex flex-wrap items-center gap-3 text-sm">
                      <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">出力形式</legend>
                      {SUBTITLE_CONTAINER_OPTIONS.filter((o) => containers.includes(o.value)).map((o) => (
                        <label key={o.value} className="flex items-center gap-1">
                          <input type="radio" name="vs-container" data-testid={`vs-container-${o.value}`} checked={container === o.value} onChange={() => setContainer(o.value)} />
                          {o.label}
                        </label>
                      ))}
                      {!containers.includes("webm") && <span className="text-xs text-neutral-500 dark:text-neutral-400">WebM は、元の動画が WebM のときに選べます。</span>}
                    </fieldset>
                    <div className="flex items-center gap-2 text-sm">
                      <span aria-hidden="true">字幕の言語</span>
                      <Segmented
                        ariaLabel="字幕の言語"
                        size="sm"
                        testId="vs-language"
                        value={language}
                        onChange={(v) => setLanguage(v)}
                        options={SUBTITLE_LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      />
                    </div>
                  </>
                )}
              </SettingsSection>
            </SettingsStack>
          )}

          {ready && (
            <section aria-label="書き出しの実行" className="flex flex-col gap-2">
              <RunBar>
                <button type="button" data-testid="vs-run" onClick={() => handleRun()} disabled={busy} aria-busy={busy || undefined} className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50">
                  字幕つきの動画を書き出す
                </button>
                <button type="button" data-testid="vs-save-srt" onClick={() => downloadSubtitleFile("srt")} disabled={busy} className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200">
                  字幕ファイル（.srt）を保存
                </button>
                <button type="button" data-testid="vs-save-vtt" onClick={() => downloadSubtitleFile("vtt")} disabled={busy} className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200">
                  字幕ファイル（.vtt）を保存
                </button>
              </RunBar>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">.srt は YouTube などに字幕としてアップロードできます（時間と文字だけ）。</p>
            </section>
          )}
        </PreviewSplitLayout>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`${mode === "burn" ? "字幕を焼き付けています" : "字幕を追加しています"}… ${Math.round(progress * 100)}%`}
        successLabel="字幕の追加が完了しました"
        onCancel={handleCancel}
        canceling={canceling}
        cancelTestId="vs-cancel"
      />
      {wasCanceled && (
        <div data-testid="vs-canceled" className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}
      {audioLoss && <VideoAudioLossNotice message={audioLoss} onProceed={() => handleRun({ dropAudio: true })} onDismiss={() => setAudioLoss(null)} />}

      {burnResult && (
        <ResultPopup>
          <VideoOutputPlayer url={burnResult.url} />
          <div data-testid="vs-result" className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
            <p>
              形式：{OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === burnResult.container)?.label}（字幕を焼き付け）・字幕 {burnResult.cueCount}件・{burnResult.width}×{burnResult.height}・{formatBytes(burnResult.sizeBytes)}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">字幕は映像の一部として描き込まれているため、どの再生アプリでも表示されます。</p>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </ResultPopup>
      )}

      {result && (
        <ResultPopup>
          <div data-testid="vs-result" className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
            <p>
              形式：{SUBTITLE_CONTAINER_OPTIONS.find((o) => o.value === result.container)?.label}・字幕 {result.cueCount}件・{formatBytes(result.sizeBytes)}
            </p>
            <p data-testid="vs-result-copy" className="text-xs text-neutral-500 dark:text-neutral-400">
              映像：{result.videoCopied ? "そのまま（再エンコードなし）" : "作り直しました"}
              {result.audioCopied !== null && `・音声：${result.audioCopied ? "そのまま（再エンコードなし）" : "作り直しました"}`}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">字幕はVLCなどの再生アプリで表示され、ON・OFFを切り替えられます。ブラウザでの再生では表示されません。</p>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
