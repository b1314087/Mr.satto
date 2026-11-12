"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { VideoAudioLossNotice } from "@/components/tools/implementations/shared/video-audio-loss-notice";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { VideoOutputPlayer } from "@/components/tools/implementations/shared/video-preview-panel";
import { VideoMosaicProcessor, type VideoMosaicOutput } from "@/lib/processors/browser/video-mosaic";
import {
  inspectVideoFile,
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_DROPZONE_MAX_MB,
  VIDEO_INPUT_ACCEPT,
  VideoAudioWouldBeLostError,
  VideoCanceledByUserError,
  type OutputContainer,
  type VideoInputInfo,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import {
  boxAt,
  clampBox,
  EffectPainter,
  isActiveAt,
  LOW_SCORE,
  newRegionId,
  scoreAt,
  setKeyframe,
  type Box,
  type EffectKind,
  type MosaicRegion,
} from "@/lib/video/mosaic-regions";
import { mergeTrackFrom } from "@/lib/video/track";
import { trackRegionInBackground, type TrackEngine } from "@/lib/video/track-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";

const MAX_REGIONS = 20;
const MIN_SIDE = 8;

const KIND_OPTIONS: { value: EffectKind; label: string }[] = [
  { value: "mosaic", label: "モザイク" },
  { value: "blur", label: "ぼかし" },
  { value: "fill", label: "黒塗り" },
];

const smallButton =
  "ms-focus-ring rounded-lg bg-neutral-100 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.00";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

type Drag =
  | { kind: "draw"; x0: number; y0: number; box: Box }
  | { kind: "move"; id: string; x0: number; y0: number; start: Box; box: Box }
  | { kind: "resize"; id: string; corner: "nw" | "ne" | "sw" | "se"; start: Box; box: Box };

/** 動画モザイク（Stage 5）。動画の上で範囲を指定し、固定、または追跡して、モザイク・ぼかし・黒塗りをかけて書き出す */
export function VideoMosaicTool() {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<VideoInputInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [regions, setRegions] = useState<MosaicRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showEffect, setShowEffect] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [stageW, setStageW] = useState(640);

  const [tracking, setTracking] = useState<{ id: string; progress: number; engine: TrackEngine | null } | null>(null);
  const [trackNote, setTrackNote] = useState<string | null>(null);
  const trackCtrl = useRef<AbortController | null>(null);
  // 最後の追跡を、どちらで行ったか（Worker・画面側）。テストと不具合の調査用
  const [trackEngine, setTrackEngine] = useState<TrackEngine | null>(null);

  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoMosaicOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const exportCtrl = useRef<AbortController | null>(null);
  // 音声を書き出せないときの案内（音声なしで書き出すかを選んでもらう）
  const [audioLoss, setAudioLoss] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const painterRef = useRef(new EffectPainter());

  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);
  useRevokeObjectUrlOnChange(result?.url);

  const W = meta?.width ?? 0;
  const H = meta?.height ?? 0;
  const duration = meta?.durationSec ?? 0;
  const fps = info?.bestGuessFrameRate ?? 30;
  const frameSec = 1 / Math.max(1, fps);
  const scale = W > 0 ? stageW / W : 1;

  // 動画の情報（フレームレート・読み込めるか）を調べる。追跡で使うので、ファイルを変えるまで開いておく
  useEffect(() => {
    if (!file) return;
    let disposed = false;
    let opened: VideoInputInfo | null = null;
    inspectVideoFile(file)
      .then((i) => {
        if (disposed) i.input.dispose();
        else {
          opened = i;
          setInfo(i);
        }
      })
      .catch((e) => !disposed && setLoadError(e instanceof Error ? e.message : "動画を読み込めませんでした"));
    return () => {
      disposed = true;
      opened?.input.dispose();
    };
  }, [file]);

  useEffect(
    () => () => {
      trackCtrl.current?.abort();
      exportCtrl.current?.abort();
    },
    []
  );

  // 表示の幅（画面の大きさが変わっても、範囲は元の動画の座標で持つので、ずれない）
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setStageW(e.contentRect.width));
    ro.observe(el);
    setStageW(el.clientWidth);
    return () => ro.disconnect();
  }, [previewUrl, W]);

  // モザイクのプレビューを描く（再生中は毎フレーム、止まっているときは時刻・範囲が変わったとき）
  const draw = useCallback(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || W === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(stageW * dpr));
    const ch = Math.max(1, Math.round((stageW * H * dpr) / W));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, cw, ch);
    const k = cw / W;
    const t = v.currentTime;
    for (const r of regions) {
      if (!isActiveAt(r, t)) continue;
      const b = drag && "id" in drag && drag.id === r.id ? drag.box : boxAt(r, t, frameSec);
      painterRef.current.apply(ctx, c, { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }, r.kind, r.level, Math.min(W, H), k);
    }
  }, [regions, W, H, stageW, frameSec, drag]);

  useEffect(() => {
    if (!playing) {
      draw();
      return;
    }
    let raf = 0;
    const loop = () => {
      const v = videoRef.current;
      if (v) setTime(v.currentTime);
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw, time]);

  function handleSelectFile(files: File[]) {
    // 前の動画の追跡・書き出しが残っていれば止め、その結果を新しい動画（または、動画を消した画面）に出さない
    trackCtrl.current?.abort();
    trackCtrl.current = null;
    exportCtrl.current?.abort();
    exportCtrl.current = null;
    setTracking(null);
    setProgress(0);
    setCanceling(false);
    setAudioLoss(null);
    setFile(files[0]);
    setInfo(null);
    setLoadError(null);
    setRegions([]);
    setSelectedId(null);
    setTime(0);
    setResult(null);
    setStatus("idle");
    setError(null);
    setTrackNote(null);
    setTrackEngine(null);
  }

  function seek(t: number) {
    const v = videoRef.current;
    if (!v) return;
    const nt = Math.min(Math.max(0, t), Math.max(0, duration - frameSec / 2));
    v.currentTime = nt;
    setTime(nt);
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function toVideo(e: ReactPointerEvent): { x: number; y: number } {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
  }

  function updateRegion(id: string, fn: (r: MosaicRegion) => MosaicRegion) {
    setRegions((prev) => prev.map((r) => (r.id === id ? fn(r) : r)));
    setResult(null);
  }

  /** 範囲の位置を変える（固定はどの時刻でも同じ位置。追跡は、いまの時刻の位置を手で直したことにする） */
  function placeBox(id: string, box: Box) {
    updateRegion(id, (r) => {
      const b = clampBox(box, W, H);
      if (r.mode === "fixed") return { ...r, box: b };
      const next = setKeyframe(r, time, b, frameSec);
      return r.track.length === 0 ? { ...next, box: b } : next;
    });
  }

  function onStageDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || tracking || W === 0) return;
    videoRef.current?.pause();
    const p = toVideo(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-region-id]");
    const handle = (e.target as HTMLElement).dataset.corner as "nw" | "ne" | "sw" | "se" | undefined;
    if (target) {
      const id = target.dataset.regionId!;
      const r = regions.find((x) => x.id === id);
      if (!r) return;
      setSelectedId(id);
      const start = boxAt(r, time, frameSec);
      setDrag(handle ? { kind: "resize", id, corner: handle, start, box: start } : { kind: "move", id, x0: p.x, y0: p.y, start, box: start });
      return;
    }
    if (regions.length >= MAX_REGIONS) return;
    setSelectedId(null);
    setDrag({ kind: "draw", x0: p.x, y0: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } });
  }

  /**
   * 「モザイク追加」（総合改修 12）：プレビューの真ん中に、動かない（固定の）モザイク範囲を1つ作る。
   * 作った範囲は、ドラッグで移動・四隅で大きさを変更・一覧で強さの調整と削除ができる（自動追跡はしない）。
   */
  function addFixedRegion() {
    if (W === 0 || regions.length >= MAX_REGIONS || tracking) return;
    videoRef.current?.pause();
    const w = Math.max(MIN_SIDE, Math.round(W * 0.25));
    const h = Math.max(MIN_SIDE, Math.round(H * 0.25));
    const offset = (regions.length % 5) * Math.round(Math.min(W, H) * 0.04);
    const box = clampBox({ x: Math.round((W - w) / 2) + offset, y: Math.round((H - h) / 2) + offset, w, h }, W, H);
    const id = newRegionId();
    const region: MosaicRegion = { id, mode: "fixed", kind: "mosaic", level: 6, box, keyframes: [{ t: time, ...box }], track: [], from: null, to: null };
    setRegions((prev) => [...prev, region]);
    setSelectedId(id);
    setResult(null);
  }

  function onStageMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const p = toVideo(e);
    if (drag.kind === "draw") {
      const x = Math.min(drag.x0, p.x);
      const y = Math.min(drag.y0, p.y);
      setDrag({ ...drag, box: { x, y, w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) } });
    } else if (drag.kind === "move") {
      setDrag({ ...drag, box: clampBox({ ...drag.start, x: drag.start.x + p.x - drag.x0, y: drag.start.y + p.y - drag.y0 }, W, H) });
    } else {
      const s = drag.start;
      const left = drag.corner.includes("w") ? Math.min(p.x, s.x + s.w - MIN_SIDE) : s.x;
      const top = drag.corner.includes("n") ? Math.min(p.y, s.y + s.h - MIN_SIDE) : s.y;
      const right = drag.corner.includes("e") ? Math.max(p.x, s.x + MIN_SIDE) : s.x + s.w;
      const bottom = drag.corner.includes("s") ? Math.max(p.y, s.y + MIN_SIDE) : s.y + s.h;
      setDrag({ ...drag, box: clampBox({ x: left, y: top, w: right - left, h: bottom - top }, W, H) });
    }
  }

  function onStageUp() {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.kind === "draw") {
      if (d.box.w < MIN_SIDE || d.box.h < MIN_SIDE) return;
      const box = clampBox(d.box, W, H);
      const id = newRegionId();
      const region: MosaicRegion = { id, mode: "track", kind: "mosaic", level: 6, box, keyframes: [{ t: time, ...box }], track: [], from: null, to: null };
      setRegions((prev) => [...prev, region]);
      setSelectedId(id);
      setResult(null);
      return;
    }
    if (d.box.x !== d.start.x || d.box.y !== d.start.y || d.box.w !== d.start.w || d.box.h !== d.start.h) placeBox(d.id, d.box);
  }

  async function runTracking(r: MosaicRegion, direction: "both" | "forward") {
    if (!info) return;
    videoRef.current?.pause();
    const anchorBox = boxAt(r, time, frameSec);
    const withAnchor = setKeyframe(r, time, anchorBox, frameSec);
    updateRegion(r.id, () => withAnchor);
    const ctrl = new AbortController();
    trackCtrl.current = ctrl;
    setTracking({ id: r.id, progress: 0, engine: null });
    setTrackNote(null);
    try {
      if (!file) return;
      // 工程4：追跡は、できれば画面とは別の処理（Web Worker）で行う（追跡中も画面が固まらない）。使えない環境では従来どおり画面側で行う
      const points = await trackRegionInBackground({
        file,
        videoTrack: info.videoTrack,
        width: W,
        height: H,
        durationSec: duration,
        frameRate: fps,
        anchor: { t: time, ...anchorBox },
        keyframes: direction === "both" ? [] : withAnchor.keyframes.filter((k) => k.t > time + frameSec / 2),
        direction,
        from: r.from,
        to: r.to,
        onProgress: (p) => {
          if (trackCtrl.current === ctrl) setTracking((cur) => (cur ? { ...cur, progress: p } : cur));
        },
        onEngine: (engine) => {
          if (trackCtrl.current !== ctrl) return;
          setTrackEngine(engine);
          setTracking((cur) => (cur ? { ...cur, engine } : cur));
        },
        signal: ctrl.signal,
      });
      if (trackCtrl.current !== ctrl) return;
      updateRegion(r.id, (cur) => ({
        ...cur,
        mode: "track",
        keyframes: direction === "both" ? [{ t: time, ...anchorBox }] : cur.keyframes,
        track: direction === "both" ? points : mergeTrackFrom(cur.track, points, time, frameSec),
      }));
      const low = points.filter((p) => p.score < LOW_SCORE).length;
      setTrackNote(
        low > 0
          ? `追跡しました。${low}コマで、ずれているかもしれません（黄色の所）。「ずれている所へ」で確かめて、位置を直してから「ここから追跡し直す」を押してください。`
          : "追跡しました。再生して、範囲が対象に付いていくか確かめてください。"
      );
    } catch (e) {
      if (trackCtrl.current !== ctrl) return;
      if (e instanceof VideoCanceledByUserError) setTrackNote("追跡を止めました。途中までの結果は使いません。");
      else setTrackNote(e instanceof Error ? e.message : "追跡できませんでした。");
    } finally {
      if (trackCtrl.current === ctrl) {
        setTracking(null);
        trackCtrl.current = null;
      }
    }
  }

  function nextLowSpot(r: MosaicRegion) {
    const after = r.track.find((p) => p.t > time + frameSec / 2 && p.score < LOW_SCORE);
    const target = after ?? r.track.find((p) => p.score < LOW_SCORE);
    if (target) seek(target.t);
  }

  async function handleExport(options: { dropAudio?: boolean } = {}) {
    if (!file || regions.length === 0) return;
    videoRef.current?.pause();
    const ctrl = new AbortController();
    exportCtrl.current = ctrl;
    setStatus("processing");
    setProgress(0);
    setError(null);
    setResult(null);
    setCanceling(false);
    setAudioLoss(null);
    try {
      const out = await new VideoMosaicProcessor().process({
        file,
        regions,
        sourceWidth: W,
        sourceHeight: H,
        outputContainer: container,
        onProgress: setProgress,
        cancelSignal: ctrl.signal,
        dropAudio: options.dropAudio,
      });
      if (exportCtrl.current !== ctrl) return;
      setResult(out);
      setStatus("success");
    } catch (e) {
      if (exportCtrl.current !== ctrl) return;
      if (e instanceof VideoAudioWouldBeLostError) {
        setAudioLoss(e.message);
        setStatus("idle");
      } else if (e instanceof VideoCanceledByUserError) setStatus("idle");
      else {
        setError(e instanceof Error ? e.message : "書き出せませんでした");
        setStatus("error");
      }
    } finally {
      if (exportCtrl.current === ctrl) {
        setCanceling(false);
        exportCtrl.current = null;
      }
    }
  }

  const visibleRegions = useMemo(
    () =>
      regions
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => isActiveAt(r, time) || r.id === selectedId)
        .map(({ r, i }) => {
          const live = drag && "id" in drag && drag.id === r.id ? drag.box : boxAt(r, time, frameSec);
          return { r, i, box: live, score: scoreAt(r, time, frameSec), active: isActiveAt(r, time) };
        }),
    [regions, time, frameSec, drag, selectedId]
  );

  return (
    <div className="flex flex-col gap-5">
      {!file && (
        <FileDropzone
          compact={!!file}
          accept={VIDEO_INPUT_ACCEPT}
          maxSizeMB={VIDEO_DROPZONE_MAX_MB}
          label="動画ファイルをドラッグ&ドロップ"
          hint="またはタップして選択（MP4 / MOV / WebM）"
          onFilesSelected={handleSelectFile}
          onError={setError}
        />
      )}
      {file && <FileList files={[file]} onRemove={() => handleSelectFile([])} />}
      {file && <VideoSizeWarning sizeBytes={file.size} />}
      {loadError && <ErrorMessage message={loadError} />}

      {file && previewUrl && (
        <section className="flex flex-col gap-2" data-testid="tool-preview">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addFixedRegion}
              disabled={W === 0 || regions.length >= MAX_REGIONS || tracking !== null}
              className="ms-focus-ring rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
              data-testid="vm-add"
            >
              ＋ モザイク追加
            </button>
            <p className="min-w-0 flex-1 text-xs text-neutral-600 dark:text-neutral-300" data-testid="vm-help">
              「モザイク追加」で、動かない範囲を真ん中に作れます（ドラッグで移動・四隅で大きさを変更）。動くものを隠すときは、止めた場面で隠したい所をドラッグ →「追跡する」。
            </p>
          </div>
          <div className="mx-auto w-full" style={W > 0 ? { maxWidth: `min(100%, ${Math.round((60 * W) / H)}vh)` } : undefined}>
            <div
              ref={stageRef}
              className="relative w-full touch-none select-none overflow-hidden rounded-lg bg-black"
              // サイト共通の scrollbar-gutter: stable（globals.css）が効くと、右にスクロールバー分の黒い帯ができるため、ここでは外す
              style={W > 0 ? { aspectRatio: `${W} / ${H}`, scrollbarGutter: "auto" } : { minHeight: 200, scrollbarGutter: "auto" }}
              onPointerDown={onStageDown}
              onPointerMove={onStageMove}
              onPointerUp={onStageUp}
              onPointerCancel={() => setDrag(null)}
              data-testid="vm-stage"
              data-track-engine={trackEngine ?? undefined}
              data-video-width={W}
              data-video-height={H}
            >
              <video
                ref={videoRef}
                src={previewUrl}
                playsInline
                muted
                preload="auto"
                className="absolute inset-0 h-full w-full"
                onLoadedMetadata={handleLoadedMetadata}
                onLoadedData={() => draw()}
                onSeeked={() => {
                  setTime(videoRef.current?.currentTime ?? 0);
                  draw();
                }}
                onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  setPlaying(false);
                  setTime(videoRef.current?.currentTime ?? 0);
                }}
                data-testid="vm-video"
              />
              <canvas ref={canvasRef} className={`pointer-events-none absolute inset-0 h-full w-full ${showEffect ? "" : "hidden"}`} data-testid="vm-canvas" />
              {visibleRegions.map(({ r, i, box, score, active }) => {
                const isSel = r.id === selectedId;
                const low = score !== null && score < LOW_SCORE;
                return (
                  <div
                    key={r.id}
                    data-region-id={r.id}
                    data-testid="vm-box"
                    data-box={`${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}`}
                    className={`absolute cursor-move border-2 ${isSel ? "border-blue-500" : low ? "border-amber-400" : "border-white/90"} ${active ? "" : "opacity-40"} ${isSel ? "" : "border-dashed"}`}
                    style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale, boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
                  >
                    <span className={`absolute -top-5 left-0 rounded px-1 text-[11px] font-bold ${low ? "bg-amber-400 text-amber-950" : "bg-blue-600 text-white"}`}>
                      {i + 1}
                      {low ? " ずれているかも" : ""}
                    </span>
                    {isSel &&
                      (["nw", "ne", "sw", "se"] as const).map((c) => (
                        <span
                          key={c}
                          data-corner={c}
                          data-testid={`vm-handle-${c}`}
                          className="absolute h-3.5 w-3.5 rounded-sm border-2 border-white bg-blue-600"
                          style={{
                            left: c.includes("w") ? -8 : undefined,
                            right: c.includes("e") ? -8 : undefined,
                            top: c.includes("n") ? -8 : undefined,
                            bottom: c.includes("s") ? -8 : undefined,
                            cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize",
                          }}
                        />
                      ))}
                  </div>
                );
              })}
              {drag?.kind === "draw" && (
                <div className="pointer-events-none absolute border-2 border-blue-400 bg-blue-400/20" style={{ left: drag.box.x * scale, top: drag.box.y * scale, width: drag.box.w * scale, height: drag.box.h * scale }} />
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={togglePlay} className={smallButton} data-testid="vm-play" disabled={W === 0}>
              {playing ? "❚❚ 止める" : "▶ 再生"}
            </button>
            <button type="button" onClick={() => seek(time - frameSec)} className={smallButton} aria-label="1コマ戻る" data-testid="vm-prev">
              ◀ 1コマ
            </button>
            <button type="button" onClick={() => seek(time + frameSec)} className={smallButton} aria-label="1コマ進む" data-testid="vm-next">
              1コマ ▶
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0.01, duration)}
              step={frameSec}
              value={Math.min(time, duration)}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="再生位置"
              className="min-w-32 flex-1"
              data-testid="vm-seek"
            />
            <span className="font-mono text-xs text-neutral-600 dark:text-neutral-300" data-testid="vm-time">
              {formatTime(time)} / {formatTime(duration)}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={showEffect} onChange={(e) => setShowEffect(e.target.checked)} data-testid="vm-show-effect" />
              モザイクを表示
            </label>
          </div>
          {trackNote && (
            <p className="rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200" role="status" data-testid="vm-track-note">
              {trackNote}
            </p>
          )}
        </section>
      )}

      {file && regions.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="範囲の一覧">
          {regions.map((r, i) => (
            <RegionCard
              key={r.id}
              index={i}
              region={r}
              selected={r.id === selectedId}
              duration={duration}
              time={time}
              frameSec={frameSec}
              busy={tracking !== null}
              onSelect={() => setSelectedId(r.id)}
              onChange={(fn) => updateRegion(r.id, fn)}
              onDelete={() => {
                setRegions((prev) => prev.filter((x) => x.id !== r.id));
                if (selectedId === r.id) setSelectedId(null);
                setResult(null);
              }}
              onTrack={() => runTracking(r, "both")}
              onRetrack={() => runTracking(r, "forward")}
              onSeek={seek}
              onNextLow={() => nextLowSpot(r)}
            />
          ))}
        </section>
      )}

      <ProcessingStatus
        state={tracking ? "processing" : "idle"}
        processingLabel={
          !tracking || (tracking.engine === null && tracking.progress === 0)
            ? "動画を解析中…"
            : `追跡中… ${Math.round(tracking.progress * 100)}%`
        }
        onCancel={() => trackCtrl.current?.abort()}
        cancelLabel="追跡を止める"
        testId="vm-tracking"
      />

      {file && regions.length > 0 && (
        <section className="flex flex-col gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">出力形式</legend>
            {OUTPUT_CONTAINER_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  container === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                <input type="radio" name="vm-container" value={opt.value} checked={container === opt.value} onChange={() => setContainer(opt.value)} className="sr-only" />
                {opt.label}
              </label>
            ))}
          </fieldset>
          <RunBar>
            <button
              type="button"
              onClick={() => handleExport()}
              disabled={status === "processing" || tracking !== null || !info}
              aria-busy={status === "processing" || undefined}
              data-testid="vm-export"
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              モザイクをかけて書き出す
            </button>
          </RunBar>
        </section>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progress <= 0 ? "書き出しの準備中…" : progress >= 0.999 ? "仕上げ中…" : `書き出し中… ${Math.round(progress * 100)}%`}
        successLabel="モザイクをかけました"
        onCancel={() => {
          setCanceling(true);
          exportCtrl.current?.abort();
        }}
        canceling={canceling}
      />
      {error && <ErrorMessage message={error} />}
      {audioLoss && (
        <VideoAudioLossNotice message={audioLoss} onProceed={() => handleExport({ dropAudio: true })} onDismiss={() => setAudioLoss(null)} />
      )}
      {result && file && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, `${stripExtension(file.name)}-mosaic.${OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === result.outputContainer)?.ext ?? "mp4"}`)}
            label="ダウンロード"
          />
        </ResultPopup>
      )}
    </div>
  );
}

function RegionCard({
  index,
  region: r,
  selected,
  duration,
  time,
  frameSec,
  busy,
  onSelect,
  onChange,
  onDelete,
  onTrack,
  onRetrack,
  onSeek,
  onNextLow,
}: {
  index: number;
  region: MosaicRegion;
  selected: boolean;
  duration: number;
  time: number;
  frameSec: number;
  busy: boolean;
  onSelect: () => void;
  onChange: (fn: (r: MosaicRegion) => MosaicRegion) => void;
  onDelete: () => void;
  onTrack: () => void;
  onRetrack: () => void;
  onSeek: (t: number) => void;
  onNextLow: () => void;
}) {
  const tracked = r.mode === "track" && r.track.length > 0;
  const lowCount = r.track.filter((p) => p.score < LOW_SCORE).length;
  // 時間の帯：追跡した区間（緑）・ずれているかもしれない区間（黄）・手で直した位置（青い線）
  const BUCKETS = 120;
  const buckets = useMemo(() => {
    if (!tracked || duration <= 0) return null;
    const out: (number | null)[] = Array(BUCKETS).fill(null);
    for (const p of r.track) {
      const k = Math.min(BUCKETS - 1, Math.floor((p.t / duration) * BUCKETS));
      out[k] = out[k] === null ? p.score : Math.min(out[k]!, p.score);
    }
    return out;
  }, [r.track, tracked, duration]);

  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border p-3 text-sm ${selected ? "border-blue-500 ring-1 ring-blue-500" : "border-neutral-200 dark:border-neutral-800"}`}
      onClick={onSelect}
      data-testid="vm-region"
      data-mode={r.mode}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-blue-600 px-1.5 text-xs font-bold text-white">{index + 1}</span>
        <div role="radiogroup" aria-label={`範囲${index + 1}の動き`} className="ms-seg">
          {(
            [
              { v: "track", label: "追跡" },
              { v: "fixed", label: "固定" },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              role="radio"
              aria-checked={r.mode === o.v}
              onClick={() => onChange((cur) => (o.v === "fixed" ? { ...cur, mode: "fixed", box: boxAt(cur, time, frameSec) } : { ...cur, mode: "track" }))}
              data-testid={`vm-mode-${o.v}`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Segmented
          size="sm"
          ariaLabel={`範囲${index + 1}のかけ方`}
          testId="vm-kind"
          value={r.kind}
          onChange={(v) => onChange((cur) => ({ ...cur, kind: v }))}
          options={KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label }))}
        />
        {r.kind !== "fill" && (
          <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300">
            強さ
            <input type="range" min={1} max={10} value={r.level} onChange={(e) => onChange((cur) => ({ ...cur, level: Number(e.target.value) }))} aria-label={`範囲${index + 1}の強さ`} className="w-24" data-testid="vm-level" />
          </label>
        )}
        <button type="button" onClick={onDelete} className={`${smallButton} ml-auto`} aria-label={`範囲${index + 1}を削除`} data-testid="vm-delete">
          削除
        </button>
      </div>

      {r.mode === "track" && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onTrack} disabled={busy} className="ms-focus-ring rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" data-testid="vm-track">
            {tracked ? "追跡をやり直す" : "追跡する"}
          </button>
          {tracked && (
            <button type="button" onClick={onRetrack} disabled={busy} className={smallButton} data-testid="vm-retrack">
              ここから追跡し直す
            </button>
          )}
          {lowCount > 0 && (
            <button type="button" onClick={onNextLow} className={smallButton} data-testid="vm-next-low">
              ずれている所へ（{lowCount}コマ）
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        かける時間：
        <span className="font-mono" data-testid="vm-range">
          {r.from === null ? "最初" : formatTime(r.from)} 〜 {r.to === null ? "最後" : formatTime(r.to)}
        </span>
        <button type="button" className={smallButton} onClick={() => onChange((cur) => ({ ...cur, from: time }))} data-testid="vm-from">
          ここから
        </button>
        <button type="button" className={smallButton} onClick={() => onChange((cur) => ({ ...cur, to: time }))} data-testid="vm-to">
          ここまで
        </button>
        {(r.from !== null || r.to !== null) && (
          <button type="button" className={smallButton} onClick={() => onChange((cur) => ({ ...cur, from: null, to: null }))}>
            全体
          </button>
        )}
      </div>

      {buckets && (
        <div
          className="relative h-3 w-full cursor-pointer overflow-hidden rounded bg-neutral-200 [scrollbar-gutter:auto] dark:bg-neutral-800"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeek(((e.clientX - rect.left) / rect.width) * duration);
          }}
          style={{ scrollbarGutter: "auto" }}
          role="img"
          aria-label={`範囲${index + 1}の追跡の結果（黄色はずれているかもしれない所）`}
          data-testid="vm-timeline"
        >
          {buckets.map((s, k) =>
            s === null ? null : (
              <span key={k} className={`absolute top-0 h-full ${s < LOW_SCORE ? "bg-amber-400" : "bg-emerald-500"}`} style={{ left: `${(k / BUCKETS) * 100}%`, width: `${100 / BUCKETS + 0.2}%` }} />
            )
          )}
          {r.keyframes.map((k) => (
            <span key={k.t} className="absolute top-0 h-full w-0.5 bg-blue-600" style={{ left: `${(k.t / duration) * 100}%` }} />
          ))}
          <span className="absolute top-0 h-full w-0.5 bg-black dark:bg-white" style={{ left: `${(time / Math.max(0.001, duration)) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
