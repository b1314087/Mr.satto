"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils/cn";
import { sequenceStarts, snapTime } from "@/lib/video/cut-segments";
import { SNAP_PX, TIMELINE_ZOOM, TimelineToolbar } from "@/components/common/timeline-toolbar";

/**
 * 動画編集ソフトのような「1本のトラック」のタイムライン（2026-11）。
 *
 * - 区間（クリップ）は、順番どおりに隙間なく並ぶ。目盛りは「つないだあとの時間」。
 * - 区間の右端・左端をドラッグして長さを変えると、うしろの区間が自動で詰まる（左端は、離したときに詰まる）。
 * - 区間の真ん中をドラッグすると、順番を入れ替えられる（入る場所に青い線が出る）。押すだけなら選択。
 * - 拡大・縮小（バー・＋－）で横に広げて、細かく操作できる。広げているときは、再生位置が見えるように自動でスクロールする。
 * - 磁石（オン・オフ）：端を動かすと、再生位置・ほかの区間の境目の近くで吸い付く（黄色い線が出る）。
 *   再生位置を動かすときも、区間の境目に吸い付く。
 * - 削除する範囲を選ぶ行（任意）：ドラッグで範囲を選ぶ（端は境目・再生位置に吸い付く）。
 */
export interface SequenceClip {
  id: string;
  label: string;
  /** 元の動画の、使う範囲（秒） */
  start: number;
  end: number;
  /** 元の動画の長さ（秒）。右端をのばせる上限 */
  sourceDuration: number;
  text?: string;
  colorClass?: string;
}

type Drag =
  | { kind: "trim-start" | "trim-end"; index: number; start0: number; end0: number; frozenTotal: number }
  | { kind: "move"; index: number; x0: number; moved: boolean; to: number };

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
const round = (t: number) => Math.round(t * 1000) / 1000;

export function SequenceTimeline({
  clips,
  currentTime,
  onSeek,
  selectedId,
  onSelect,
  onTrim,
  onReorder,
  onDelete,
  minLength = 0.1,
  testId = "sequence",
  clipTestId = "sequence-clip",
  selection,
  onSelectionChange,
  selectionLabel = "削除する範囲",
}: {
  clips: SequenceClip[];
  /** つないだあとの時間で見た、再生位置（秒） */
  currentTime: number;
  onSeek: (t: number) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** 区間の使う範囲（元の動画の秒）を変えた */
  onTrim: (id: string, start: number, end: number) => void;
  onReorder?: (from: number, to: number) => void;
  /** 選んだ区間で Delete・Backspace を押した */
  onDelete?: (id: string) => void;
  minLength?: number;
  testId?: string;
  clipTestId?: string;
  selection?: { start: number; end: number } | null;
  onSelectionChange?: (range: { start: number; end: number } | null) => void;
  selectionLabel?: string;
}) {
  const [zoom, setZoom] = useState<number>(TIMELINE_ZOOM.min);
  const [snapOn, setSnapOn] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guide, setGuide] = useState<number | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seekingRef = useRef(false);
  const selectRef = useRef<{ t0: number; x0: number } | null>(null);

  const lens = clips.map((c) => Math.max(0, c.end - c.start));
  const starts = sequenceStarts(clips);
  const total = starts[starts.length - 1];
  // 左端を動かしている間は、その区間とうしろの区間を「動かしたぶん」ずらして表示し、離したときに詰める
  const leadOffset = drag?.kind === "trim-start" ? clips[drag.index] ? clips[drag.index].start - drag.start0 : 0 : 0;
  const shown = (k: number) => starts[k] + (drag?.kind === "trim-start" && k >= drag.index ? leadOffset : 0);
  const D = Math.max(0.001, drag && drag.kind !== "move" ? Math.max(drag.frozenTotal, total + Math.max(0, leadOffset)) : total);
  const pct = (t: number) => `${(Math.min(D, Math.max(0, t)) / D) * 100}%`;

  // 目盛り：表示している幅（倍率）に合わせて、画面の幅あたり 5〜10本程度
  const visibleSec = D / (zoom / 100);
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => visibleSec / s <= 10) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= D + 1e-6 && ticks.length < 2000; t += step) ticks.push(round(t));

  // 拡大しているときは、再生位置が見えるように横にスクロールする（ドラッグ中は動かさない）
  useEffect(() => {
    const sc = scrollRef.current;
    const inner = innerRef.current;
    if (!sc || !inner || drag || zoom <= TIMELINE_ZOOM.min) return;
    const x = (Math.min(D, Math.max(0, currentTime)) / D) * inner.scrollWidth;
    if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3);
  }, [currentTime, zoom, D, drag]);

  function timeAt(clientX: number): { t: number; threshold: number } {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return { t: 0, threshold: 0 };
    return { t: Math.min(D, Math.max(0, ((clientX - r.left) / r.width) * D)), threshold: (SNAP_PX / r.width) * D };
  }
  function snapped(t: number, threshold: number, candidates: number[]): number {
    if (!snapOn) {
      setGuide(null);
      return t;
    }
    const r = snapTime(t, candidates, threshold);
    setGuide(r.snappedTo);
    return r.t;
  }

  function seekAt(clientX: number) {
    const { t, threshold } = timeAt(clientX);
    onSeek(round(snapped(t, threshold, starts)));
  }

  function beginTrim(e: ReactPointerEvent<HTMLElement>, index: number, kind: "trim-start" | "trim-end") {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect?.(clips[index].id);
    setDrag({ kind, index, start0: clips[index].start, end0: clips[index].end, frozenTotal: total });
  }

  function moveTrim(e: ReactPointerEvent<HTMLElement>) {
    if (!drag || drag.kind === "move") return;
    const c = clips[drag.index];
    if (!c) return;
    const { t, threshold } = timeAt(e.clientX);
    // 吸い付く先：再生位置・この区間より前の境目・選んだ範囲の端
    const candidates = [currentTime, ...starts.slice(0, drag.index + 1), ...(selection ? [selection.start, selection.end] : [])];
    if (drag.kind === "trim-end") {
      const edge = snapped(t, threshold, candidates);
      const end = Math.min(c.sourceDuration, Math.max(c.start + minLength, c.start + (edge - starts[drag.index])));
      onTrim(c.id, c.start, round(end));
    } else {
      const edge = snapped(t, threshold, candidates);
      const start = Math.min(drag.end0 - minLength, Math.max(0, drag.start0 + (edge - starts[drag.index])));
      onTrim(c.id, round(start), c.end);
    }
  }

  function endDrag() {
    if (drag?.kind === "move" && drag.moved && drag.to !== drag.index) onReorder?.(drag.index, drag.to);
    setDrag(null);
    setGuide(null);
  }

  function beginMove(e: ReactPointerEvent<HTMLElement>, index: number) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect?.(clips[index].id);
    setDrag({ kind: "move", index, x0: e.clientX, moved: false, to: index });
  }

  function moveMove(e: ReactPointerEvent<HTMLElement>) {
    if (!drag || drag.kind !== "move" || !onReorder) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
    const { t } = timeAt(e.clientX);
    // ドラッグしている区間を除いた並びで、真ん中が手前にある区間の数 = 入る場所
    let to = 0;
    clips.forEach((_, k) => {
      if (k === drag.index) return;
      if (starts[k] + lens[k] / 2 < t) to++;
    });
    setDrag({ ...drag, moved: true, to });
  }

  function keyNudge(e: KeyboardEvent<HTMLElement>, index: number, side: "start" | "end") {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const c = clips[index];
    const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
    if (side === "start") onTrim(c.id, round(Math.min(c.end - minLength, Math.max(0, c.start + d))), c.end);
    else onTrim(c.id, c.start, round(Math.max(c.start + minLength, Math.min(c.sourceDuration, c.end + d))));
  }

  // 並べ替えの「入る場所」の線（元の並びでの境目の位置）
  const insertAt = drag?.kind === "move" && drag.moved && drag.to !== drag.index ? (drag.to < drag.index ? starts[drag.to] : starts[drag.to + 1]) : null;

  return (
    <div className="flex min-w-0 flex-col gap-2 select-none" data-testid={testId}>
      <TimelineToolbar zoom={zoom} onZoom={setZoom} snap={snapOn} onSnap={setSnapOn} testId={testId} />
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2">
        {/* 左の見出しの列 */}
        <div className="flex flex-col gap-1 pt-0">
          <span className="flex h-7 items-end text-[10px] text-neutral-500 dark:text-neutral-400">時間</span>
          {onSelectionChange && <span className="flex h-8 items-center text-[10px] leading-tight text-red-600 dark:text-red-400">{selectionLabel}</span>}
          <span className="flex h-12 items-center text-[10px] leading-tight text-neutral-600 dark:text-neutral-300">つないだ結果</span>
        </div>
        {/* 横にスクロールできる、タイムラインの本体（拡大すると幅が広がる） */}
        <div ref={scrollRef} className="min-w-0 overflow-x-auto pb-1" data-testid={`${testId}-scroll`}>
          <div ref={innerRef} className="relative flex flex-col gap-1" style={{ width: `${zoom}%` }} data-testid={`${testId}-inner`}>
            <div
              className="relative h-7 cursor-pointer touch-none rounded-md bg-neutral-100 dark:bg-neutral-800"
              data-testid={`${testId}-ruler`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seekingRef.current = true;
                seekAt(e.clientX);
              }}
              onPointerMove={(e) => seekingRef.current && seekAt(e.clientX)}
              onPointerUp={() => {
                seekingRef.current = false;
                setGuide(null);
              }}
              onPointerCancel={() => {
                seekingRef.current = false;
                setGuide(null);
              }}
              role="slider"
              aria-label="再生位置（つないだあとのタイムライン）"
              aria-valuemin={0}
              aria-valuemax={Math.round(total * 10) / 10}
              aria-valuenow={Math.round(currentTime * 10) / 10}
              aria-valuetext={fmt(currentTime)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") onSeek(round(Math.max(0, currentTime - (e.shiftKey ? 1 : 0.1))));
                if (e.key === "ArrowRight") onSeek(round(Math.min(total, currentTime + (e.shiftKey ? 1 : 0.1))));
              }}
            >
              {ticks.map((t) => (
                <span key={t} className="pointer-events-none absolute bottom-0 h-2 border-l border-neutral-400 dark:border-neutral-500" style={{ left: pct(t) }}>
                  <span className="absolute -top-4 left-0.5 whitespace-nowrap text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">{fmt(t)}</span>
                </span>
              ))}
            </div>

            {onSelectionChange && (
              <div
                className="relative h-8 cursor-crosshair touch-none rounded-md border border-dashed border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/20"
                data-testid={`${testId}-select`}
                aria-label={`${selectionLabel}（ドラッグで範囲を選ぶ）`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const { t, threshold } = timeAt(e.clientX);
                  selectRef.current = { t0: snapped(t, threshold, [...starts, currentTime]), x0: e.clientX };
                  onSelectionChange(null);
                }}
                onPointerMove={(e) => {
                  const st = selectRef.current;
                  if (!st || Math.abs(e.clientX - st.x0) < 3) return;
                  const { t, threshold } = timeAt(e.clientX);
                  const tt = snapped(t, threshold, [...starts, currentTime]);
                  onSelectionChange({ start: round(Math.min(st.t0, tt)), end: round(Math.max(st.t0, tt)) });
                }}
                onPointerUp={() => {
                  selectRef.current = null;
                  setGuide(null);
                }}
                onPointerCancel={() => {
                  selectRef.current = null;
                  setGuide(null);
                }}
              >
                {selection && selection.end > selection.start && (
                  <span
                    className="pointer-events-none absolute inset-y-0.5 rounded bg-red-500/40 ring-1 ring-red-500"
                    style={{ left: pct(selection.start), width: pct(selection.end - selection.start) }}
                    data-testid={`${testId}-selection`}
                  />
                )}
              </div>
            )}

            <div className="relative h-12 rounded-md bg-neutral-50 dark:bg-neutral-900" data-testid={`${testId}-track`}>
              {clips.map((c, k) => {
                const selected = c.id === selectedId;
                const dragging = drag?.kind === "move" && drag.moved && drag.index === k;
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${c.label}：元の動画の${fmt(c.start)}〜${fmt(c.end)}（ドラッグで順番を変える）`}
                    data-testid={clipTestId}
                    data-clip-id={c.id}
                    className={cn(
                      "absolute inset-y-1 flex cursor-grab touch-none items-center overflow-hidden rounded-md border border-white/70 text-[11px] text-white shadow-sm active:cursor-grabbing dark:border-neutral-900/70",
                      c.colorClass ?? (k % 2 === 0 ? "bg-emerald-600" : "bg-teal-600"),
                      selected && "ring-2 ring-yellow-300 ring-offset-1 dark:ring-offset-neutral-900",
                      dragging && "opacity-60"
                    )}
                    style={{ left: pct(shown(k)), width: pct(lens[k]) }}
                    onPointerDown={(e) => beginMove(e, k)}
                    onPointerMove={moveMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onKeyDown={(e) => {
                      if ((e.key === "Delete" || e.key === "Backspace") && onDelete) {
                        e.preventDefault();
                        onDelete(c.id);
                      }
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect?.(c.id);
                      }
                    }}
                  >
                    <span
                      role="slider"
                      tabIndex={0}
                      aria-label={`${c.label}の開始`}
                      aria-valuemin={0}
                      aria-valuemax={Math.round(c.end * 10) / 10}
                      aria-valuenow={Math.round(c.start * 10) / 10}
                      aria-valuetext={fmt(c.start)}
                      className="absolute inset-y-0 left-0 z-10 flex w-4 cursor-ew-resize items-center justify-center bg-black/25 focus-visible:outline-2 focus-visible:outline-white"
                      onPointerDown={(e) => beginTrim(e, k, "trim-start")}
                      onPointerMove={moveTrim}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onKeyDown={(e) => keyNudge(e, k, "start")}
                      data-testid={`${clipTestId}-start`}
                    >
                      <span className="h-5 w-0.5 rounded bg-white/90" />
                    </span>
                    <span className="pointer-events-none min-w-0 truncate px-5">{c.text ?? c.label}</span>
                    <span
                      role="slider"
                      tabIndex={0}
                      aria-label={`${c.label}の終了`}
                      aria-valuemin={Math.round(c.start * 10) / 10}
                      aria-valuemax={Math.round(c.sourceDuration * 10) / 10}
                      aria-valuenow={Math.round(c.end * 10) / 10}
                      aria-valuetext={fmt(c.end)}
                      className="absolute inset-y-0 right-0 z-10 flex w-4 cursor-ew-resize items-center justify-center bg-black/25 focus-visible:outline-2 focus-visible:outline-white"
                      onPointerDown={(e) => beginTrim(e, k, "trim-end")}
                      onPointerMove={moveTrim}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onKeyDown={(e) => keyNudge(e, k, "end")}
                      data-testid={`${clipTestId}-end`}
                    >
                      <span className="h-5 w-0.5 rounded bg-white/90" />
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 再生位置の線（全部の行を通る）・磁石で吸い付いた位置の線・並べ替えで入る場所の線 */}
            <span className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-red-500" style={{ left: pct(currentTime) }} data-testid={`${testId}-playhead`} />
            {guide !== null && (
              <span className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-yellow-400" style={{ left: pct(guide) }} data-testid={`${testId}-guide`} />
            )}
            {insertAt !== null && (
              <span className="pointer-events-none absolute inset-y-0 z-20 w-1 -translate-x-1/2 rounded bg-blue-500" style={{ left: pct(insertAt) }} data-testid={`${testId}-insert`} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
