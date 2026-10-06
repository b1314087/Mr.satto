"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImageLayoutRenderProcessor,
  computeGridCells,
  computeAutoGridShape,
  type ImageLayoutItem,
  type ImageLayoutOutputFormat,
} from "@/lib/processors/browser/image-layout";
import type { ImageProcessorOutput, PdfProcessorOutput } from "@/lib/processors/types";
import {
  PAPER_SIZE_IDS,
  PAPER_SIZE_LABELS,
  resolvePaperSizePt,
  mmToPt,
  type PaperSizeId,
  type PaperOrientation,
} from "@/lib/print/paper-sizes";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/**
 * 画像レイアウトツール（Mr.Satto 次工程フェーズの中心ツール）。
 *
 * 複数の画像・テキストを1つのキャンバスへ自由配置し、PNG/JPEG/PDFとして
 * 書き出す。「画像結合」「A4/A3画像自動配置」「画像に余白＋文字」を
 * 個別ツールとして増やさず、すべてこのツールの機能として統合する
 * （開発指示書 7〜9章）。
 *
 * 操作モデル:
 * - 画像・テキストは「アイテム」として1つのキャンバス上に自由配置できる
 *   （ドラッグで移動、四隅のハンドルでサイズ変更、上部のハンドルで回転）。
 * - 「グリッドに配置」を使うと、選択したキャンバスサイズ（自由サイズ or
 *   A4等の用紙）・列数×行数・余白・画像間隔に基づいて、現在配置されている
 *   画像アイテムの位置を一括で計算し直す。列数×行数の組み合わせ次第で、
 *   横結合（1行）・縦結合（1列）・グリッド（複数行列）のいずれも表現できる。
 * - テキストアイテムはグリッド配置の対象にせず、常に自由配置のまま
 *   維持する（意図して置いた位置を勝手に動かさないため）。
 *
 * 既存資産の再利用（開発指示書 32・33章）:
 * - Canvas描画・PNG/JPEG/PDF書き出しは image.ts / image-layout.ts の
 *   共通Processorへ委譲し、このコンポーネントはUI状態管理のみを担う。
 * - 用紙サイズは新設の src/lib/print/paper-sizes.ts（複数ツールから
 *   使う想定の共通定義）を利用する。
 * - ファイル選択・進捗表示・エラー表示・ダウンロードは既存の共通コンポーネント
 *   （FileDropzone / ProcessingStatus / ErrorMessage / RewardedDownloadGate）を
 *   そのまま利用する。
 */

const DEFAULT_CANVAS_WIDTH = 1200;
const DEFAULT_CANVAS_HEIGHT = 800;
const MIN_ITEM_SIZE = 24;
const DEFAULT_ITEM_SIZE = 240;

type Corner = "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: "move" | "resize" | "rotate";
  corner?: Corner;
  itemId: string;
  startClientX: number;
  startClientY: number;
  startItem: ImageLayoutItem;
  /** キャンバスの実際の描画サイズ(px)とcanvasSpec上の論理サイズ(px)の比率 */
  pxPerCanvasPx: number;
  /** 回転ドラッグ用: キャンバス座標系でのアイテム中心 */
  centerX: number;
  centerY: number;
}

const EXT_BY_FORMAT: Record<ImageLayoutOutputFormat, string> = {
  png: "png",
  jpeg: "jpg",
  pdf: "pdf",
};

function isPdfOutput(
  output: ImageProcessorOutput | PdfProcessorOutput
): output is PdfProcessorOutput {
  return "pageCount" in output;
}

export function ImageLayoutTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [fileUrls, setFileUrls] = useState<string[]>([]);
  const [items, setItems] = useState<ImageLayoutItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [canvasWidthPx, setCanvasWidthPx] = useState(DEFAULT_CANVAS_WIDTH);
  const [canvasHeightPx, setCanvasHeightPx] = useState(DEFAULT_CANVAS_HEIGHT);
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [paperMode, setPaperMode] = useState<PaperSizeId | "custom">("custom");
  const [orientation, setOrientation] = useState<PaperOrientation>("landscape");

  const [gridColumns, setGridColumns] = useState(2);
  const [gridRowsAuto, setGridRowsAuto] = useState(true);
  const [gridRows, setGridRows] = useState(2);
  const [gridMarginMm, setGridMarginMm] = useState(10);
  const [gridGapMm, setGridGapMm] = useState(5);
  const [gridFit, setGridFit] = useState<"contain" | "cover">("contain");
  const [gridWarning, setGridWarning] = useState<string | null>(null);

  const [outputFormat, setOutputFormat] = useState<ImageLayoutOutputFormat>("png");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | PdfProcessorOutput | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const nextItemIdRef = useRef(1);
  const [displayScale, setDisplayScale] = useState(1);

  // レンダー中にcanvasRef.currentを直接読まない（react-hooks/refsルール）ため、
  // 実際の描画サイズ÷論理サイズの比率をstateとして持ち、ResizeObserverで
  // レイアウト変化（キャンバスサイズ変更・画面幅変化等）のたびに更新する。
  // これはテキストアイテムの表示上のフォントサイズ計算にのみ使う
  // （ドラッグ操作中のpx変換は各ポインタイベントハンドラ内でcanvasRef.current
  // を直接読む。イベントハンドラはレンダーではないためこのルールの対象外）。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (canvasWidthPx > 0 && rect.width > 0) setDisplayScale(rect.width / canvasWidthPx);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvasWidthPx]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // アンマウント時に、このツールで作成した全Object URLをまとめて解放する。
  // クリーンアップ関数は空の依存配列のクロージャ内にあるとマウント時点の
  // 古いfileUrls（常に空配列）しか参照できないため、refで常に最新の値を
  // 保持しておき、クリーンアップはそのrefから読む
  // （pdf-fill-annotate-tool.tsxのobjectsRefと同じパターン）。
  const fileUrlsRef = useRef(fileUrls);
  useEffect(() => {
    fileUrlsRef.current = fileUrls;
  }, [fileUrls]);
  useEffect(() => {
    return () => {
      fileUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const selectedItem = useMemo(() => items.find((i) => i.id === selectedId) ?? null, [items, selectedId]);

  function nextZIndex(): number {
    return items.reduce((max, i) => Math.max(max, i.zIndex), 0) + 1;
  }

  function handleFilesAdded(newFiles: File[]) {
    if (newFiles.length === 0) return;
    setFiles((prev) => {
      const startIndex = prev.length;
      const urls = newFiles.map((f) => URL.createObjectURL(f));
      setFileUrls((prevUrls) => [...prevUrls, ...urls]);

      setItems((prevItems) => {
        const added: ImageLayoutItem[] = newFiles.map((_file, i) => {
          const order = prevItems.length + i;
          const offset = (order % 6) * 24;
          return {
            id: `item-${nextItemIdRef.current++}`,
            kind: "image",
            x: 40 + offset,
            y: 40 + offset,
            width: DEFAULT_ITEM_SIZE,
            height: DEFAULT_ITEM_SIZE,
            rotation: 0,
            zIndex: prevItems.reduce((max, it) => Math.max(max, it.zIndex), 0) + i + 1,
            fit: "contain",
            imageIndex: startIndex + i,
          };
        });
        if (added.length > 0) setSelectedId(added[added.length - 1].id);
        return [...prevItems, ...added];
      });

      return [...prev, ...newFiles];
    });
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  function addTextItem() {
    const id = `item-${nextItemIdRef.current++}`;
    const item: ImageLayoutItem = {
      id,
      kind: "text",
      x: Math.max(0, canvasWidthPx / 2 - 100),
      y: Math.max(0, canvasHeightPx / 2 - 20),
      width: 200,
      height: 40,
      rotation: 0,
      zIndex: nextZIndex(),
      text: "テキスト",
      fontSize: 24,
      color: "#111111",
      fontWeight: "normal",
    };
    setItems((prev) => [...prev, item]);
    setSelectedId(id);
  }

  function updateItem(id: string, patch: Partial<ImageLayoutItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function deleteSelected() {
    if (!selectedId) return;
    setItems((prev) => prev.filter((it) => it.id !== selectedId));
    setSelectedId(null);
  }

  function duplicateSelected() {
    if (!selectedItem) return;
    const id = `item-${nextItemIdRef.current++}`;
    const copy: ImageLayoutItem = {
      ...selectedItem,
      id,
      x: selectedItem.x + 16,
      y: selectedItem.y + 16,
      zIndex: nextZIndex(),
    };
    setItems((prev) => [...prev, copy]);
    setSelectedId(id);
  }

  function bringToFront() {
    if (!selectedId) return;
    updateItem(selectedId, { zIndex: nextZIndex() });
  }

  function sendToBack() {
    if (!selectedId) return;
    const min = items.reduce((m, i) => Math.min(m, i.zIndex), 0);
    updateItem(selectedId, { zIndex: min - 1 });
  }

  // ---------------------------------------------------------------------
  // ドラッグ操作（移動・リサイズ・回転）
  // ---------------------------------------------------------------------

  function getPxPerCanvasPx(): number {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || canvasWidthPx === 0) return 1;
    return rect.width / canvasWidthPx;
  }

  function onItemPointerDown(e: ReactPointerEvent<HTMLDivElement>, item: ImageLayoutItem) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedId(item.id);
    dragRef.current = {
      mode: "move",
      itemId: item.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startItem: item,
      pxPerCanvasPx: getPxPerCanvasPx(),
      centerX: item.x + item.width / 2,
      centerY: item.y + item.height / 2,
    };
  }

  function onHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, item: ImageLayoutItem, corner: Corner) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "resize",
      corner,
      itemId: item.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startItem: item,
      pxPerCanvasPx: getPxPerCanvasPx(),
      centerX: item.x + item.width / 2,
      centerY: item.y + item.height / 2,
    };
  }

  function onRotateHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, item: ImageLayoutItem) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "rotate",
      itemId: item.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startItem: item,
      pxPerCanvasPx: getPxPerCanvasPx(),
      centerX: item.x + item.width / 2,
      centerY: item.y + item.height / 2,
    };
  }

  function onCanvasPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pxPerCanvasPx === 0) return;

    if (drag.mode === "move") {
      const dx = (e.clientX - drag.startClientX) / drag.pxPerCanvasPx;
      const dy = (e.clientY - drag.startClientY) / drag.pxPerCanvasPx;
      updateItem(drag.itemId, { x: drag.startItem.x + dx, y: drag.startItem.y + dy });
      return;
    }

    if (drag.mode === "resize") {
      const dx = (e.clientX - drag.startClientX) / drag.pxPerCanvasPx;
      const dy = (e.clientY - drag.startClientY) / drag.pxPerCanvasPx;
      let { x, y, width, height } = drag.startItem;
      const corner = drag.corner ?? "se";
      if (corner.includes("e")) width = drag.startItem.width + dx;
      if (corner.includes("s")) height = drag.startItem.height + dy;
      if (corner.includes("w")) {
        width = drag.startItem.width - dx;
        x = drag.startItem.x + dx;
      }
      if (corner.includes("n")) {
        height = drag.startItem.height - dy;
        y = drag.startItem.y + dy;
      }
      width = Math.max(MIN_ITEM_SIZE, width);
      height = Math.max(MIN_ITEM_SIZE, height);
      // 幅・高さが最小値でクランプされた場合、"w"/"n"側のx/yが動きすぎないよう補正する
      if (corner.includes("w")) x = drag.startItem.x + (drag.startItem.width - width);
      if (corner.includes("n")) y = drag.startItem.y + (drag.startItem.height - height);
      updateItem(drag.itemId, { x, y, width, height });
      return;
    }

    if (drag.mode === "rotate") {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const centerClientX = rect.left + drag.centerX * drag.pxPerCanvasPx;
      const centerClientY = rect.top + drag.centerY * drag.pxPerCanvasPx;
      const angleRad = Math.atan2(e.clientY - centerClientY, e.clientX - centerClientX);
      // 0度 = 上向き（回転ハンドルがアイテム上部にあるため、-90度分オフセットする）
      const degrees = (angleRad * 180) / Math.PI + 90;
      updateItem(drag.itemId, { rotation: Math.round(degrees) });
    }
  }

  function onCanvasPointerUp() {
    dragRef.current = null;
  }

  // ---------------------------------------------------------------------
  // グリッド自動配置
  // ---------------------------------------------------------------------

  function applyPaperMode(id: PaperSizeId | "custom", nextOrientation: PaperOrientation) {
    setPaperMode(id);
    setOrientation(nextOrientation);
    if (id === "custom") return;
    const size = resolvePaperSizePt(id, nextOrientation);
    setCanvasWidthPx(Math.round(size.width));
    setCanvasHeightPx(Math.round(size.height));
  }

  function applyGridArrange() {
    setGridWarning(null);
    const imageItems = items
      .filter((it) => it.kind === "image")
      .sort((a, b) => a.zIndex - b.zIndex);
    if (imageItems.length === 0) {
      setGridWarning("グリッドに配置する画像がありません。先に画像を追加してください。");
      return;
    }

    const columns = gridColumns > 0 ? gridColumns : 1;
    const rows = gridRowsAuto
      ? computeAutoGridShape(imageItems.length, canvasWidthPx, canvasHeightPx).rows
      : Math.max(1, gridRows);
    const effectiveColumns = gridRowsAuto
      ? computeAutoGridShape(imageItems.length, canvasWidthPx, canvasHeightPx).columns
      : columns;

    const cells = computeGridCells({
      canvasWidthPx,
      canvasHeightPx,
      marginPx: mmToPt(gridMarginMm),
      gapPx: mmToPt(gridGapMm),
      columns: effectiveColumns,
      rows,
    });

    if (imageItems.length > cells.length) {
      setGridWarning(
        `画像${imageItems.length}枚に対し、配置できるマスは${cells.length}個です。列数・行数を増やすか、画像を減らしてください（超過分は元の位置のまま残ります）。`
      );
    }

    const placedIds = new Set<string>();
    setItems((prev) =>
      prev.map((it) => {
        const idx = imageItems.findIndex((img) => img.id === it.id);
        if (idx === -1 || idx >= cells.length || placedIds.has(it.id)) return it;
        placedIds.add(it.id);
        const cell = cells[idx];
        return { ...it, x: cell.x, y: cell.y, width: cell.width, height: cell.height, fit: gridFit };
      })
    );
  }

  // ---------------------------------------------------------------------
  // 出力
  // ---------------------------------------------------------------------

  async function handleConvert() {
    if (items.length === 0) {
      setError("配置された画像・文字がありません。画像を追加するか、文字を配置してください。");
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const pdfPageSizePt =
        outputFormat === "pdf"
          ? { width: canvasWidthPx, height: canvasHeightPx }
          : undefined;
      const output = await new ImageLayoutRenderProcessor().process({
        files,
        canvas: { widthPx: canvasWidthPx, heightPx: canvasHeightPx, backgroundColor },
        items,
        format: outputFormat,
        pdfPageSizePt,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = `image-layout.${EXT_BY_FORMAT[outputFormat]}`;

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="flex flex-1 flex-col gap-4">
        <FileDropzone
          accept="image/*"
          multiple
          label="画像をドラッグ&ドロップ"
          hint="複数選択できます（JPG・PNG・WebPなど）"
          onFilesSelected={handleFilesAdded}
          onError={setError}
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={addTextItem}
            className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            文字を追加
          </button>
          {selectedItem && (
            <>
              <button
                type="button"
                onClick={duplicateSelected}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
              >
                複製
              </button>
              <button
                type="button"
                onClick={bringToFront}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
              >
                最前面へ
              </button>
              <button
                type="button"
                onClick={sendToBack}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
              >
                最背面へ
              </button>
              <button
                type="button"
                onClick={deleteSelected}
                className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-400"
              >
                削除
              </button>
            </>
          )}
        </div>

        <div
          ref={canvasRef}
          data-testid="tool-preview"
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          onPointerDown={() => setSelectedId(null)}
          className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700"
          style={{
            aspectRatio: `${canvasWidthPx} / ${canvasHeightPx}`,
            backgroundColor: backgroundColor === "transparent" ? undefined : backgroundColor,
            backgroundImage:
              backgroundColor === "transparent"
                ? "linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%)"
                : undefined,
            backgroundSize: backgroundColor === "transparent" ? "16px 16px" : undefined,
          }}
        >
          {items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <div
                key={item.id}
                onPointerDown={(e) => onItemPointerDown(e, item)}
                className={`absolute cursor-move ${selected ? "outline outline-2 outline-blue-500" : ""}`}
                style={{
                  left: `${(item.x / canvasWidthPx) * 100}%`,
                  top: `${(item.y / canvasHeightPx) * 100}%`,
                  width: `${(item.width / canvasWidthPx) * 100}%`,
                  height: `${(item.height / canvasHeightPx) * 100}%`,
                  transform: `rotate(${item.rotation}deg)`,
                  transformOrigin: "center center",
                }}
              >
                {item.kind === "image" && item.imageIndex !== undefined && fileUrls[item.imageIndex] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={fileUrls[item.imageIndex]}
                    alt=""
                    draggable={false}
                    className="pointer-events-none h-full w-full select-none"
                    style={{ objectFit: item.fit === "cover" ? "cover" : "contain" }}
                  />
                )}
                {item.kind === "text" && (
                  <div
                    className="pointer-events-none flex h-full w-full items-start justify-start overflow-hidden whitespace-pre-wrap break-words"
                    style={{
                      fontSize: Math.max(8, (item.fontSize ?? 24) * displayScale),
                      color: item.color ?? "#111111",
                      fontWeight: item.fontWeight === "bold" ? 700 : 400,
                    }}
                  >
                    {item.text}
                  </div>
                )}

                {selected && (
                  <>
                    <div
                      onPointerDown={(e) => onRotateHandlePointerDown(e, item)}
                      aria-label="ドラッグして回転"
                      className="absolute left-1/2 top-0 h-4 w-4 -translate-x-1/2 -translate-y-8 cursor-grab touch-none rounded-full border-2 border-white bg-emerald-500 shadow"
                    />
                    {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                      <div
                        key={corner}
                        onPointerDown={(e) => onHandlePointerDown(e, item, corner)}
                        aria-label={`${corner}角をドラッグしてサイズ変更`}
                        className={`absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-blue-500 shadow ${
                          corner === "nw"
                            ? "left-0 top-0 cursor-nwse-resize"
                            : corner === "ne"
                              ? "left-full top-0 cursor-nesw-resize"
                              : corner === "sw"
                                ? "left-0 top-full cursor-nesw-resize"
                                : "left-full top-full cursor-nwse-resize"
                        }`}
                      />
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          アイテムをドラッグして移動、四隅のハンドルでサイズ変更、上の緑ハンドルで回転できます。
        </p>

        {selectedItem?.kind === "image" && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-700">
            <span className="text-neutral-500 dark:text-neutral-400">選択中の画像の配置:</span>
            <button
              type="button"
              onClick={() => updateItem(selectedItem.id, { fit: "contain" })}
              className={`rounded-md px-2.5 py-1 ${selectedItem.fit === "contain" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              比率維持（全体表示）
            </button>
            <button
              type="button"
              onClick={() => updateItem(selectedItem.id, { fit: "cover" })}
              className={`rounded-md px-2.5 py-1 ${selectedItem.fit === "cover" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              枠いっぱいに配置
            </button>
          </div>
        )}

        {selectedItem?.kind === "text" && (
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-700">
            <textarea
              value={selectedItem.text ?? ""}
              onChange={(e) => updateItem(selectedItem.id, { text: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                文字サイズ
                <input
                  type="number"
                  min={6}
                  max={400}
                  value={selectedItem.fontSize ?? 24}
                  onChange={(e) => updateItem(selectedItem.id, { fontSize: Number(e.target.value) })}
                  className="w-20 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex items-center gap-2">
                色
                <input
                  type="color"
                  value={selectedItem.color ?? "#111111"}
                  onChange={(e) => updateItem(selectedItem.id, { color: e.target.value })}
                  className="h-8 w-10 rounded"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  updateItem(selectedItem.id, {
                    fontWeight: selectedItem.fontWeight === "bold" ? "normal" : "bold",
                  })
                }
                className={`rounded-md px-2.5 py-1 ${selectedItem.fontWeight === "bold" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                太字
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex w-full flex-col gap-5 lg:w-80">
        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">キャンバスサイズ</h3>
          <select
            value={paperMode}
            onChange={(e) => applyPaperMode(e.target.value as PaperSizeId | "custom", orientation)}
            className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="custom">自由サイズ</option>
            {PAPER_SIZE_IDS.map((id) => (
              <option key={id} value={id}>
                {PAPER_SIZE_LABELS[id]}
              </option>
            ))}
          </select>
          {paperMode !== "custom" && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => applyPaperMode(paperMode, "portrait")}
                className={`flex-1 rounded-md px-2 py-1 text-sm ${orientation === "portrait" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                縦
              </button>
              <button
                type="button"
                onClick={() => applyPaperMode(paperMode, "landscape")}
                className={`flex-1 rounded-md px-2 py-1 text-sm ${orientation === "landscape" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                横
              </button>
            </div>
          )}
          {paperMode === "custom" && (
            <div className="flex items-center gap-2 text-sm">
              <input
                type="number"
                min={100}
                max={6000}
                value={Math.round(canvasWidthPx)}
                onChange={(e) => setCanvasWidthPx(Math.max(100, Number(e.target.value)))}
                className="w-20 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <span>×</span>
              <input
                type="number"
                min={100}
                max={6000}
                value={Math.round(canvasHeightPx)}
                onChange={(e) => setCanvasHeightPx(Math.max(100, Number(e.target.value)))}
                className="w-20 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <span className="text-neutral-500 dark:text-neutral-400">px</span>
            </div>
          )}
          <label className="flex items-center justify-between text-sm">
            背景色
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={backgroundColor === "transparent" ? "#ffffff" : backgroundColor}
                onChange={(e) => setBackgroundColor(e.target.value)}
                className="h-8 w-10 rounded"
              />
              <button
                type="button"
                onClick={() => setBackgroundColor((c) => (c === "transparent" ? "#ffffff" : "transparent"))}
                className={`rounded-md px-2 py-1 text-xs ${backgroundColor === "transparent" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                透過
              </button>
            </div>
          </label>
        </section>

        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">グリッドに配置</h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            画像を列数×行数のマス目へ一括配置します（列数1なら縦結合、行数1なら横結合と同じ配置になります）。文字は動きません。
          </p>
          <label className="flex items-center justify-between text-sm">
            <span>行数を自動計算</span>
            <input type="checkbox" checked={gridRowsAuto} onChange={(e) => setGridRowsAuto(e.target.checked)} />
          </label>
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              列数
              <input
                type="number"
                min={1}
                max={20}
                value={gridColumns}
                onChange={(e) => setGridColumns(Math.max(1, Number(e.target.value)))}
                className="w-16 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            {!gridRowsAuto && (
              <label className="flex items-center gap-2">
                行数
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={gridRows}
                  onChange={(e) => setGridRows(Math.max(1, Number(e.target.value)))}
                  className="w-16 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              余白
              <input
                type="number"
                min={0}
                max={100}
                value={gridMarginMm}
                onChange={(e) => setGridMarginMm(Math.max(0, Number(e.target.value)))}
                className="w-16 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              />
              mm
            </label>
            <label className="flex items-center gap-2">
              画像間隔
              <input
                type="number"
                min={0}
                max={100}
                value={gridGapMm}
                onChange={(e) => setGridGapMm(Math.max(0, Number(e.target.value)))}
                className="w-16 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
              />
              mm
            </label>
          </div>
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setGridFit("contain")}
              className={`flex-1 rounded-md px-2 py-1 ${gridFit === "contain" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              比率維持
            </button>
            <button
              type="button"
              onClick={() => setGridFit("cover")}
              className={`flex-1 rounded-md px-2 py-1 ${gridFit === "cover" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              枠いっぱい
            </button>
          </div>
          <button
            type="button"
            onClick={applyGridArrange}
            className="w-full rounded-lg bg-neutral-800 px-3 py-2 text-sm font-semibold text-white hover:bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900"
          >
            グリッドに配置を適用
          </button>
          {gridWarning && <p className="text-xs text-amber-600 dark:text-amber-400">{gridWarning}</p>}
        </section>

        <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">出力</h3>
          <div className="flex gap-2 text-sm">
            {(["png", "jpeg", "pdf"] as ImageLayoutOutputFormat[]).map((fmt) => (
              <button
                key={fmt}
                type="button"
                onClick={() => setOutputFormat(fmt)}
                className={`flex-1 rounded-md px-2 py-1.5 uppercase ${outputFormat === fmt ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                {fmt}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleConvert}
            disabled={status === "processing" || items.length === 0}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            書き出す
          </button>
          <ProcessingStatus state={status} successLabel="書き出しが完了しました" />
          {error && <ErrorMessage message={error} />}

          {result && (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {isPdfOutput(result) ? `PDF ${result.pageCount}ページ` : `${result.width} × ${result.height}px`} ・{" "}
                {formatBytes(result.sizeBytes)}
              </p>
              <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
