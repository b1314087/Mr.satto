"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils/cn";
import { resolveOverlaps, snapTime, timelineEnd, type TimelineClip } from "@/lib/video/cut-segments";
import { SNAP_PX, TIMELINE_ZOOM, TimelineToolbar } from "@/components/common/timeline-toolbar";

/**
 * 動画編集ソフトのような、クリップを並べるトラック（2026-11）。
 *
 * - クリップは、真ん中をドラッグして好きな位置に置ける。離して置くと、間に空白ができる（書き出すと黒い画面・無音）。
 *   ほかのクリップに重ねて離すと、うしろのクリップを右へ押し出す。
 * - 端をドラッグすると、使う範囲（長さ）を変えられる。
 * - 磁石（オン・オフ）：動かしている端が、ほかのクリップの端・再生ヘッドの近くで吸い付く（黄色いガイド線）。
 *   再生ヘッドを動かすときも、クリップの端に吸い付く。
 * - 拡大・縮小（バー・＋－）で、時間軸を横に広げて細かく操作できる。拡大中は、再生ヘッドが見えるように自動でスクロールする。
 * - クリップを押すと選択。選んだクリップは Delete・Backspace でも削除できる。
 * - ドラッグを始めたとき onEditStart を呼ぶ（取り消し（Undo）の記録を、ドラッグ1回につき1つにするため）。
 */
export interface SequenceClip extends TimelineClip {
  label: string;
  /** 元の動画の長さ（秒）。右端をのばせる上限 */
  sourceDuration: number;
  text?: string;
  colorClass?: string;
}

type Drag = {
  kind: "move" | "trim-start" | "trim-end";
  index: number;
  x0: number;
  at0: number;
  start0: number;
  end0: number;
  frozenD: number;
  moved: boolean;
};

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
const round = (t: number) => Math.round(t * 1000) / 1000;
const lenOf = (c: { start: number; end: number }) => Math.max(0, c.end - c.start);

export function SequenceTimeline({
  clips,
  currentTime,
  onSeek,
  selectedId,
  onSelect,
  onChange,
  onEditStart,
  onDelete,
  minLength = 0.1,
  testId = "sequence",
  clipTestId = "sequence-clip",
}: {
  clips: SequenceClip[];
  /** タイムライン上の再生ヘッドの位置（秒） */
  currentTime: number;
  onSeek: (t: number) => void;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  /** クリップの位置・使う範囲を変えた（ドラッグ中も呼ぶ） */
  onChange: (clips: TimelineClip[]) => void;
  onEditStart?: () => void;
  onDelete?: (id: number) => void;
  minLength?: number;
  testId?: string;
  clipTestId?: string;
}) {
  const [zoom, setZoom] = useState<number>(TIMELINE_ZOOM.min);
  const [snapOn, setSnapOn] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [guide, setGuide] = useState<number | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seekingRef = useRef(false);

  const end = timelineEnd(clips);
  // うしろへ動かせるよう、終わりのあとに少し余白をとる。ドラッグ中は目盛りの幅を変えない
  const naturalD = Math.max(1, end * 1.2, end + 1, currentTime);
  // ドラッグ中は目盛りの幅を固定する（途中で縮尺が変わると、ポインターとクリップの位置がずれ、吸い付きもずれるため）
  const D = drag ? drag.frozenD : naturalD;
  // 位置は目盛りの外（右）にはみ出しても描く（ドラッグで終わりより右へ動かすとき）
  const pct = (t: number) => `${(Math.max(0, t) / D) * 100}%`;

  const visibleSec = D / (zoom / 100);
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => visibleSec / s <= 10) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= D + 1e-6 && ticks.length < 2000; t += step) ticks.push(round(t));

  useEffect(() => {
    const sc = scrollRef.current;
    const inner = innerRef.current;
    if (!sc || !inner || drag || zoom <= TIMELINE_ZOOM.min) return;
    const x = (Math.min(D, Math.max(0, currentTime)) / D) * inner.scrollWidth;
    if (x < sc.scrollLeft + 24 || x > sc.scrollLeft + sc.clientWidth - 24) sc.scrollLeft = Math.max(0, x - sc.clientWidth / 3);
  }, [currentTime, zoom, D, drag]);

  function geom(clientX: number): { t: number; threshold: number; secPerPx: number } {
    const r = innerRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return { t: 0, threshold: 0, secPerPx: 0 };
    return { t: Math.min(D, Math.max(0, ((clientX - r.left) / r.width) * D)), threshold: (SNAP_PX / r.width) * D, secPerPx: D / r.width };
  }
  /** 吸い付く先：ほかのクリップの端・再生ヘッド・タイムラインの最初 */
  function edges(exceptIndex: number): number[] {
    const out = [0];
    clips.forEach((c, k) => {
      if (k !== exceptIndex) out.push(c.at, c.at + lenOf(c));
    });
    return out;
  }

  function seekAt(clientX: number) {
    const { t, threshold } = geom(clientX);
    if (!snapOn) {
      setGuide(null);
      onSeek(round(t));
      return;
    }
    const r = snapTime(t, edges(-1), threshold);
    setGuide(r.snappedTo);
    onSeek(round(r.t));
  }

  function begin(e: ReactPointerEvent<HTMLElement>, index: number, kind: Drag["kind"]) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const c = clips[index];
    onSelect?.(c.id);
    setDrag({ kind, index, x0: e.clientX, at0: c.at, start0: c.start, end0: c.end, frozenD: naturalD, moved: false });
  }

  function move(e: ReactPointerEvent<HTMLElement>) {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return;
    if (!drag.moved) {
      onEditStart?.();
      setDrag({ ...drag, moved: true });
    }
    const c = clips[drag.index];
    if (!c) return;
    const { threshold, secPerPx } = geom(e.clientX);
    const dt = (e.clientX - drag.x0) * secPerPx;
    const cands = [...edges(drag.index), currentTime];
    const snap = (t: number) => (snapOn ? snapTime(t, cands, threshold) : { t, snappedTo: null });
    let next: TimelineClip = c;
    if (drag.kind === "move") {
      const len = lenOf(c);
      let at = Math.max(0, drag.at0 + dt);
      // 左端・右端のうち、近いほうを吸い付ける
      const a = snap(at);
      const b = snap(at + len);
      const da = a.snappedTo === null ? Infinity : Math.abs(a.t - at);
      const db = b.snappedTo === null ? Infinity : Math.abs(b.t - (at + len));
      if (da <= db && a.snappedTo !== null) {
        at = a.t;
        setGuide(a.snappedTo);
      } else if (b.snappedTo !== null) {
        at = b.t - len;
        setGuide(b.snappedTo);
      } else setGuide(null);
      next = { ...c, at: round(Math.max(0, at)) };
    } else if (drag.kind === "trim-end") {
      const r = snap(drag.at0 + (drag.end0 - drag.start0) + dt);
      setGuide(r.snappedTo);
      const endSrc = Math.min((c as SequenceClip).sourceDuration, Math.max(c.start + minLength, c.start + (r.t - c.at)));
      next = { ...c, end: round(endSrc) };
    } else {
      // 左端：右端の位置は変えずに、使い始めの位置を変える（前のクリップには重ならない）
      const prevEnd = clips.reduce((m, o, k) => (k !== drag.index && o.at + lenOf(o) <= drag.at0 + 1e-6 ? Math.max(m, o.at + lenOf(o)) : m), 0);
      const r = snap(drag.at0 + dt);
      setGuide(r.snappedTo);
      const minStart = Math.max(0, drag.start0 - (drag.at0 - prevEnd));
      const startSrc = Math.min(drag.end0 - minLength, Math.max(minStart, drag.start0 + (r.t - drag.at0)));
      next = { ...c, start: round(startSrc), at: round(drag.at0 + (startSrc - drag.start0)) };
    }
    onChange(clips.map((o, k) => (k === drag.index ? next : o)));
  }

  function end_() {
    if (drag?.moved) onChange(resolveOverlaps(clips));
    setDrag(null);
    setGuide(null);
  }

  function keyNudge(e: KeyboardEvent<HTMLElement>, index: number, side: "start" | "end") {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const c = clips[index];
    const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
    onEditStart?.();
    let next: TimelineClip;
    if (side === "start") {
      const start = round(Math.min(c.end - minLength, Math.max(0, c.start + d)));
      next = { ...c, start, at: round(Math.max(0, c.at + (start - c.start))) };
    } else next = { ...c, end: round(Math.max(c.start + minLength, Math.min(c.sourceDuration, c.end + d))) };
    onChange(resolveOverlaps(clips.map((o, k) => (k === index ? next : o))));
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 select-none" data-testid={testId}>
      <TimelineToolbar zoom={zoom} onZoom={setZoom} snap={snapOn} onSnap={setSnapOn} testId={testId} />
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2">
        <div className="flex flex-col gap-1">
          <span className="flex h-7 items-end text-[10px] text-neutral-500 dark:text-neutral-400">時間</span>
          <span className="flex h-12 items-center text-[10px] leading-tight text-neutral-600 dark:text-neutral-300">クリップ</span>
        </div>
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
              aria-label="再生ヘッド（タイムライン）"
              aria-valuemin={0}
              aria-valuemax={Math.round(D * 10) / 10}
              aria-valuenow={Math.round(currentTime * 10) / 10}
              aria-valuetext={fmt(currentTime)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") onSeek(round(Math.max(0, currentTime - (e.shiftKey ? 1 : 0.1))));
                if (e.key === "ArrowRight") onSeek(round(Math.min(D, currentTime + (e.shiftKey ? 1 : 0.1))));
              }}
            >
              {ticks.map((t) => (
                <span key={t} className="pointer-events-none absolute bottom-0 h-2 border-l border-neutral-400 dark:border-neutral-500" style={{ left: pct(t) }}>
                  <span className="absolute -top-4 left-0.5 whitespace-nowrap text-[10px] tabular-nums text-neutral-500 dark:text-neutral-400">{fmt(t)}</span>
                </span>
              ))}
            </div>

            <div className="relative h-12 rounded-md bg-neutral-50 dark:bg-neutral-900" data-testid={`${testId}-track`}>
              {clips.map((c, k) => {
                const selected = c.id === selectedId;
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    aria-label={`${c.label}：${fmt(c.at)}から（元の動画の${fmt(c.start)}〜${fmt(c.end)}）。ドラッグで移動`}
                    data-testid={clipTestId}
                    data-clip-id={c.id}
                    className={cn(
                      "absolute inset-y-1 flex cursor-grab touch-none items-center overflow-hidden rounded-md border border-white/70 text-[11px] text-white shadow-sm active:cursor-grabbing dark:border-neutral-900/70",
                      c.colorClass ?? (k % 2 === 0 ? "bg-emerald-600" : "bg-teal-600"),
                      selected && "ring-2 ring-yellow-300 ring-offset-1 dark:ring-offset-neutral-900",
                      drag?.moved && drag.index === k && "opacity-80"
                    )}
                    style={{ left: pct(c.at), width: pct(lenOf(c)) }}
                    onPointerDown={(e) => begin(e, k, "move")}
                    onPointerMove={move}
                    onPointerUp={end_}
                    onPointerCancel={end_}
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
                      onPointerDown={(e) => begin(e, k, "trim-start")}
                      onPointerMove={move}
                      onPointerUp={end_}
                      onPointerCancel={end_}
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
                      onPointerDown={(e) => begin(e, k, "trim-end")}
                      onPointerMove={move}
                      onPointerUp={end_}
                      onPointerCancel={end_}
                      onKeyDown={(e) => keyNudge(e, k, "end")}
                      data-testid={`${clipTestId}-end`}
                    >
                      <span className="h-5 w-0.5 rounded bg-white/90" />
                    </span>
                  </div>
                );
              })}
            </div>

            <span className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-red-500" style={{ left: pct(currentTime) }} data-testid={`${testId}-playhead`} />
            {guide !== null && (
              <span className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-yellow-400" style={{ left: pct(guide) }} data-testid={`${testId}-guide`} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
