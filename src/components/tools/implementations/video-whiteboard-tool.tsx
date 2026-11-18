"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ResultPopup } from "@/components/common/result-popup";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { VideoOutputPlayer } from "@/components/tools/implementations/shared/video-preview-panel";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { VideoBoardProcessor, type VideoBoardOutput } from "@/lib/processors/browser/video-board";
import {
  BOARD_MAX_SECONDS,
  BOARD_MAX_VIDEOS,
  BOARD_SHAPES,
  arrangeInGrid,
  boardDuration,
  boardSize,
  localTime,
  type BoardEndBehavior,
  type BoardShape,
} from "@/lib/video/board-layout";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_DROPZONE_MAX_MB,
  VIDEO_INPUT_ACCEPT,
  VideoCanceledByUserError,
  inspectVideoFile,
  type OutputContainer,
} from "@/lib/video/shared";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/**
 * 動画ホワイトボード（2026-11-19 新規）。画像ホワイトボードの動画版。
 *
 * - 複数の動画（最大6本）を、縦動画（9:16）・横動画（16:9）・正方形のキャンバスに自由に置く（移動・拡大縮小・回転・重ね順）。
 * - プレビューでは、すべての動画を同時に再生する（音もすべて混ざる）。動画ごとに音量を変えられる。
 * - 書き出し：いちばん長い動画の長さの、1本の動画（MP4・WebM）。短い動画は、最後の場面で止めるか、くり返す。
 * - 動画はサーバーへ送らず、ブラウザの中だけで処理する（src/lib/processors/browser/video-board.ts）。
 */

interface BoardItem {
  id: string;
  file: File;
  url: string;
  duration: number;
  aspect: number;
  hasAudio: boolean;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  /** 音量（0〜100） */
  volume: number;
}

type Drag =
  | { kind: "move"; id: string; startX: number; startY: number; cx: number; cy: number }
  | { kind: "resize"; id: string; startDist: number; w: number; h: number; cx: number; cy: number }
  | { kind: "rotate"; id: string; cx: number; cy: number };

const MIN_SIZE = 60;
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()));
const fmt = (sec: number) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

export function VideoWhiteboardTool() {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [shape, setShape] = useState<BoardShape>("vertical");
  const [background, setBackground] = useState("#000000");
  const [endBehavior, setEndBehavior] = useState<BoardEndBehavior>("hold");
  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<VideoBoardOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [boxWidth, setBoxWidth] = useState(360);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const dragRef = useRef<Drag | null>(null);
  const clockRef = useRef<{ startWall: number } | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const hasItems = items.length > 0;

  const { width: W, height: H } = boardSize(shape);
  const total = boardDuration(items.map((i) => i.duration));
  const tooLong = items.some((i) => i.duration > BOARD_MAX_SECONDS + 0.5);
  const scale = Math.min(boxWidth / W, 520 / H);
  const busy = status === "processing";

  // プレビューの幅を測る（キャンバスを画面の幅に合わせて縮めて見せる）
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth || 360));
    ro.observe(el);
    setBoxWidth(el.clientWidth || 360);
    return () => ro.disconnect();
  }, [hasItems]);

  // 読み込んだ動画のURLは、外したときと終わるときに手放す
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.url)), []);
  useEffect(() => () => cancelRef.current?.abort(), []);

  /** すべての動画を、全体の時刻 t の場面にそろえる */
  function syncVideos(t: number, play: boolean) {
    for (const it of itemsRef.current) {
      const el = videoRefs.current.get(it.id);
      if (!el) continue;
      el.volume = it.volume / 100;
      el.loop = endBehavior === "loop";
      const lt = localTime(t, it.duration, endBehavior);
      const finished = endBehavior === "hold" && t >= it.duration;
      if (!play || finished) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - lt) > 0.05) el.currentTime = lt;
        continue;
      }
      if (Math.abs(el.currentTime - lt) > 0.25) el.currentTime = lt;
      if (el.paused) void el.play().catch(() => undefined);
    }
  }

  // 再生中は、全体の時計を進めて、ずれた動画だけ位置を直す
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const clock = clockRef.current;
      if (!clock) return;
      const t = (performance.now() - clock.startWall) / 1000;
      if (t >= total) {
        setTime(total);
        setPlaying(false);
        syncVideos(total, false);
        return;
      }
      setTime(t);
      syncVideos(t, true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // syncVideos は毎回の描画で作り直すが、中身は refs だけを読む
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, total, endBehavior]);

  function togglePlay() {
    if (playing) {
      setPlaying(false);
      syncVideos(time, false);
      return;
    }
    const start = time >= total - 0.05 ? 0 : time;
    clockRef.current = { startWall: performance.now() - start * 1000 };
    setTime(start);
    syncVideos(start, true);
    setPlaying(true);
  }

  function seek(t: number) {
    const next = Math.max(0, Math.min(total, t));
    setTime(next);
    if (playing) clockRef.current = { startWall: performance.now() - next * 1000 };
    syncVideos(next, playing);
  }

  function clearResult() {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    if (status !== "processing") setStatus("idle");
  }

  function update(next: BoardItem[]) {
    setItems(next);
    clearResult();
  }

  function arrange(list: BoardItem[], size = { width: W, height: H }): BoardItem[] {
    const places = arrangeInGrid(
      list.map((i) => i.aspect),
      size
    );
    return list.map((it, k) => ({ ...it, ...places[k] }));
  }

  async function handleSelect(files: File[]) {
    setError(null);
    const room = BOARD_MAX_VIDEOS - items.length;
    if (room <= 0) {
      setError(`置ける動画は${BOARD_MAX_VIDEOS}本までです。`);
      return;
    }
    const picked = files.slice(0, room);
    setLoading(true);
    const added: BoardItem[] = [];
    try {
      for (const file of picked) {
        try {
          const info = await inspectVideoFile(file);
          info.input.dispose();
          added.push({
            id: newId(),
            file,
            url: URL.createObjectURL(file),
            duration: info.durationSec,
            aspect: info.displayWidth / Math.max(1, info.displayHeight),
            hasAudio: info.hasAudio,
            cx: W / 2,
            cy: H / 2,
            w: W / 2,
            h: H / 2,
            rotation: 0,
            volume: 100,
          });
        } catch (e) {
          setError(`${file.name}：${e instanceof Error ? e.message : "動画を読み込めませんでした。"}`);
        }
      }
    } finally {
      setLoading(false);
    }
    if (files.length > room) setError(`置ける動画は${BOARD_MAX_VIDEOS}本までです。${files.length - room}本は追加しませんでした。`);
    if (added.length === 0) return;
    // はじめて置くときは、きれいに並べる。あとから足すときは、今の配置を崩さず真ん中に置く
    const next =
      items.length === 0
        ? arrange(added)
        : [
            ...items,
            ...added.map((it) => {
              const w = W * 0.45;
              return { ...it, w, h: w / it.aspect };
            }),
          ];
    update(next);
    setSelectedId(added[added.length - 1].id);
  }

  function removeItem(id: string) {
    const it = items.find((i) => i.id === id);
    if (it) URL.revokeObjectURL(it.url);
    videoRefs.current.delete(id);
    update(items.filter((i) => i.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function moveOrder(id: string, delta: -1 | 1) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  }

  function changeShape(next: BoardShape) {
    setShape(next);
    update(arrange(items, boardSize(next)));
  }

  function patch(id: string, p: Partial<BoardItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...p } : i)));
    clearResult();
  }

  // キャンバスの上の位置（キャンバスの画素）。表示の倍率（大きく表示の拡大も含む）は、実際の表示の大きさから求める
  function boardPoint(e: { clientX: number; clientY: number }) {
    const rect = boardRef.current!.getBoundingClientRect();
    const k = rect.width / W;
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  }

  function startDrag(e: ReactPointerEvent, it: BoardItem, kind: Drag["kind"]) {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(it.id);
    const p = boardPoint(e);
    if (kind === "move") dragRef.current = { kind, id: it.id, startX: p.x, startY: p.y, cx: it.cx, cy: it.cy };
    else if (kind === "resize") dragRef.current = { kind, id: it.id, startDist: Math.max(1, Math.hypot(p.x - it.cx, p.y - it.cy)), w: it.w, h: it.h, cx: it.cx, cy: it.cy };
    else dragRef.current = { kind, id: it.id, cx: it.cx, cy: it.cy };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const q = boardPoint(ev);
      if (d.kind === "move") patch(d.id, { cx: d.cx + (q.x - d.startX), cy: d.cy + (q.y - d.startY) });
      else if (d.kind === "resize") {
        const ratio = Math.hypot(q.x - d.cx, q.y - d.cy) / d.startDist;
        const w = Math.max(MIN_SIZE, d.w * ratio);
        patch(d.id, { w, h: (w * d.h) / d.w });
      } else {
        let deg = (Math.atan2(q.y - d.cy, q.x - d.cx) * 180) / Math.PI + 90;
        deg = ((deg % 360) + 360) % 360;
        // 0・90・180・270度の近くでは、ぴったりに吸い付ける
        for (const snap of [0, 90, 180, 270, 360]) if (Math.abs(deg - snap) < 4) deg = snap % 360;
        patch(d.id, { rotation: Math.round(deg) });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Delete・Backspace で、選んだ動画を外す（入力欄にいるときは除く）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selectedId || (e.key !== "Delete" && e.key !== "Backspace")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      removeItem(selectedId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function handleRun() {
    if (items.length === 0 || tooLong) return;
    setPlaying(false);
    syncVideos(time, false);
    const controller = new AbortController();
    cancelRef.current = controller;
    clearResult();
    setError(null);
    setStatus("processing");
    setProgress(0);
    setCanceling(false);
    try {
      const out = await new VideoBoardProcessor().process({
        items: items.map((i) => ({ file: i.file, cx: i.cx, cy: i.cy, w: i.w, h: i.h, rotation: i.rotation, volume: i.volume / 100 })),
        width: W,
        height: H,
        background,
        endBehavior,
        container,
        onProgress: setProgress,
        cancelSignal: controller.signal,
      });
      setResult(out);
      setStatus("success");
    } catch (e) {
      if (e instanceof VideoCanceledByUserError) setStatus("idle");
      else {
        setError(e instanceof Error ? e.message : "書き出しに失敗しました。");
        setStatus("error");
      }
    } finally {
      cancelRef.current = null;
      setCanceling(false);
    }
  }

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const shapeOptions = useMemo(() => BOARD_SHAPES.map((s) => ({ value: s.value, label: s.label, title: s.hint })), []);

  const preview =
    items.length > 0 ? (
      <section data-testid="tool-preview" aria-label="動画ホワイトボードのプレビュー" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（動画をドラッグして動かせます）</p>
        <div ref={boxRef} className="w-full">
          <div
            ref={boardRef}
            data-testid="vb-board"
            data-board-width={W}
            data-board-height={H}
            onPointerDown={() => setSelectedId(null)}
            className="relative mx-auto touch-none overflow-hidden rounded-md shadow-inner ring-1 ring-neutral-300 dark:ring-neutral-700"
            style={{ width: W * scale, height: H * scale, background }}
          >
            {items.map((it, index) => {
              const isSel = it.id === selectedId;
              return (
                <div
                  key={it.id}
                  data-testid="vb-item"
                  data-selected={isSel || undefined}
                  onPointerDown={(e) => startDrag(e, it, "move")}
                  className={`absolute cursor-move ${isSel ? "outline outline-2 outline-blue-500" : ""}`}
                  style={{
                    left: (it.cx - it.w / 2) * scale,
                    top: (it.cy - it.h / 2) * scale,
                    width: it.w * scale,
                    height: it.h * scale,
                    transform: `rotate(${it.rotation}deg)`,
                    zIndex: index + 1,
                  }}
                >
                  <video
                    ref={(el) => {
                      if (el) videoRefs.current.set(it.id, el);
                    }}
                    data-testid="vb-video"
                    src={it.url}
                    playsInline
                    preload="auto"
                    className="pointer-events-none block h-full w-full object-fill"
                  />
                  {isSel && (
                    <>
                      <span
                        data-testid="vb-resize"
                        aria-label="大きさを変える"
                        onPointerDown={(e) => startDrag(e, it, "resize")}
                        className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border-2 border-white bg-blue-600 shadow"
                      />
                      <span
                        data-testid="vb-rotate"
                        aria-label="回転する"
                        onPointerDown={(e) => startDrag(e, it, "rotate")}
                        className="absolute -top-6 left-1/2 h-4 w-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-white bg-blue-600 shadow"
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="vb-play"
            onClick={togglePlay}
            className="inline-flex min-w-28 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
            {playing ? "一時停止" : "同時に再生"}
          </button>
          <input
            type="range"
            aria-label="再生位置"
            data-testid="vb-seek"
            min={0}
            max={Math.max(0.1, total)}
            step={0.05}
            value={Math.min(time, total)}
            onChange={(e) => seek(Number(e.target.value))}
            className="min-w-32 flex-1"
          />
          <span data-testid="vb-time" className="font-mono text-xs text-neutral-600 dark:text-neutral-300">
            {fmt(time)} / {fmt(total)}
          </span>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          動画を選ぶと、右下の四角で大きさ、上の丸で向きを変えられます。キャンバスの外にはみ出した部分は、書き出す動画に入りません。
        </p>
      </section>
    ) : null;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={items.length > 0}
        compactAction="add"
        accept={VIDEO_INPUT_ACCEPT}
        multiple
        maxSizeMB={VIDEO_DROPZONE_MAX_MB}
        label={`動画をドラッグ&ドロップ（${BOARD_MAX_VIDEOS}本まで）`}
        hint="またはタップして選択（MP4 / MOV / WebM）"
        onFilesSelected={(files) => void handleSelect(files)}
        onError={setError}
      />
      {loading && <p className="text-sm text-neutral-500 dark:text-neutral-400">動画を読み込んでいます…</p>}
      {error && <ErrorMessage message={error} />}

      {items.length > 0 && (
        <PreviewSplitLayout previewWidth="lg" mobileSticky preview={preview}>
          <SettingsStack>
            <SettingsSection title="キャンバスの形" testId="vb-shape-section">
              <Segmented ariaLabel="キャンバスの形" size="sm" testId="vb-shape" value={shape} onChange={changeShape} options={shapeOptions} />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                書き出す大きさ：{W}×{H}。形を変えると、動画を並べ直します。
              </p>
              <label className="flex items-center gap-2 text-sm">
                背景の色
                <input type="color" data-testid="vb-background" value={background} onChange={(e) => { setBackground(e.target.value); clearResult(); }} className="h-8 w-12" />
              </label>
            </SettingsSection>

            <SettingsSection title={`置いた動画（${items.length}本）`} testId="vb-items-section">
              <button
                type="button"
                data-testid="vb-arrange"
                onClick={() => update(arrange(items))}
                className="w-fit rounded-lg bg-neutral-100 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
              >
                自動で並べる
              </button>
              <ol className="flex flex-col gap-2" data-testid="vb-list">
                {items.map((it, i) => (
                  <li
                    key={it.id}
                    data-testid="vb-row"
                    onPointerDown={() => setSelectedId(it.id)}
                    className={`flex flex-col gap-1.5 rounded-lg border p-2 text-sm ${it.id === selectedId ? "border-blue-400 ring-1 ring-blue-300" : "border-neutral-200 dark:border-neutral-800"}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-5 font-semibold text-neutral-500">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={it.file.name}>
                        {it.file.name}
                      </span>
                      <span className="text-xs text-neutral-500">{fmt(it.duration)}</span>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-200">
                      音量
                      {it.hasAudio ? (
                        <>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            data-testid="vb-volume"
                            aria-label={`${i + 1}番目の動画の音量`}
                            value={it.volume}
                            onChange={(e) => patch(it.id, { volume: Number(e.target.value) })}
                            className="flex-1"
                          />
                          <span className="w-10 text-right">{it.volume}%</span>
                        </>
                      ) : (
                        <span className="text-neutral-500">（音声のない動画）</span>
                      )}
                    </label>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <button type="button" data-testid="vb-front" onClick={() => moveOrder(it.id, 1)} disabled={i === items.length - 1} className="rounded bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800">
                        前面へ
                      </button>
                      <button type="button" data-testid="vb-back" onClick={() => moveOrder(it.id, -1)} disabled={i === 0} className="rounded bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800">
                        背面へ
                      </button>
                      <button type="button" data-testid="vb-reset-rotation" onClick={() => patch(it.id, { rotation: 0 })} disabled={it.rotation === 0} className="rounded bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800">
                        向きを戻す
                      </button>
                      <button type="button" data-testid="vb-remove" onClick={() => removeItem(it.id)} className="rounded bg-red-50 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                        外す
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              {selected && <p className="text-xs text-neutral-500 dark:text-neutral-400">選んだ動画：{selected.file.name}（Delete キーでも外せます）</p>}
            </SettingsSection>

            <SettingsSection title="書き出し" testId="vb-output">
              <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="vb-length">
                長さ：{fmt(total)}（いちばん長い動画に合わせます。音はすべての動画の音を混ぜます）
              </p>
              <Segmented
                label="短い動画が終わったら"
                size="sm"
                testId="vb-end"
                value={endBehavior}
                onChange={(v) => { setEndBehavior(v); clearResult(); }}
                options={[
                  { value: "hold", label: "最後の場面で止める" },
                  { value: "loop", label: "くり返す" },
                ]}
              />
              <fieldset className="flex flex-wrap items-center gap-3 text-sm">
                <legend className="mb-1 text-xs text-neutral-600 dark:text-neutral-300">出力形式</legend>
                {OUTPUT_CONTAINER_OPTIONS.filter((o) => o.value === "mp4" || o.value === "webm").map((o) => (
                  <label key={o.value} className="flex items-center gap-1">
                    <input type="radio" name="vb-container" data-testid={`vb-container-${o.value}`} checked={container === o.value} onChange={() => { setContainer(o.value); clearResult(); }} />
                    {o.label}
                  </label>
                ))}
              </fieldset>
              {tooLong && (
                <p data-testid="vb-too-long" className="text-xs font-semibold text-red-700 dark:text-red-300">
                  書き出せる長さは{BOARD_MAX_SECONDS / 60}分までです。長い動画は、動画カット・結合で短くしてからお試しください。
                </p>
              )}
            </SettingsSection>
          </SettingsStack>
          <RunBar>
            <button
              type="button"
              data-testid="vb-run"
              onClick={() => void handleRun()}
              disabled={busy || tooLong}
              aria-busy={busy || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              動画を書き出す
            </button>
          </RunBar>
        </PreviewSplitLayout>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`動画を書き出しています… ${Math.round(progress * 100)}%`}
        successLabel="書き出しが完了しました"
        onCancel={() => {
          setCanceling(true);
          cancelRef.current?.abort();
        }}
        canceling={canceling}
        cancelTestId="vb-cancel"
      />

      {result && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <p data-testid="vb-result" className="text-sm text-neutral-700 dark:text-neutral-200">
            {result.width}×{result.height}・{fmt(result.durationSec)}・{result.hasAudio ? "音声あり" : "音声なし"}・{formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, `動画ホワイトボード.${container === "webm" ? "webm" : "mp4"}`)}
            label="ダウンロード"
          />
        </ResultPopup>
      )}
    </div>
  );
}
