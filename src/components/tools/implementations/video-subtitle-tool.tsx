"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  SUBTITLE_CONTAINER_OPTIONS,
  VideoSubtitleProcessor,
  probeSubtitleSource,
  type SubtitleContainer,
  type SubtitleSourceProbe,
  type VideoSubtitleOutput,
} from "@/lib/processors/browser/video-subtitle";
import { VIDEO_INPUT_ACCEPT, VIDEO_DROPZONE_MAX_MB, VideoCanceledByUserError } from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import {
  DEFAULT_SUBTITLE_STYLE,
  SUBTITLE_CUES_MAX,
  SUBTITLE_FONT_SIZE_OPTIONS,
  SUBTITLE_LANGUAGE_OPTIONS,
  SUBTITLE_POSITION_OPTIONS,
  SUBTITLE_TEXT_MAX,
  activeCuesAt,
  buildSrt,
  buildWebVtt,
  checkCues,
  fontSizePercent,
  formatSubtitleTime,
  hexToRgba,
  newCueId,
  parseSubtitleTime,
  previewCues,
  sortCuesByTime,
  type SubtitleCue,
  type SubtitleLanguage,
  type SubtitleStyle,
} from "@/lib/video/subtitles";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";

/** 新しく足す字幕の長さ（秒） */
const NEW_CUE_LENGTH_SEC = 2;

/**
 * 動画字幕追加。
 *
 * 動画を選び、字幕と表示時間を手入力して、字幕を「動画とは別の字幕トラック」として入れた動画（MKV・WebM）を書き出す。
 * 字幕は映像に焼き付けない。動画はサーバーへ送らず、ブラウザの中だけで処理する。
 * ブラウザ・動画投稿サイト・SNS は動画の中の字幕トラックを表示しないため、字幕だけのファイル（.vtt・.srt）も保存できる。
 */
export function VideoSubtitleTool() {
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<{ file: File; result: SubtitleSourceProbe | null; error: string | null } | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);
  const [language, setLanguage] = useState<SubtitleLanguage>("jpn");
  const [rawContainer, setContainer] = useState<SubtitleContainer>("mkv");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [result, setResult] = useState<VideoSubtitleOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const cancelControllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useRevokeObjectUrlOnChange(result?.url);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);

  const probeState = file && probe?.file === file ? probe : null;
  const probing = file !== null && probeState === null;
  const durationSec = probeState?.result?.durationSec ?? (meta && meta.durationSec > 0 ? meta.durationSec : null);
  const containers = probeState?.result?.containers ?? ["mkv"];
  const container: SubtitleContainer = containers.includes(rawContainer) ? rawContainer : containers[0];

  // プレビューの動画を出してよいか（動画を調べ終えてから出す）
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

  // 再生中は、画面の書き換えに合わせて現在の時間を読み、字幕の表示を動画とそろえる
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

  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  function resetRun() {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setResult(null);
    setStatus("idle");
    setError(null);
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
    if (result) {
      setResult(null);
      setStatus("idle");
    }
  }

  function changeStyle(next: Partial<SubtitleStyle>) {
    setStyle((prev) => ({ ...prev, ...next }));
    if (result) {
      setResult(null);
      setStatus("idle");
    }
  }

  function updateCue(id: string, patch: Partial<SubtitleCue>) {
    changeCues(cues.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function addCue() {
    if (cues.length >= SUBTITLE_CUES_MAX) return;
    const lastEnd = cues.reduce((max, c) => Math.max(max, parseSubtitleTime(c.end) ?? 0), 0);
    // 動画を止めた位置があればそこから、なければ最後の字幕の終わりから
    let start = currentTime > 0 ? currentTime : lastEnd;
    if (durationSec !== null && start >= durationSec) start = Math.max(0, durationSec - NEW_CUE_LENGTH_SEC);
    let end = start + NEW_CUE_LENGTH_SEC;
    if (durationSec !== null) end = Math.min(end, durationSec);
    changeCues([...cues, { id: newCueId(), start: formatSubtitleTime(start), end: formatSubtitleTime(end), text: "" }]);
  }

  function duplicateCue(index: number) {
    if (cues.length >= SUBTITLE_CUES_MAX) return;
    const next = [...cues];
    next.splice(index + 1, 0, { ...cues[index], id: newCueId() });
    changeCues(next);
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

  async function handleRun() {
    if (!file) return;
    setShowProblems(true);
    setError(null);
    if (cues.length === 0) {
      setError("字幕が1件も登録されていません。「字幕を追加」から字幕を入力してください。");
      return;
    }
    if (check.errors.length > 0) {
      setError("字幕の入力に直すところがあります。赤字の案内を確認してください。");
      return;
    }
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    try {
      const output = await new VideoSubtitleProcessor().process({
        file,
        cues: check.resolved,
        style,
        language,
        container,
        onProgress: setProgress,
        cancelSignal: controller.signal,
      });
      if (runIdRef.current !== runId) return;
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
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
    if (!file || !result) return;
    const ext = SUBTITLE_CONTAINER_OPTIONS.find((o) => o.value === result.container)?.ext ?? "mkv";
    downloadBlob(result.blob, `${stripExtension(file.name)}-subtitled.${ext}`);
  }

  function downloadSubtitleFile(kind: "vtt" | "srt") {
    setShowProblems(true);
    if (cues.length === 0 || check.errors.length > 0) {
      setError(cues.length === 0 ? "字幕が1件も登録されていません。" : "字幕の入力に直すところがあります。赤字の案内を確認してください。");
      return;
    }
    setError(null);
    const text = kind === "vtt" ? buildWebVtt(check.resolved, style) : buildSrt(check.resolved);
    const base = file ? stripExtension(file.name) : "subtitles";
    downloadBlob(new Blob([text], { type: kind === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8" }), `${base}.${kind}`);
  }

  const problemsById = new Map<string, Set<string>>();
  for (const p of check.errors) {
    if (!problemsById.has(p.id)) problemsById.set(p.id, new Set());
    problemsById.get(p.id)!.add(p.field);
  }
  const busy = status === "processing";
  const overlayAlign = style.position === "top" ? "items-start pt-[4%]" : style.position === "middle" ? "items-center" : "items-end pb-[6%]";

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        字幕は映像に焼き付けず、ON・OFFを切り替えられる字幕トラックとして追加します（MKV・WebM）。VLCなどの再生アプリで表示できます。ブラウザでの再生や、YouTube・SNSへの投稿では動画の中の字幕は表示されないため、字幕ファイル（.srt・.vtt）も保存できます。
      </p>

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
      {probing && <p className="text-sm text-neutral-500 dark:text-neutral-400">動画の情報を調べています…</p>}
      {probeState?.error && <ErrorMessage message={probeState.error} />}

      {file && previewUrl && probeState?.result && (
        <PreviewFullscreenFrame>
        <section data-testid="tool-preview" aria-label="字幕のプレビュー" className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（字幕の表示時間・位置・大きさの確認）</p>
          <div className="relative w-full overflow-hidden rounded-lg bg-black" style={{ containerType: "inline-size" }}>
            <video
              ref={videoRef}
              data-testid="vs-video"
              src={previewUrl}
              onLoadedMetadata={handleLoadedMetadata}
              controls
              playsInline
              preload="metadata"
              className="max-h-80 w-full"
            />
            <div className={`pointer-events-none absolute inset-x-0 top-0 bottom-10 flex justify-center px-[4%] ${overlayAlign}`} aria-hidden="true">
              {active.length > 0 && (
                <div data-testid="vs-overlay" data-position={style.position} data-font-size={fontSizePercent(style.fontSize)} className="flex max-w-full flex-col items-center gap-1 text-center">
                  {active.map((cue) => (
                    <span
                      key={cue.id}
                      data-testid="vs-overlay-cue"
                      className="whitespace-pre-line rounded px-2 py-0.5 leading-snug"
                      style={{
                        color: style.color,
                        backgroundColor: hexToRgba(style.backgroundColor, style.backgroundOpacity),
                        fontSize: `calc(${fontSizePercent(style.fontSize) / 100} * clamp(12px, 4.5cqw, 40px))`,
                      }}
                    >
                      {cue.text}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            現在の時間：<span data-testid="vs-current-time" className="font-mono">{formatSubtitleTime(currentTime)}</span>
            {durationSec !== null && <> ／ 動画の長さ：<span className="font-mono">{formatSubtitleTime(durationSec)}</span></>}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            プレビューの字幕は確認用の表示です。実際の見た目（文字の形・大きさ）は、再生アプリによって少し変わります。
          </p>
        </section>
        </PreviewFullscreenFrame>
      )}

      {file && probeState?.result && (
        <section aria-label="字幕の一覧" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">字幕（{cues.length}件）</h2>
            <button type="button" data-testid="vs-add" onClick={addCue} disabled={cues.length >= SUBTITLE_CUES_MAX} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              ＋ 字幕を追加
            </button>
            <button type="button" data-testid="vs-sort" onClick={() => changeCues(sortCuesByTime(cues))} disabled={cues.length < 2} className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200">
              時間順に並べ替え
            </button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            時間は「時:分:秒.ミリ秒」（例：00:00:01.500）で入力します。動画を止めて「今の時間」を押すと、その位置の時間が入ります。
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
                return (
                  <li key={cue.id} data-testid="vs-cue" className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
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

      {file && probeState?.result && (
        <section aria-label="字幕の表示設定" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <h2 className="font-semibold text-neutral-800 dark:text-neutral-100">字幕の表示設定</h2>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">表示位置</legend>
            {SUBTITLE_POSITION_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-center gap-1">
                <input type="radio" name="vs-position" data-testid={`vs-position-${o.value}`} checked={style.position === o.value} onChange={() => changeStyle({ position: o.value })} />
                {o.label}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">文字サイズ</legend>
            {SUBTITLE_FONT_SIZE_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-center gap-1">
                <input type="radio" name="vs-font-size" data-testid={`vs-size-${o.value}`} checked={style.fontSize === o.value} onChange={() => changeStyle({ fontSize: o.value })} />
                {o.label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              文字色
              <input type="color" data-testid="vs-color" value={style.color} onChange={(e) => changeStyle({ color: e.target.value })} className="h-8 w-12" />
            </label>
            <label className="flex items-center gap-2">
              背景色
              <input type="color" data-testid="vs-bg-color" value={style.backgroundColor} onChange={(e) => changeStyle({ backgroundColor: e.target.value })} className="h-8 w-12" />
            </label>
            <label className="flex items-center gap-2">
              背景の濃さ
              <input type="range" min={0} max={100} step={5} data-testid="vs-bg-opacity" value={style.backgroundOpacity} onChange={(e) => changeStyle({ backgroundOpacity: Number(e.target.value) })} />
              <span className="w-10 text-xs">{style.backgroundOpacity}%</span>
            </label>
          </div>
          <label className="flex items-center gap-2">
            字幕の言語
            <select data-testid="vs-language" value={language} onChange={(e) => setLanguage(e.target.value as SubtitleLanguage)} className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              {SUBTITLE_LANGUAGE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            表示設定は、字幕トラックとWebVTT（.vtt）に保存されます（VLCで反映を確認しています）。再生アプリによっては、色・大きさ・位置が反映されないことがあります。SRT（.srt）には時間と文字だけが入ります。
          </p>
        </section>
      )}

      {file && probeState?.result && (
        <section aria-label="書き出し" className="flex flex-col gap-3">
          <fieldset className="flex flex-wrap items-center gap-3 text-sm">
            <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">出力形式</legend>
            {SUBTITLE_CONTAINER_OPTIONS.filter((o) => containers.includes(o.value)).map((o) => (
              <label key={o.value} className="flex items-center gap-1">
                <input type="radio" name="vs-container" data-testid={`vs-container-${o.value}`} checked={container === o.value} onChange={() => setContainer(o.value)} />
                {o.label}
              </label>
            ))}
            {!containers.includes("webm") && (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">WebM は、元の動画が WebM のときに選べます。</span>
            )}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" data-testid="vs-run" onClick={handleRun} disabled={busy} aria-busy={busy || undefined} className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50">
              字幕つきの動画を書き出す
            </button>
            <button type="button" data-testid="vs-save-srt" onClick={() => downloadSubtitleFile("srt")} disabled={busy} className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200">
              字幕ファイル（.srt）を保存
            </button>
            <button type="button" data-testid="vs-save-vtt" onClick={() => downloadSubtitleFile("vtt")} disabled={busy} className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200">
              字幕ファイル（.vtt）を保存
            </button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            映像・音声は作り直さずにそのまま使うため、画質・音質は変わりません。.srt は YouTube などに字幕としてアップロードできます。
          </p>
        </section>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`字幕を追加しています… ${Math.round(progress * 100)}%`}
        successLabel="字幕の追加が完了しました"
        onCancel={handleCancel}
        canceling={canceling}
        cancelTestId="vs-cancel"
      />
      {wasCanceled && (
        <div data-testid="vs-canceled" className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}

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
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              字幕はVLCなどの再生アプリで表示され、ON・OFFを切り替えられます。ブラウザでの再生では表示されません。
            </p>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
