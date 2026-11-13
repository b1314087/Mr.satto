"use client";

import { ZoomSlider } from "@/components/common/zoom-slider";

/** タイムラインの拡大・縮小（%）の範囲 */
export const TIMELINE_ZOOM = { min: 100, max: 1000, step: 25 } as const;

/**
 * タイムラインの上に出す、拡大・縮小のバーと、磁石（スナップ）の切り替え（2026-11）。
 * - 拡大すると、タイムラインが横に長くなり、横にスクロールして細かく操作できる。
 * - 磁石がオンのときは、動かしているバーの端が、ほかの区間の端・再生位置の近くで吸い付く。
 */
export function TimelineToolbar({
  zoom,
  onZoom,
  snap,
  onSnap,
  testId,
}: {
  zoom: number;
  onZoom: (percent: number) => void;
  snap: boolean;
  onSnap: (on: boolean) => void;
  testId: string;
}) {
  const clamp = (v: number) => Math.min(TIMELINE_ZOOM.max, Math.max(TIMELINE_ZOOM.min, v));
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-300" data-testid={`${testId}-toolbar`}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="whitespace-nowrap">拡大・縮小</span>
        <button
          type="button"
          onClick={() => onZoom(clamp(zoom / 1.5))}
          disabled={zoom <= TIMELINE_ZOOM.min}
          aria-label="タイムラインを縮小"
          className="rounded border border-neutral-300 px-1.5 leading-5 disabled:opacity-40 dark:border-neutral-700"
          data-testid={`${testId}-zoom-out`}
        >
          －
        </button>
        <ZoomSlider
          value={zoom}
          min={TIMELINE_ZOOM.min}
          max={TIMELINE_ZOOM.max}
          step={TIMELINE_ZOOM.step}
          onChange={(v) => onZoom(clamp(v))}
          label="タイムラインの表示倍率"
          testId={`${testId}-zoom`}
          className="max-w-56 flex-1"
        />
        <button
          type="button"
          onClick={() => onZoom(clamp(zoom * 1.5))}
          disabled={zoom >= TIMELINE_ZOOM.max}
          aria-label="タイムラインを拡大"
          className="rounded border border-neutral-300 px-1.5 leading-5 disabled:opacity-40 dark:border-neutral-700"
          data-testid={`${testId}-zoom-in`}
        >
          ＋
        </button>
        <span className="w-10 text-right tabular-nums" data-testid={`${testId}-zoom-value`}>
          {Math.round(zoom)}%
        </span>
      </div>
      <label className="flex items-center gap-1.5 whitespace-nowrap">
        <input type="checkbox" checked={snap} onChange={(e) => onSnap(e.target.checked)} data-testid={`${testId}-snap`} />
        磁石（端・再生位置に吸い付く）
      </label>
    </div>
  );
}

/** 磁石が吸い付く距離（画面上のピクセル） */
export const SNAP_PX = 8;
