"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils/cn";
import { snapTime } from "@/lib/video/cut-segments";
import { SNAP_PX, TIMELINE_ZOOM, TimelineToolbar } from "@/components/common/timeline-toolbar";

/**
 * 動画編集ソフトのようなタイムライン（総合改修 11・30）。
 *
 * - いちばん上の目盛りの行で、再生位置をクリック・ドラッグして動かせる（再生位置は縦の線で全体に出る）。
 * - 行（字幕・残す区間など）ごとに独立したバーを出す。バーの真ん中をドラッグすると長さを保ったまま移動、
 *   左右の端をドラッグすると開始・終了だけを変えられる。数字を入れなくても、ドラッグで表示時間・区間を調整できる。
 * - 端（つまみ）にはキーボードでも触れられる（←→で0.1秒、Shiftを押しながらで1秒）。
 * - スマホでも指で動かせるよう、つまみの当たり判定を広めにしている。
 * - 2026-11：拡大・縮小（バー・＋－）で横に広げて細かく操作できる（横にスクロール。行の名前は左に残る）。
 *   磁石（オン・オフ）：バーを動かすと、ほかの行のバーの端・再生位置・最初・最後の近くで吸い付く（黄色い線）。
 *   再生位置を動かすときも、バーの端に吸い付く。
 */
export interface TimelineRow {
  id: string;
  /** 行の左に出す短い名前（例：「1」「字幕2」） */
  label: string;
  start: number;
  end: number;
  /** バーの中に出す文字（字幕の文字など） */
  text?: string;
  selected?: boolean;
  /** バーの色（Tailwind のクラス）。既定は青 */
  colorClass?: string;
}

type DragKind = "move" | "start" | "end";
interface DragState {
  id: string;
  kind: DragKind;
  x0: number;
  start0: number;
  end0: number;
  laneWidth: number;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function VideoTimeline({
  duration,
  currentTime,
  onSeek,
  rows,
  onChange,
  onSelect,
  minLength = 0.1,
  testId = "timeline",
  rowTestId = "timeline-row",
  emptyText,
  selection,
  onSelectionChange,
  selectionLabel = "範囲を選ぶ",
  tools = true,
}: {
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
  rows: TimelineRow[];
  onChange: (id: string, start: number, end: number) => void;
  onSelect?: (id: string) => void;
  /** バーの最短の長さ（秒） */
  minLength?: number;
  testId?: string;
  rowTestId?: string;
  emptyText?: string;
  /**
   * 範囲を選ぶ行（任意）。ドラッグした範囲を選ぶ（動画カットの「削除する範囲」など）。
   * onSelectionChange を渡したときだけ出る。
   */
  selection?: { start: number; end: number } | null;
  onSelectionChange?: (range: { start: number; end: number } | null) => void;
  selectionLabel?: string;
  /** 拡大・縮小と磁石の切り替えを出す（既定：出す） */
  tools?: boolean;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [zoom, setZoom] = useState<number>(TIMELINE_ZOOM.min);
  const [snapOn, setSnapOn] = useState(true);
  const [guide, setGuide] = useState<number | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const seekingRef = useRef(false);
  const selectRef = useRef<{ x0: number; t0: number; left: number; width: number } | null>(null);
  const D = Math.max(0.001, duration);
  const pct = (t: number) => `${(Math.min(D, Math.max(0, t)) / D) * 100}%`;
  const round = (t: number) => Math.round(t * 1000) / 1000;

  // 目盛り：表示している幅（倍率）に合わせて、画面の幅あたり 5〜10本程度になる間隔
  const visibleSec = D / (zoom / 100);
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => visibleSec / s <= 10) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= D + 1e-6; t += step) ticks.push(t);

  // 磁石：吸い付く先（ほかの行のバーの端・最初・最後。exceptId の行は除く）
  function edgesExcept(exceptId?: string): number[] {
    const out = [0, D];
    for (const r of rows) if (r.id !== exceptId) out.push(r.start, r.end);
    return out;
  }
  function snapped(t: number, widthPx: number, candidates: number[]): number {
    if (!snapOn || widthPx <= 0) {
      setGuide(null);
      return t;
    }
    const r = snapTime(t, candidates, (SNAP_PX / widthPx) * D);
    setGuide(r.snappedTo);
    return r.t;
  }

  function seekFromEvent(e: ReactPointerEvent) {
    const r = rulerRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const t = Math.min(D, Math.max(0, ((e.clientX - r.left) / r.width) * D));
    onSeek(round(snapped(t, r.width, edgesExcept())));
  }

  function beginDrag(e: ReactPointerEvent<HTMLElement>, row: TimelineRow, kind: DragKind) {
    e.preventDefault();
    e.stopPropagation();
    const lane = (e.currentTarget.closest("[data-timeline-lane]") as HTMLElement | null)?.getBoundingClientRect();
    if (!lane || lane.width === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect?.(row.id);
    setDrag({ id: row.id, kind, x0: e.clientX, start0: row.start, end0: row.end, laneWidth: lane.width });
  }

  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    if (!drag) return;
    const dt = ((e.clientX - drag.x0) / drag.laneWidth) * D;
    let s = drag.start0;
    let en = drag.end0;
    const candidates = [...edgesExcept(drag.id), currentTime];
    if (drag.kind === "move") {
      const len = drag.end0 - drag.start0;
      s = Math.min(D - len, Math.max(0, drag.start0 + dt));
      // 左端・右端のうち、近いほうを吸い付ける
      if (snapOn) {
        const th = (SNAP_PX / drag.laneWidth) * D;
        const a = snapTime(s, candidates, th);
        const b = snapTime(s + len, candidates, th);
        const da = a.snappedTo === null ? Infinity : Math.abs(a.t - s);
        const db = b.snappedTo === null ? Infinity : Math.abs(b.t - (s + len));
        if (da <= db && a.snappedTo !== null) {
          s = a.t;
          setGuide(a.snappedTo);
        } else if (b.snappedTo !== null) {
          s = b.t - len;
          setGuide(b.snappedTo);
        } else setGuide(null);
        s = Math.min(D - len, Math.max(0, s));
      }
      en = s + len;
    } else if (drag.kind === "start") {
      s = Math.min(drag.end0 - minLength, Math.max(0, snapped(drag.start0 + dt, drag.laneWidth, candidates)));
    } else {
      en = Math.max(drag.start0 + minLength, Math.min(D, snapped(drag.end0 + dt, drag.laneWidth, candidates)));
    }
    onChange(drag.id, round(s), round(en));
  }
  function stopDrag() {
    setDrag(null);
    setGuide(null);
  }

  function keyNudge(e: KeyboardEvent<HTMLElement>, row: TimelineRow, kind: "start" | "end") {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
    if (kind === "start") onChange(row.id, round(Math.min(row.end - minLength, Math.max(0, row.start + d))), row.end);
    else onChange(row.id, row.start, round(Math.max(row.start + minLength, Math.min(D, row.end + d))));
  }

  return (
    <div className="flex min-w-0 flex-col gap-1 select-none" data-testid={testId}>
      {tools && <TimelineToolbar zoom={zoom} onZoom={setZoom} snap={snapOn} onSnap={setSnapOn} testId={testId} />}
      {/* 拡大すると横に広がり、横にスクロールできる（行の名前の列は左に残る） */}
      <div className="min-w-0 overflow-x-auto pb-1" data-testid={`${testId}-scroll`}>
      <div className="relative flex flex-col gap-1" style={{ width: `calc(3rem + (100% - 3rem) * ${zoom / 100})` }} data-testid={`${testId}-inner`}>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-end gap-2">
        <span className={cn("text-[10px] text-neutral-500 dark:text-neutral-400", STICKY)}>時間</span>
        <div
          ref={rulerRef}
          className="relative h-7 cursor-pointer touch-none rounded-md bg-neutral-100 dark:bg-neutral-800"
          data-testid={`${testId}-ruler`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekingRef.current = true;
            seekFromEvent(e);
          }}
          onPointerMove={(e) => seekingRef.current && seekFromEvent(e)}
          onPointerUp={() => {
            seekingRef.current = false;
            setGuide(null);
          }}
          onPointerCancel={() => {
            seekingRef.current = false;
            setGuide(null);
          }}
          role="slider"
          aria-label="再生位置（タイムライン）"
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
          <span className="pointer-events-none absolute -top-0.5 bottom-0 w-0.5 -translate-x-1/2 bg-red-500" style={{ left: pct(currentTime) }} data-testid={`${testId}-playhead`} />
        </div>
      </div>

      {onSelectionChange && (
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2">
          <span className={cn("text-[10px] leading-tight text-red-600 dark:text-red-400", STICKY)}>{selectionLabel}</span>
          <div
            className="relative h-8 cursor-crosshair touch-none rounded-md border border-dashed border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/20"
            data-testid={`${testId}-select`}
            aria-label={`${selectionLabel}（ドラッグで範囲を選ぶ）`}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (r.width === 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const t0 = snapped(Math.min(D, Math.max(0, ((e.clientX - r.left) / r.width) * D)), r.width, [...edgesExcept(), currentTime]);
              selectRef.current = { x0: e.clientX, t0, left: r.left, width: r.width };
              onSelectionChange(null);
            }}
            onPointerMove={(e) => {
              const st = selectRef.current;
              if (!st) return;
              if (Math.abs(e.clientX - st.x0) < 3) return;
              const t = snapped(Math.min(D, Math.max(0, ((e.clientX - st.left) / st.width) * D)), st.width, [...edgesExcept(), currentTime]);
              onSelectionChange({ start: round(Math.min(st.t0, t)), end: round(Math.max(st.t0, t)) });
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
            <span className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-red-500/70" style={{ left: pct(currentTime) }} />
          </div>
        </div>
      )}

      {rows.length === 0 && emptyText && <p className="pl-12 text-xs text-neutral-500 dark:text-neutral-400">{emptyText}</p>}

      <div className="relative flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2" data-testid={rowTestId} data-row-id={row.id}>
            <button
              type="button"
              onClick={() => onSelect?.(row.id)}
              className={cn("truncate rounded px-1 text-left text-xs", STICKY, row.selected ? "font-bold text-blue-700 dark:text-blue-300" : "text-neutral-600 dark:text-neutral-300")}
              title={row.label}
            >
              {row.label}
            </button>
            <div className="relative h-9 rounded-md bg-neutral-50 dark:bg-neutral-900" data-timeline-lane>
              <span className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-red-500/70" style={{ left: pct(currentTime) }} />
              <div
                className={cn(
                  "absolute inset-y-1 flex cursor-grab touch-none items-center overflow-hidden rounded-md text-[11px] text-white shadow-sm active:cursor-grabbing",
                  row.colorClass ?? "bg-blue-500",
                  row.selected && "ring-2 ring-blue-300 ring-offset-1 dark:ring-offset-neutral-900"
                )}
                style={{ left: pct(row.start), width: pct(row.end - row.start) }}
                onPointerDown={(e) => beginDrag(e, row, "move")}
                onPointerMove={moveDrag}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                data-testid={`${rowTestId}-bar`}
                aria-label={`${row.label}：${fmt(row.start)}〜${fmt(row.end)}（ドラッグで移動）`}
              >
                <span
                  role="slider"
                  tabIndex={0}
                  aria-label={`${row.label}の開始`}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(row.end * 10) / 10}
                  aria-valuenow={Math.round(row.start * 10) / 10}
                  aria-valuetext={fmt(row.start)}
                  className="absolute inset-y-0 left-0 z-10 flex w-4 cursor-ew-resize items-center justify-center bg-black/25 focus-visible:outline-2 focus-visible:outline-white"
                  onPointerDown={(e) => beginDrag(e, row, "start")}
                  onPointerMove={moveDrag}
                  onPointerUp={stopDrag}
                  onKeyDown={(e) => keyNudge(e, row, "start")}
                  data-testid={`${rowTestId}-start`}
                >
                  <span className="h-4 w-0.5 rounded bg-white/90" />
                </span>
                <span className="pointer-events-none min-w-0 truncate px-5">{row.text ?? ""}</span>
                <span
                  role="slider"
                  tabIndex={0}
                  aria-label={`${row.label}の終了`}
                  aria-valuemin={Math.round(row.start * 10) / 10}
                  aria-valuemax={Math.round(D * 10) / 10}
                  aria-valuenow={Math.round(row.end * 10) / 10}
                  aria-valuetext={fmt(row.end)}
                  className="absolute inset-y-0 right-0 z-10 flex w-4 cursor-ew-resize items-center justify-center bg-black/25 focus-visible:outline-2 focus-visible:outline-white"
                  onPointerDown={(e) => beginDrag(e, row, "end")}
                  onPointerMove={moveDrag}
                  onPointerUp={stopDrag}
                  onKeyDown={(e) => keyNudge(e, row, "end")}
                  data-testid={`${rowTestId}-end`}
                >
                  <span className="h-4 w-0.5 rounded bg-white/90" />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {guide !== null && (
        <span
          className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-yellow-400"
          style={{ left: `calc(3rem + (100% - 3rem) * ${Math.min(1, Math.max(0, guide / D))})` }}
          data-testid={`${testId}-guide`}
        />
      )}
      </div>
      </div>
    </div>
  );
}

/** 横にスクロールしても、行の名前の列が左に残るようにする */
const STICKY = "sticky left-0 z-30 bg-white/90 backdrop-blur-sm dark:bg-neutral-900/90";
