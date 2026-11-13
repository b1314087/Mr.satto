"use client";

import { ZoomSlider } from "@/components/common/zoom-slider";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

/**
 * プレビューを「画面いっぱいに大きく表示」できる枠（全ツール共通）。
 *
 * - 右上の「⛶ 大きく表示」で、プレビューを画面全体に広げる。「✕ 閉じる」か Esc で戻る。
 * - 中身はそのまま（作り直さない）で、枠の見た目だけを画面全体に切り替える。
 *   そのため、プレビューの中の状態（選んだページ・再生位置など）は、大きくしても戻しても変わらない。
 * - 開いたときは、中身が画面に収まる大きさまで自動で拡大する（最大3倍）。「－」「＋」「画面に合わせる」で調整できる。
 * - 大きく表示している間は、後ろのページをスクロールさせない。
 * - 中の画像・動画は、ツールごとの高さの上限を外す（globals.css の .ms-preview-fs）。
 * - 動画のプレビュー（.ms-fs-fill を付けた <video>）は、元の動画が小さくても、画面に収まる大きさまで広げる。
 */
export function PreviewFullscreenFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const frameRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  /** 中身が画面に収まる倍率（1倍より小さくはしない） */
  const fitZoom = useCallback(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return 1;
    const prev = content.style.zoom;
    content.style.zoom = "1";
    const w = content.offsetWidth;
    const h = content.offsetHeight;
    content.style.zoom = prev;
    const availW = frame.clientWidth - 48;
    const availH = frame.clientHeight - (barRef.current?.offsetHeight ?? 40) - 48;
    if (w <= 0 || h <= 0) return 1;
    const z = Math.min(availW / w, availH / h, ZOOM_MAX);
    return Math.max(1, Math.floor(z * 10) / 10);
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  function open() {
    setFullscreen(true);
    // 画面いっぱいの枠ができてから、中身が画面に収まる大きさを測って拡大する
    requestAnimationFrame(() => setZoom(fitZoom()));
  }

  function close() {
    setFullscreen(false);
    setZoom(1);
  }

  const zoomButton = "ms-focus-ring rounded-lg bg-neutral-100 px-2.5 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200";

  return (
    <div
      ref={frameRef}
      className={fullscreen ? "ms-preview-fs fixed inset-0 z-[100] flex flex-col gap-3 overflow-auto bg-white p-4 sm:p-6 dark:bg-neutral-950" : `relative ${className}`}
      data-preview-fullscreen={fullscreen ? "true" : undefined}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      data-page-drop-ok={fullscreen ? "true" : undefined}
      aria-label={fullscreen ? "プレビュー（大きく表示）" : undefined}
    >
      <div
        ref={barRef}
        className={fullscreen ? "sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 bg-white/90 px-1 pb-1 dark:bg-neutral-950/90" : "mb-1 flex justify-end"}
      >
        {fullscreen ? (
          <>
            <button type="button" className={zoomButton} onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))} disabled={zoom <= ZOOM_MIN} aria-label="小さくする" data-testid="preview-zoom-out">
              －
            </button>
            <ZoomSlider
              value={Math.round(zoom * 100)}
              min={Math.round(ZOOM_MIN * 100)}
              max={Math.round(ZOOM_MAX * 100)}
              step={5}
              onChange={(p) => setZoom(p / 100)}
              testId="preview-zoom-slider"
              className="w-40"
            />
            <span className="w-12 text-center text-xs tabular-nums text-neutral-600 dark:text-neutral-300" data-testid="preview-zoom">
              {Math.round(zoom * 100)}%
            </span>
            <button type="button" className={zoomButton} onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))} disabled={zoom >= ZOOM_MAX} aria-label="大きくする" data-testid="preview-zoom-in">
              ＋
            </button>
            <button type="button" className={zoomButton} onClick={() => setZoom(fitZoom())} data-testid="preview-zoom-fit">
              画面に合わせる
            </button>
            <button type="button" onClick={close} className="ms-focus-ring rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white" data-testid="preview-fullscreen-close">
              ✕ 閉じる（Esc）
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={open}
            className="ms-focus-ring rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            title="プレビューを画面いっぱいに大きく表示します"
            data-testid="preview-fullscreen"
          >
            ⛶ 大きく表示
          </button>
        )}
      </div>
      <div
        ref={contentRef}
        // 大きく表示しているときは、中身の幅を中身に合わせ（画面より広くはしない）、倍率をかけて真ん中に置く
        // 動画（.ms-fs-fill）を含むときは、中身を枠の幅いっぱいにして、動画そのものを画面に収まる大きさまで広げる
        // （倍率だけでは、動画の下の長いファイル名などの文字の幅で倍率が決まり、小さな動画がほとんど大きくならないため）
        className={fullscreen ? "ms-fs-content mx-auto max-w-full" : ""}
        style={fullscreen ? { width: "fit-content", zoom } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
