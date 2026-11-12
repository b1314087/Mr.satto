"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { ResultPopup } from "@/components/common/result-popup";
import { VideoTimeline } from "@/components/common/video-timeline";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { VideoOutputPlayer } from "@/components/tools/implementations/shared/video-preview-panel";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { StepHeading } from "@/components/ui/step-heading";
import { VideoCutMergeProcessor, validateClips, MAX_CLIPS, MIN_CLIP_SEC, type VideoCutMergeOutput } from "@/lib/processors/browser/video-cut-merge";
import { OUTPUT_CONTAINER_OPTIONS, VIDEO_DROPZONE_MAX_MB, VIDEO_INPUT_ACCEPT, VideoCanceledByUserError, inspectVideoFile, type OutputContainer } from "@/lib/video/shared";
import { formatTimeInput } from "@/lib/video/edit-settings";
import { formatDuration } from "@/lib/video/estimate";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { useAnnounceToolMode } from "@/lib/guides/tool-mode";
import { moveItem, useDragReorder } from "@/lib/hooks/use-drag-reorder";
import { removeRangeFromSegments, type CutSegment as Segment } from "@/lib/video/cut-segments";

type Mode = "cut" | "merge";


interface MergeItem {
  id: number;
  file: File;
  url: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  error: string | null;
  /** 残す範囲（秒）。読み込みが終わると、最初から最後まで */
  start: number;
  end: number;
}

const MAX_MERGE_FILES = 20;
const round = (t: number) => Math.round(t * 1000) / 1000;

/**
 * 動画カット・結合（次期機能追加 3／総合改修 30 でタイムライン操作に変更）。
 * - 「不要部分を削除」：タイムラインで不要な範囲をドラッグして選び、「選んだ範囲を削除」。残った区間（バー）は端をドラッグして調整、
 *   「再生位置で分ける」でも分けられる。残す区間の順番は、つまみのドラッグ（または ↑↓）で変えられる。「つないだ結果を再生」で事前に確かめられる。
 * - 「複数の動画を結合」：動画ごとの区間をタイムラインに並べ、順番はドラッグで変える。動画ごとに不要な最初・最後をバーの端のドラッグで切り取れる。
 * 開始・終了の時間を数字で入れなくても操作できる。処理はすべてブラウザの中。進み具合の表示・キャンセルができる。
 */
export function VideoCutMergeTool({ initialMode = "cut" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  useAnnounceToolMode(mode);
  const [container, setContainer] = useState<OutputContainer>("mp4");

  // ---- 不要部分を削除 ----
  const [file, setFile] = useState<File | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [selectedSeg, setSelectedSeg] = useState<number | null>(null);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(mode === "cut" ? file : null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const nextId = useRef(1);
  const newId = () => nextId.current++;
  const duration = meta?.durationSec ?? 0;
  // つないだ結果の再生（区間の番号。null は止まっている）
  const [seqIndex, setSeqIndex] = useState<number | null>(null);

  // ---- 複数の動画を結合 ----
  const [items, setItems] = useState<MergeItem[]>([]);
  const itemsRef = useRef<MergeItem[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => () => itemsRef.current.forEach((it) => URL.revokeObjectURL(it.url)), []);
  const mergePreviewRef = useRef<HTMLVideoElement>(null);
  const [mergeSeq, setMergeSeq] = useState<number | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoCutMergeOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  useRevokeObjectUrlOnChange(result?.url);

  function resetResult() {
    runIdRef.current++;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
  }

  // 動画の長さが分かったら、最初は「全体を残す」1区間にする
  useEffect(() => {
    if (duration > 0 && segments.length === 0 && file) {
      setSegments([{ id: nextId.current++, start: 0, end: round(duration) }]);
    }
  }, [duration, segments.length, file]);

  // 再生位置を読む（再生中は画面の書き換えごと）。つないだ結果の再生中は、区間の終わりで次の区間へ移る
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      setCurrentTime(v.currentTime);
      if (!v.paused && !v.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onUpdate = () => setCurrentTime(v.currentTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("seeked", onUpdate);
    v.addEventListener("pause", onUpdate);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("seeked", onUpdate);
      v.removeEventListener("pause", onUpdate);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (seqIndex === null) return;
    const v = videoRef.current;
    const seg = segments[seqIndex];
    if (!v || !seg) return;
    if (currentTime >= seg.end - 0.04) {
      const next = seqIndex + 1;
      if (next >= segments.length) {
        v.pause();
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSeqIndex(null);
      } else {
        v.currentTime = segments[next].start;
        setSeqIndex(next);
      }
    }
  }, [currentTime, seqIndex, segments]);

  function seek(t: number) {
    const v = videoRef.current;
    if (!v) return;
    setSeqIndex(null);
    v.currentTime = t;
    setCurrentTime(t);
  }

  function playJoined() {
    const v = videoRef.current;
    if (!v || segments.length === 0) return;
    setSeqIndex(0);
    v.currentTime = segments[0].start;
    v.muted = false;
    void v.play().catch(() => setSeqIndex(null));
  }

  function changeSegments(next: Segment[]) {
    setSegments(next);
    resetResult();
  }

  function deleteSelection() {
    if (!selection || selection.end - selection.start < 0.05) return;
    changeSegments(removeRangeFromSegments(segments, selection, newId));
    setSelection(null);
  }

  function splitAtPlayhead() {
    const t = currentTime;
    const i = segments.findIndex((s) => t - s.start >= MIN_CLIP_SEC && s.end - t >= MIN_CLIP_SEC);
    if (i < 0) return;
    const s = segments[i];
    const next = [...segments];
    next.splice(i, 1, { ...s, end: round(t) }, { id: newId(), start: round(t), end: s.end });
    changeSegments(next);
  }

  const cutReorder = useDragReorder(segments.length, (from, to) => changeSegments(moveItem(segments, from, to)));
  const clipsForCut = useMemo(() => (file ? segments.map((s) => ({ file, start: s.start, end: s.end, durationSec: duration })) : []), [file, segments, duration]);
  const keptSec = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  const splittable = segments.some((s) => currentTime - s.start >= MIN_CLIP_SEC && s.end - currentTime >= MIN_CLIP_SEC);

  // ---- 複数の動画を結合 ----
  async function addMergeFiles(files: File[]) {
    const room = MAX_MERGE_FILES - items.length;
    const picked = files.slice(0, Math.max(0, room));
    if (files.length > picked.length) setError(`結合できる動画は${MAX_MERGE_FILES}本までです。`);
    const added: MergeItem[] = picked.map((f) => ({
      id: nextId.current++,
      file: f,
      url: URL.createObjectURL(f),
      durationSec: null,
      width: null,
      height: null,
      hasAudio: null,
      error: null,
      start: 0,
      end: 0,
    }));
    setItems((prev) => [...prev, ...added]);
    resetResult();
    for (const it of added) {
      try {
        const info = await inspectVideoFile(it.file);
        const patch = { durationSec: info.durationSec, width: info.displayWidth, height: info.displayHeight, hasAudio: info.hasAudio, start: 0, end: round(info.durationSec) };
        info.input.dispose();
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, ...patch } : p)));
      } catch (e) {
        const message = e instanceof Error ? e.message : "動画を読み込めませんでした。";
        setItems((prev) => prev.map((p) => (p.id === it.id ? { ...p, error: message } : p)));
      }
    }
  }
  function moveItemBy(index: number, dir: -1 | 1) {
    setItems((prev) => moveItem(prev, index, index + dir));
    resetResult();
  }
  function removeItem(id: number) {
    setItems((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.id !== id);
    });
    resetResult();
  }
  function trimItem(id: number, start: number, end: number) {
    setItems((prev) => prev.map((p) => (p.id === id ? { ...p, start, end } : p)));
    resetResult();
  }
  const mergeReorder = useDragReorder(items.length, (from, to) => {
    setItems((prev) => moveItem(prev, from, to));
    resetResult();
  });
  const mergeReady = items.length >= 2 && items.every((it) => it.durationSec !== null && !it.error);
  const mergeTotal = items.reduce((sum, it) => sum + Math.max(0, it.end - it.start), 0);
  const mixedSizes =
    items.length >= 2 &&
    items.some((it) => it.width && it.height && items[0].width && items[0].height && Math.abs(it.width / it.height - items[0].width / items[0].height) > 0.01);
  const mergeClips = items.map((it) => ({ file: it.file, start: it.start, end: it.end, durationSec: it.durationSec ?? 0 }));
  const mergeProblem = mergeReady ? validateClips(mergeClips) : null;

  // 結合結果の再生：動画を1本ずつ切り替えて、残す範囲だけを順に再生する
  function playMerged(index = 0) {
    const v = mergePreviewRef.current;
    const it = items[index];
    if (!v || !it) {
      setMergeSeq(null);
      return;
    }
    setMergeSeq(index);
    v.src = it.url;
    const start = () => {
      v.currentTime = it.start;
      void v.play().catch(() => setMergeSeq(null));
    };
    v.addEventListener("loadedmetadata", start, { once: true });
  }
  function onMergePreviewTime() {
    const v = mergePreviewRef.current;
    if (!v || mergeSeq === null) return;
    const it = items[mergeSeq];
    if (it && v.currentTime >= it.end - 0.04) {
      if (mergeSeq + 1 < items.length) playMerged(mergeSeq + 1);
      else {
        v.pause();
        setMergeSeq(null);
      }
    }
  }

  // ---- 実行 ----
  const cutProblem = mode === "cut" && file && duration > 0 ? validateClips(clipsForCut) : null;
  const canRun = status !== "processing" && (mode === "cut" ? !!file && duration > 0 && segments.length > 0 && !cutProblem : mergeReady && !mergeProblem);

  async function handleRun() {
    const clips = mode === "cut" ? clipsForCut.map(({ file: f, start, end }) => ({ file: f, start, end })) : mergeClips.map(({ file: f, start, end }) => ({ file: f, start, end }));
    videoRef.current?.pause();
    mergePreviewRef.current?.pause();
    const controller = new AbortController();
    controllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    try {
      const out = await new VideoCutMergeProcessor().process({ clips, container, onProgress: setProgress, cancelSignal: controller.signal });
      if (runIdRef.current !== runId) {
        URL.revokeObjectURL(out.url);
        return;
      }
      setResult(out);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "動画を作成できませんでした");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        controllerRef.current = null;
      }
    }
  }

  function handleCancel() {
    if (!controllerRef.current) return;
    setCanceling(true);
    controllerRef.current.abort();
  }

  const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === container)?.ext ?? "mp4";
  const outName = mode === "cut" ? `${stripExtension(file?.name ?? "video")}_カット.${ext}` : `${stripExtension(items[0]?.file.name ?? "video")}_結合.${ext}`;

  return (
    <div className="flex flex-col gap-6">
      <Segmented
        ariaLabel="やること"
        testId="video-cut-merge-mode"
        value={mode}
        onChange={(v) => {
          setMode(v);
          resetResult();
        }}
        options={[
          { value: "cut", label: "不要部分を削除" },
          { value: "merge", label: "複数の動画を結合" },
        ]}
      />

      {mode === "cut" && (
        <>
          <section className="flex flex-col gap-3">
            <StepHeading n={1} as="h2">
              動画を選ぶ
            </StepHeading>
            <FileDropzone
              compact={!!file}
              accept={VIDEO_INPUT_ACCEPT}
              maxSizeMB={VIDEO_DROPZONE_MAX_MB}
              label="動画をドラッグ&ドロップ"
              hint="またはタップして選択（MP4・MOV・WebM）"
              onFilesSelected={(files) => {
                setFile(files[0]);
                setSegments([]);
                setSelection(null);
                setSeqIndex(null);
                resetResult();
              }}
              onError={setError}
            />
            {file && (
              <FileList
                files={[file]}
                onRemove={() => {
                  setFile(null);
                  setSegments([]);
                  resetResult();
                }}
              />
            )}
            {file && <VideoSizeWarning sizeBytes={file.size} />}
          </section>

          {file && previewUrl && (
            <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800" data-testid="tool-preview">
              <StepHeading n={2} as="h2">
                タイムラインで不要な部分を削除
              </StepHeading>
              <video
                ref={videoRef}
                src={previewUrl}
                onLoadedMetadata={handleLoadedMetadata}
                controls
                playsInline
                preload="metadata"
                data-testid="video-cut-video"
                className="mx-auto block h-auto max-h-[min(50vh,26rem)] w-auto max-w-full rounded-lg bg-black"
              />
              {duration > 0 && (
                <>
                  <VideoTimeline
                    testId="video-cut-timeline"
                    rowTestId="video-cut-segment"
                    duration={duration}
                    currentTime={currentTime}
                    onSeek={seek}
                    rows={segments.map((s, i) => ({ id: String(s.id), label: `区間${i + 1}`, start: s.start, end: s.end, text: `${i + 1}`, selected: s.id === selectedSeg, colorClass: "bg-emerald-600" }))}
                    onSelect={(id) => setSelectedSeg(Number(id))}
                    onChange={(id, start, end) => changeSegments(segments.map((s) => (String(s.id) === id ? { ...s, start, end } : s)))}
                    minLength={MIN_CLIP_SEC}
                    selection={selection}
                    onSelectionChange={setSelection}
                    selectionLabel="削除する範囲"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={deleteSelection}
                      disabled={!selection || selection.end - selection.start < 0.05}
                      data-testid="video-cut-delete-range"
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                    >
                      選んだ範囲を削除{selection && selection.end > selection.start ? `（${formatTimeInput(selection.start)}〜${formatTimeInput(selection.end)}）` : ""}
                    </button>
                    <button
                      type="button"
                      onClick={splitAtPlayhead}
                      disabled={!splittable}
                      data-testid="video-cut-split"
                      className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200"
                    >
                      再生位置（{formatTimeInput(currentTime)}）で分ける
                    </button>
                    <button
                      type="button"
                      onClick={() => (seqIndex === null ? playJoined() : (videoRef.current?.pause(), setSeqIndex(null)))}
                      disabled={segments.length === 0}
                      data-testid="video-cut-play-joined"
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
                    >
                      {seqIndex === null ? "▶ つないだ結果を再生" : `■ 止める（区間${seqIndex + 1}を再生中）`}
                    </button>
                  </div>
                  <p className="text-xs text-ms-muted">
                    赤い行をドラッグして不要な範囲を選び、「選んだ範囲を削除」を押します。緑のバー（残す区間）は、端をドラッグして長さを、真ん中をドラッグして位置を変えられます。
                  </p>
                </>
              )}
            </section>
          )}

          {file && segments.length > 0 && (
            <section className="flex flex-col gap-2" data-testid="video-cut-segments">
              <StepHeading n={3} as="h2">
                残す区間の順番
              </StepHeading>
              <p className="text-xs text-ms-muted">上から順につながります。左のつまみ（⋮⋮）をドラッグするか、↑↓で順番を変えられます。</p>
              <ol className="flex flex-col gap-1.5" data-reorder-root>
                {segments.map((s, i) => (
                  <li
                    key={s.id}
                    data-reorder-index={i}
                    data-testid="video-cut-order-item"
                    className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${cutReorder.draggingIndex === i ? "opacity-50" : ""} ${cutReorder.overIndex === i && cutReorder.draggingIndex !== i ? "border-blue-500" : "border-neutral-200 dark:border-neutral-800"}`}
                  >
                    <span {...cutReorder.handleProps(i)} aria-label={`区間${i + 1}をドラッグして順番を変える`} className="select-none px-1 text-neutral-400" data-testid="video-cut-drag">
                      ⋮⋮
                    </span>
                    <span className="font-semibold text-ms-text">区間{i + 1}</span>
                    <span className="font-mono text-xs text-ms-muted">
                      {formatTimeInput(s.start)}〜{formatTimeInput(s.end)}（{formatDuration(s.end - s.start)}）
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      <button type="button" onClick={() => changeSegments(moveItem(segments, i, i - 1))} disabled={i === 0} aria-label={`区間${i + 1}を上へ移動`} className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-neutral-700">
                        ↑
                      </button>
                      <button type="button" onClick={() => changeSegments(moveItem(segments, i, i + 1))} disabled={i === segments.length - 1} aria-label={`区間${i + 1}を下へ移動`} className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-neutral-700">
                        ↓
                      </button>
                      <button type="button" onClick={() => changeSegments(segments.filter((x) => x.id !== s.id))} disabled={segments.length === 1} aria-label={`区間${i + 1}を削除`} className="rounded-md px-2 py-0.5 text-xs text-red-600 disabled:opacity-30 dark:text-red-400">
                        削除
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              {segments.length < MAX_CLIPS ? null : <p className="text-xs text-ms-muted">区間は{MAX_CLIPS}個までです。</p>}
              {cutProblem ? (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="video-cut-error">
                  {cutProblem}
                </p>
              ) : (
                duration > 0 && (
                  <p className="text-xs text-ms-text" data-testid="video-cut-summary">
                    {segments.length}区間・合計{formatDuration(keptSec)}を残します（元の動画は{formatDuration(duration)}）
                  </p>
                )
              )}
            </section>
          )}
        </>
      )}

      {mode === "merge" && (
        <section className="flex flex-col gap-3">
          <StepHeading n={1} as="h2">
            結合する動画を選ぶ
          </StepHeading>
          <FileDropzone
            compact={items.length > 0}
            multiple
            accept={VIDEO_INPUT_ACCEPT}
            maxSizeMB={VIDEO_DROPZONE_MAX_MB}
            label="動画をドラッグ&ドロップ（複数可）"
            hint="またはタップして選択（MP4・MOV・WebM）"
            onFilesSelected={(files) => void addMergeFiles(files)}
            onError={setError}
          />
          {items.length > 0 && (
            <>
              {mergeTotal > 0 && (
                <div className="flex flex-col gap-1" data-testid="video-merge-timeline">
                  <p className="text-xs font-medium text-ms-text">つないだあとのタイムライン（合計 {formatDuration(mergeTotal)}）</p>
                  <div className="flex h-9 w-full overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
                    {items.map((it, i) => {
                      const len = Math.max(0, it.end - it.start);
                      return (
                        <div
                          key={it.id}
                          className={`flex min-w-0 items-center justify-center truncate border-r border-white/60 px-1 text-[11px] text-white ${i % 2 === 0 ? "bg-blue-600" : "bg-indigo-500"} ${mergeSeq === i ? "ring-2 ring-inset ring-yellow-300" : ""}`}
                          style={{ width: `${(len / mergeTotal) * 100}%` }}
                          title={`${i + 1}. ${it.file.name}（${formatDuration(len)}）`}
                          data-testid="video-merge-timeline-clip"
                        >
                          {i + 1}. {it.file.name}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800" data-testid="tool-preview">
                <video ref={mergePreviewRef} onTimeUpdate={onMergePreviewTime} playsInline controls preload="metadata" className="mx-auto block h-auto max-h-[min(40vh,20rem)] w-auto max-w-full rounded-lg bg-black" data-testid="video-merge-preview" />
                <button
                  type="button"
                  onClick={() => (mergeSeq === null ? playMerged(0) : (mergePreviewRef.current?.pause(), setMergeSeq(null)))}
                  disabled={!mergeReady}
                  data-testid="video-merge-play-joined"
                  className="w-fit rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  {mergeSeq === null ? "▶ つないだ結果を再生" : `■ 止める（${mergeSeq + 1}本目を再生中）`}
                </button>
              </div>
              <p className="text-xs text-ms-muted">上から順につながります。左のつまみ（⋮⋮）をドラッグするか、↑↓で順番を変えられます。各動画のバーの端をドラッグすると、不要な最初・最後を切り取れます。</p>
              <ol className="flex flex-col gap-3" data-testid="video-merge-list" aria-label="結合する順番" data-reorder-root>
                {items.map((it, i) => (
                  <MergeItemCard
                    key={it.id}
                    item={it}
                    index={i}
                    count={items.length}
                    dragging={mergeReorder.draggingIndex === i}
                    over={mergeReorder.overIndex === i && mergeReorder.draggingIndex !== i}
                    handleProps={mergeReorder.handleProps(i)}
                    onMove={(dir) => moveItemBy(i, dir)}
                    onRemove={() => removeItem(it.id)}
                    onTrim={(s, e) => trimItem(it.id, s, e)}
                  />
                ))}
              </ol>
              {items.length === 1 && <p className="text-xs text-ms-muted">結合するには、動画を2本以上選んでください。</p>}
              {mergeReady && !mergeProblem && (
                <p className="text-xs text-ms-text" data-testid="video-merge-summary">
                  {items.length}本・合計{formatDuration(mergeTotal)}の動画を1本にします
                </p>
              )}
              {mergeProblem && <p className="text-xs text-red-600 dark:text-red-400">{mergeProblem}</p>}
              {mixedSizes && (
                <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="video-merge-size-note">
                  縦横比の違う動画があります。1本目の大きさ（{items[0].width}×{items[0].height}）に合わせ、ほかの動画は縦横比を保ったまま、余った部分を黒くします（引き伸ばし・切り抜きはしません）。
                </p>
              )}
              {items.reduce((s, it) => s + it.file.size, 0) > 0 && <VideoSizeWarning sizeBytes={items.reduce((s, it) => s + it.file.size, 0)} />}
            </>
          )}
        </section>
      )}

      {(file || items.length > 0) && (
        <section className="flex flex-col gap-2">
          <StepHeading n={mode === "cut" ? 4 : 2} as="h2">
            出力形式
          </StepHeading>
          <Segmented
            ariaLabel="出力形式"
            testId="video-cut-merge-container"
            value={container}
            onChange={(v) => {
              setContainer(v);
              resetResult();
            }}
            options={OUTPUT_CONTAINER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <p className="text-xs text-ms-muted">つなぐために映像と音声を作り直すので、動画の長さに応じて時間がかかります（処理中はキャンセルできます）。</p>
        </section>
      )}

      {(file || items.length > 0) && (
        <RunBar>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={!canRun}
            aria-busy={status === "processing" || undefined}
            data-testid="video-cut-merge-run"
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {mode === "cut" ? "不要部分を削除して書き出す" : "動画を結合する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`${mode === "cut" ? "書き出し中" : "結合中"}... ${Math.round(progress * 100)}%`}
        successLabel={mode === "cut" ? "書き出しが完了しました" : "結合が完了しました"}
        onCancel={handleCancel}
        canceling={canceling}
      />
      {wasCanceled && (
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="video-cut-merge-result">
            {result.width}×{result.height} ・ {formatDuration(result.durationSec)} ・ {result.hasAudio ? "音声あり" : "音声なし"} ・ {formatBytes(result.sizeBytes)}
          </p>
          {result.letterboxed && <p className="text-xs text-neutral-500 dark:text-neutral-400">縦横比の違う動画は、黒い余白を付けて大きさをそろえました。</p>}
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, outName)} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}

/** 結合する動画1本（順番のつまみ・再生・残す範囲のバー） */
function MergeItemCard({
  item: it,
  index: i,
  count,
  dragging,
  over,
  handleProps,
  onMove,
  onRemove,
  onTrim,
}: {
  item: MergeItem;
  index: number;
  count: number;
  dragging: boolean;
  over: boolean;
  handleProps: ReturnType<ReturnType<typeof useDragReorder>["handleProps"]>;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onTrim: (start: number, end: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  return (
    <li
      data-reorder-index={i}
      data-testid="video-merge-item"
      className={`flex flex-col gap-2 rounded-lg border p-3 ${dragging ? "opacity-50" : ""} ${over ? "border-blue-500" : "border-neutral-200 dark:border-neutral-800"}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span {...handleProps} aria-label={`${it.file.name} をドラッグして順番を変える`} className="select-none px-1 text-lg text-neutral-400" data-testid="video-merge-drag">
            ⋮⋮
          </span>
          <span className="text-sm font-semibold text-ms-text">{i + 1}.</span>
        </div>
        <video
          ref={ref}
          src={it.url}
          controls
          playsInline
          preload="metadata"
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onSeeked={(e) => setT(e.currentTarget.currentTime)}
          className="block h-auto max-h-40 w-auto max-w-full rounded bg-black sm:w-48"
        />
        <div className="min-w-0 flex-1 text-xs">
          <p className="break-all font-medium text-ms-text">{it.file.name}</p>
          <p className="text-ms-muted">
            {it.error
              ? it.error
              : it.durationSec === null
                ? "読み込み中…"
                : `${it.width}×${it.height} ・ ${formatDuration(it.durationSec)} ・ ${it.hasAudio ? "音声あり" : "音声なし"} ・ ${formatBytes(it.file.size)}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onMove(-1)} disabled={i === 0} aria-label={`${it.file.name} を上へ移動`} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700">
            ↑
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={i === count - 1} aria-label={`${it.file.name} を下へ移動`} className="rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-30 dark:border-neutral-700">
            ↓
          </button>
          <button type="button" onClick={onRemove} aria-label={`${it.file.name} を削除`} className="rounded-md px-2 py-1 text-xs text-red-600 dark:text-red-400">
            削除
          </button>
        </div>
      </div>
      {it.durationSec !== null && it.durationSec > 0 && (
        <VideoTimeline
          testId={`video-merge-trim-${i}`}
          rowTestId="video-merge-trim"
          duration={it.durationSec}
          currentTime={t}
          onSeek={(s) => {
            if (ref.current) ref.current.currentTime = s;
            setT(s);
          }}
          rows={[{ id: String(it.id), label: "残す", start: it.start, end: it.end, text: `${formatTimeInput(it.start)}〜${formatTimeInput(it.end)}`, colorClass: "bg-emerald-600" }]}
          onChange={(_, s, e) => onTrim(s, e)}
          minLength={MIN_CLIP_SEC}
        />
      )}
    </li>
  );
}
