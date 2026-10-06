"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageCropProcessor, type CropRegion } from "@/lib/processors/browser/image";
import {
  ImageLayoutRenderProcessor,
  computeFixedSizeGrid,
  type ImageLayoutItem,
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
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 証明写真サイズ変換ツール（Mr.Satto 次工程フェーズ Step 4）。
 *
 * 「証明写真専用の新しい巨大処理系」は作らず、既存の画像処理・Step 3の
 * 画像レイアウトを再利用して組み立てる（開発指示書 23・最終ゴール参照）。
 * - トリミング・出力：image.ts の ImageCropProcessor をそのまま利用する
 *   （image-crop-tool.tsx / image-sns-size-tool.tsx と同じProcessor）。
 *   crop範囲の決め方（ドラッグ＆ズーム操作、比率固定）だけがこのツール固有。
 * - A4等へのまとめて印刷：image-layout.ts の ImageLayoutRenderProcessor を
 *   そのまま利用する（生成した証明写真1枚をFile化し、複数アイテムとして
 *   配置するだけ）。用紙サイズは共通の paper-sizes.ts を使う。
 * - 固定サイズのセルを敷き詰める計算だけ、image-layout.ts の
 *   computeGridCells（列数×行数で利用可能領域いっぱいに引き伸ばす方式）とは
 *   別に computeFixedSizeGrid を追加した（証明写真は物理サイズ(mm)を
 *   厳密に保つ必要があるため。必要な差分のみの追加）。
 *
 * AIによる背景除去・顔認識・自動位置合わせは今回実装しない（開発指示書
 * 12・13章）。ユーザーがドラッグ・ズームで位置調整する。
 */

interface SizePreset {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

// 代表的なサイズの例として用意する。特定用途（パスポート・履歴書等）の
// 公的要件を満たすことを断定するものではない（開発指示書5・18章）。
const PRESETS: SizePreset[] = [
  { id: "30x40", label: "30×40mm", widthMm: 30, heightMm: 40 },
  { id: "35x45", label: "35×45mm", widthMm: 35, heightMm: 45 },
  { id: "40x50", label: "40×50mm", widthMm: 40, heightMm: 50 },
];

const DEFAULT_DPI = 300;
const MIN_DPI = 72;
const MAX_DPI = 600;
const MAX_MM = 500; // 極端なサイズ指定によるCanvas肥大化を防ぐ上限
const MAX_OUTPUT_PIXELS = 20_000_000; // 1辺が極端に大きい指定を弾く安全弁
const MIN_SIZE_PCT = 5;
const PREVIEW_WIDTH_PX = 132;

interface Box {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

const DEFAULT_BOX: Box = { xPct: 10, yPct: 10, wPct: 80, hPct: 80 };

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

function clampBox(next: Box): Box {
  const wPct = Math.min(Math.max(next.wPct, MIN_SIZE_PCT), 100);
  const hPct = Math.min(Math.max(next.hPct, MIN_SIZE_PCT), 100);
  const xPct = Math.min(Math.max(next.xPct, 0), 100 - wPct);
  const yPct = Math.min(Math.max(next.yPct, 0), 100 - hPct);
  return { xPct, yPct, wPct, hPct };
}

/** 比率(幅/高さ)を維持したまま、指定した幅(%)へ中心を固定してリサイズする */
function boxWithWidthPct(
  prev: Box,
  wPct: number,
  ratio: number,
  naturalSize: { width: number; height: number }
): Box {
  const clampedW = Math.min(Math.max(wPct, MIN_SIZE_PCT), 100);
  const hPct = (clampedW * naturalSize.width) / (ratio * naturalSize.height);
  const cx = prev.xPct + prev.wPct / 2;
  const cy = prev.yPct + prev.hPct / 2;
  return clampBox({ xPct: cx - clampedW / 2, yPct: cy - hPct / 2, wPct: clampedW, hPct });
}

function defaultBoxForRatio(ratio: number, naturalSize: { width: number; height: number }): Box {
  const hPct = (DEFAULT_BOX.wPct * naturalSize.width) / (ratio * naturalSize.height);
  return clampBox({ ...DEFAULT_BOX, hPct });
}

export function ImagePassportPhotoTool() {
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  // --- サイズ指定 ---
  const [presetId, setPresetId] = useState<string>("35x45");
  const [customWidthMm, setCustomWidthMm] = useState(35);
  const [customHeightMm, setCustomHeightMm] = useState(45);
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const activePreset = PRESETS.find((p) => p.id === presetId);
  const widthMm = presetId === "custom" ? customWidthMm : activePreset?.widthMm ?? 35;
  const heightMm = presetId === "custom" ? customHeightMm : activePreset?.heightMm ?? 45;
  const sizeError =
    !Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0
      ? "幅・高さは1mm以上を指定してください。"
      : widthMm > MAX_MM || heightMm > MAX_MM
        ? `幅・高さは${MAX_MM}mm以下で指定してください。`
        : !Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI
          ? `解像度は${MIN_DPI}〜${MAX_DPI}dpiの範囲で指定してください。`
          : null;
  const ratio = !sizeError && heightMm > 0 ? widthMm / heightMm : 1;

  // --- トリミング範囲（ratio固定） ---
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize";
    corner?: Corner;
    startClientX: number;
    startClientY: number;
    startBox: Box;
  } | null>(null);

  // --- 証明写真の出力 ---
  const [photoFormat, setPhotoFormat] = useState<"image/jpeg" | "image/png">("image/jpeg");
  const [photoStatus, setPhotoStatus] = useState<ProcessingState>("idle");
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoResult, setPhotoResult] = useState<ImageProcessorOutput | null>(null);

  // --- A4等へまとめて印刷 ---
  const [paperId, setPaperId] = useState<PaperSizeId>("A4");
  const [orientation, setOrientation] = useState<PaperOrientation>("portrait");
  const [marginMm, setMarginMm] = useState(10);
  const [gapMm, setGapMm] = useState(5);
  const [countOverride, setCountOverride] = useState<number | null>(null);
  const [sheetStatus, setSheetStatus] = useState<ProcessingState>("idle");
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetResult, setSheetResult] = useState<PdfProcessorOutput | null>(null);

  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setImageUrl(null);
      setNaturalSize(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    const img = new Image();
    img.onload = () => {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      setPhotoError("画像の読み込みに失敗しました。ファイルが壊れていないかご確認ください。");
      setPhotoStatus("error");
    };
    img.src = url;
    setPhotoResult(null);
    setSheetResult(null);
    setPhotoError(null);
    setSheetError(null);
    setPhotoStatus("idle");
    setSheetStatus("idle");
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // サイズ（比率）が変わったら、トリミング範囲を中央基準でリセットする
  useEffect(() => {
    if (!naturalSize || sizeError) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBox(defaultBoxForRatio(ratio, naturalSize));
    // widthMm/heightMmの変更を検知したいので、比率そのものではなく個々の値をdepsにする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize, presetId, widthMm, heightMm]);

  useEffect(() => {
    return () => {
      if (photoResult) URL.revokeObjectURL(photoResult.url);
    };
  }, [photoResult]);

  useEffect(() => {
    return () => {
      if (sheetResult) URL.revokeObjectURL(sheetResult.url);
    };
  }, [sheetResult]);

  function handleBoxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "move", startClientX: e.clientX, startClientY: e.clientY, startBox: box };
  }

  function handleHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, corner: Corner) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", corner, startClientX: e.clientX, startClientY: e.clientY, startBox: box };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container || !naturalSize) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dxPct = ((e.clientX - drag.startClientX) / rect.width) * 100;
    const dyPct = ((e.clientY - drag.startClientY) / rect.height) * 100;

    if (drag.mode === "move") {
      setBox(
        clampBox({ ...drag.startBox, xPct: drag.startBox.xPct + dxPct, yPct: drag.startBox.yPct + dyPct })
      );
      return;
    }

    let wPct = drag.startBox.wPct;
    const corner = drag.corner ?? "se";
    if (corner.includes("e")) wPct = drag.startBox.wPct + dxPct;
    if (corner.includes("w")) wPct = drag.startBox.wPct - dxPct;
    setBox(boxWithWidthPct(drag.startBox, wPct, ratio, naturalSize));
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function handleZoom(factor: number) {
    if (!naturalSize) return;
    setBox((b) => boxWithWidthPct(b, b.wPct * factor, ratio, naturalSize));
  }

  function handleCenter() {
    setBox((b) => clampBox({ ...b, xPct: (100 - b.wPct) / 2, yPct: (100 - b.hPct) / 2 }));
  }

  function handleReset() {
    if (!naturalSize) return;
    setBox(defaultBoxForRatio(ratio, naturalSize));
  }

  function computeCropRegion(): CropRegion {
    if (!naturalSize) throw new Error("画像を読み込んでください。");
    return {
      x: Math.round((box.xPct / 100) * naturalSize.width),
      y: Math.round((box.yPct / 100) * naturalSize.height),
      width: Math.round((box.wPct / 100) * naturalSize.width),
      height: Math.round((box.hPct / 100) * naturalSize.height),
    };
  }

  function targetPixelSize(): { width: number; height: number } {
    const targetWidth = mmToPx(widthMm, dpi);
    const targetHeight = mmToPx(heightMm, dpi);
    if (targetWidth * targetHeight > MAX_OUTPUT_PIXELS) {
      throw new Error("出力サイズが大きすぎます。サイズまたは解像度(dpi)を見直してください。");
    }
    return { width: targetWidth, height: targetHeight };
  }

  async function handlePhotoOutput() {
    if (!file || !naturalSize || sizeError) return;
    setPhotoStatus("processing");
    setPhotoError(null);
    try {
      const crop = computeCropRegion();
      const { width: targetWidth, height: targetHeight } = targetPixelSize();
      const output = await new ImageCropProcessor().process({
        file,
        crop,
        targetWidth,
        targetHeight,
        mimeType: photoFormat,
      });
      setPhotoResult(output);
      setPhotoStatus("success");
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : "処理に失敗しました");
      setPhotoStatus("error");
    }
  }

  // 用紙・余白・写真間隔・写真サイズから、最大何枚配置できるかを求める
  // （固定サイズのセルを敷き詰めるcomputeFixedSizeGridを利用。列数×行数を
  // 引き伸ばして埋めるcomputeGridCellsとは異なり、写真の物理サイズ(mm)を
  // 厳密に保つ）。PDF書き出しと配置プレビューで同じ結果を使う。
  const sheetLayout = useMemo(() => {
    const paperSizePt = resolvePaperSizePt(paperId, orientation);
    const canvasWidthPx = Math.round(paperSizePt.width);
    const canvasHeightPx = Math.round(paperSizePt.height);
    const cells = sizeError
      ? []
      : computeFixedSizeGrid({
          canvasWidthPx,
          canvasHeightPx,
          marginPx: mmToPt(marginMm),
          gapPx: mmToPt(gapMm),
          cellWidthPx: mmToPt(widthMm),
          cellHeightPx: mmToPt(heightMm),
        });
    return { canvasWidthPx, canvasHeightPx, cells };
  }, [paperId, orientation, marginMm, gapMm, widthMm, heightMm, sizeError]);
  const maxSheetCells = sheetLayout.cells.length;

  const effectiveSheetCount = Math.max(1, Math.min(countOverride ?? maxSheetCells, maxSheetCells || 1));

  async function handleSheetOutput() {
    if (!file || !naturalSize || sizeError) return;
    if (maxSheetCells === 0) {
      setSheetError(
        "この用紙サイズ・余白の組み合わせでは1枚も配置できません。余白を小さくするか、用紙サイズを変更してください。"
      );
      setSheetStatus("error");
      return;
    }
    setSheetStatus("processing");
    setSheetError(null);
    try {
      const crop = computeCropRegion();
      const { width: targetWidth, height: targetHeight } = targetPixelSize();
      const cropped = await new ImageCropProcessor().process({
        file,
        crop,
        targetWidth,
        targetHeight,
        mimeType: "image/jpeg",
      });
      const photoFile = new File([cropped.blob], "passport-photo.jpg", { type: cropped.blob.type });

      const { canvasWidthPx, canvasHeightPx, cells: allCells } = sheetLayout;
      const cells = allCells.slice(0, effectiveSheetCount);
      const items: ImageLayoutItem[] = cells.map((cell, i) => ({
        id: `passport-photo-${i}`,
        kind: "image",
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        rotation: 0,
        zIndex: i,
        fit: "cover",
        imageIndex: 0,
      }));

      const output = await new ImageLayoutRenderProcessor().process({
        files: [photoFile],
        canvas: { widthPx: canvasWidthPx, heightPx: canvasHeightPx, backgroundColor: "#ffffff" },
        items,
        format: "pdf",
        pdfPageSizePt: { width: canvasWidthPx, height: canvasHeightPx },
      });
      if (!("pageCount" in output)) {
        throw new Error("PDFの生成に失敗しました");
      }
      setSheetResult(output);
      setSheetStatus("success");
    } catch (e) {
      setSheetError(e instanceof Error ? e.message : "処理に失敗しました");
      setSheetStatus("error");
    }
  }

  const photoExt = EXT_BY_MIME[photoFormat] ?? "jpg";
  const photoDownloadName = file
    ? `${stripExtension(file.name)}_証明写真_${widthMm}x${heightMm}.${photoExt}`
    : `passport-photo.${photoExt}`;
  const sheetDownloadName = file
    ? `${stripExtension(file.name)}_証明写真_${PAPER_SIZE_LABELS[paperId]}シート.pdf`
    : "passport-photo-sheet.pdf";

  // 実際に表示されているCanvas上の座標系で、%指定のトリミング枠を描くための
  // ライブプレビュー（image-crop-tool.tsxと同じ「枠を画像に重ねる」方式に加え、
  // Processorを都度呼ばずCSSだけで「完成予定図」も同時に見せる）。
  const previewImgWidthPx = naturalSize ? PREVIEW_WIDTH_PX * (100 / box.wPct) : 0;
  const previewImgHeightPx = naturalSize ? previewImgWidthPx * (naturalSize.height / naturalSize.width) : 0;
  const previewLeftPx = -(box.xPct / 100) * previewImgWidthPx;
  const previewTopPx = -(box.yPct / 100) * previewImgHeightPx;
  const previewHeightPx = ratio > 0 ? PREVIEW_WIDTH_PX / ratio : PREVIEW_WIDTH_PX;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setPhotoError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">証明写真サイズ</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setPresetId(preset.id)}
                className={`rounded-lg border-2 px-3 py-1.5 text-sm font-medium transition-colors ${
                  presetId === preset.id
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                    : "border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-300"
                }`}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPresetId("custom")}
              className={`rounded-lg border-2 px-3 py-1.5 text-sm font-medium transition-colors ${
                presetId === "custom"
                  ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                  : "border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-300"
              }`}
            >
              カスタム
            </button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            用途によって必要なサイズ・要件は異なります。提出先の規定を必ずご確認ください。
          </p>

          {presetId === "custom" && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-sm">
                幅 (mm)
                <input
                  type="number"
                  min={1}
                  max={MAX_MM}
                  value={customWidthMm}
                  onChange={(e) => setCustomWidthMm(Number(e.target.value))}
                  className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                高さ (mm)
                <input
                  type="number"
                  min={1}
                  max={MAX_MM}
                  value={customHeightMm}
                  onChange={(e) => setCustomHeightMm(Number(e.target.value))}
                  className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="w-fit text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {showAdvanced ? "詳細設定を閉じる" : "詳細設定（解像度）を表示"}
          </button>
          {showAdvanced && (
            <label className="flex w-fit flex-col gap-1 text-sm">
              解像度 (dpi・印刷用途は300を推奨)
              <input
                type="number"
                min={MIN_DPI}
                max={MAX_DPI}
                value={dpi}
                onChange={(e) => setDpi(Number(e.target.value))}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}

          {sizeError ? (
            <ErrorMessage message={sizeError} />
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              出力サイズ: {widthMm} × {heightMm}mm（{mmToPx(widthMm, dpi)} × {mmToPx(heightMm, dpi)}px, {dpi}dpi）
            </p>
          )}
        </div>
      )}

      {file && imageUrl && naturalSize && !sizeError && (
        <div data-testid="tool-preview" className="flex flex-col gap-3">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">トリミング・位置調整</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div
              ref={containerRef}
              className="relative w-full max-w-md touch-none select-none overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700"
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="トリミング対象の画像"
                draggable={false}
                className="block h-auto w-full select-none"
              />
              <div
                onPointerDown={handleBoxPointerDown}
                className="absolute cursor-move border-2 border-blue-400 bg-blue-400/10"
                style={{
                  left: `${box.xPct}%`,
                  top: `${box.yPct}%`,
                  width: `${box.wPct}%`,
                  height: `${box.hPct}%`,
                }}
              >
                {CORNERS.map((corner) => (
                  <div
                    key={corner}
                    onPointerDown={(e) => handleHandlePointerDown(e, corner)}
                    aria-label={`トリミング範囲の${corner}角をドラッグして拡大縮小`}
                    className={`absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-blue-500 shadow ${
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
              </div>
            </div>

            <div className="flex shrink-0 flex-col items-center gap-2">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">プレビュー</p>
              <div
                style={{ width: PREVIEW_WIDTH_PX, height: previewHeightPx }}
                className="relative overflow-hidden rounded-md border border-neutral-300 bg-neutral-900 dark:border-neutral-700"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt="完成予定プレビュー"
                  draggable={false}
                  style={{
                    position: "absolute",
                    width: previewImgWidthPx,
                    height: previewImgHeightPx,
                    left: previewLeftPx,
                    top: previewTopPx,
                    maxWidth: "none",
                  }}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleZoom(1 / 1.1)}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              拡大 +
            </button>
            <button
              type="button"
              onClick={() => handleZoom(1.1)}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              縮小 −
            </button>
            <button
              type="button"
              onClick={handleCenter}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              中央配置
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              リセット
            </button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            枠をドラッグして位置調整、四隅のハンドルまたは拡大/縮小ボタンでズームできます。
          </p>
        </div>
      )}

      {file && !sizeError && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">① 証明写真として保存</p>
          <div className="flex flex-wrap gap-2">
            {(["image/jpeg", "image/png"] as const).map((mime) => (
              <button
                key={mime}
                type="button"
                onClick={() => setPhotoFormat(mime)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  photoFormat === mime
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {mime === "image/jpeg" ? "JPEG" : "PNG"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handlePhotoOutput}
            disabled={photoStatus === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            画像を書き出す
          </button>
          <ProcessingStatus state={photoStatus} successLabel="書き出しが完了しました" />
          {photoError && <ErrorMessage message={photoError} />}
          {photoResult && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoResult.url}
                alt="証明写真の完成プレビュー"
                className="max-h-64 rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {photoResult.width} × {photoResult.height}px ・ {formatBytes(photoResult.sizeBytes)}
              </p>
              <RewardedDownloadGate onDownload={() => downloadBlob(photoResult.blob, photoDownloadName)} />
            </div>
          )}
        </div>
      )}

      {file && !sizeError && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            ② A4等の用紙にまとめて印刷（PDF）
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              用紙サイズ
              <select
                value={paperId}
                onChange={(e) => setPaperId(e.target.value as PaperSizeId)}
                className="rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              >
                {PAPER_SIZE_IDS.map((id) => (
                  <option key={id} value={id}>
                    {PAPER_SIZE_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOrientation("portrait")}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  orientation === "portrait"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                縦
              </button>
              <button
                type="button"
                onClick={() => setOrientation("landscape")}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  orientation === "landscape"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                横
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              余白 (mm)
              <input
                type="number"
                min={0}
                max={MAX_MM}
                value={marginMm}
                onChange={(e) => setMarginMm(Number(e.target.value))}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              写真間隔 (mm)
              <input
                type="number"
                min={0}
                max={MAX_MM}
                value={gapMm}
                onChange={(e) => setGapMm(Number(e.target.value))}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              枚数（最大{maxSheetCells}枚）
              <input
                type="number"
                min={1}
                max={Math.max(1, maxSheetCells)}
                value={effectiveSheetCount}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setCountOverride(Number.isFinite(v) ? v : null);
                }}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <button
              type="button"
              onClick={() => setCountOverride(null)}
              className="h-fit rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              自動（最大枚数）
            </button>
          </div>
          {imageUrl && naturalSize && (
            <div className="flex flex-col gap-1" data-testid="sheet-preview">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                配置プレビュー（{PAPER_SIZE_LABELS[paperId]}・{maxSheetCells === 0 ? "配置できません" : `${effectiveSheetCount}枚`}）
              </p>
              <div
                className="relative w-full max-w-[16rem] overflow-hidden border border-neutral-300 bg-white shadow-sm dark:border-neutral-600"
                style={{ aspectRatio: `${sheetLayout.canvasWidthPx} / ${sheetLayout.canvasHeightPx}` }}
              >
                {sheetLayout.cells.slice(0, effectiveSheetCount).map((cell, i) => (
                  <div
                    key={i}
                    className="absolute overflow-hidden bg-neutral-200"
                    style={{
                      left: `${(cell.x / sheetLayout.canvasWidthPx) * 100}%`,
                      top: `${(cell.y / sheetLayout.canvasHeightPx) * 100}%`,
                      width: `${(cell.width / sheetLayout.canvasWidthPx) * 100}%`,
                      height: `${(cell.height / sheetLayout.canvasHeightPx) * 100}%`,
                    }}
                  >
                    {/* 実際のトリミング範囲を各マスへ表示する(出力と同じ位置・枚数) */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={imageUrl}
                      alt=""
                      draggable={false}
                      className="absolute max-w-none select-none"
                      style={{
                        width: `${(100 / box.wPct) * 100}%`,
                        height: `${(100 / box.hPct) * 100}%`,
                        left: `${-(box.xPct / box.wPct) * 100}%`,
                        top: `${-(box.yPct / box.hPct) * 100}%`,
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={handleSheetOutput}
            disabled={sheetStatus === "processing" || maxSheetCells === 0}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            PDFを書き出す
          </button>
          <ProcessingStatus state={sheetStatus} processingLabel="PDFを作成中..." successLabel="PDFの作成が完了しました" />
          {sheetError && <ErrorMessage message={sheetError} />}
          {sheetResult && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {PAPER_SIZE_LABELS[paperId]}・{effectiveSheetCount}枚配置 ・ {formatBytes(sheetResult.sizeBytes)}
              </p>
              <RewardedDownloadGate onDownload={() => downloadBlob(sheetResult.blob, sheetDownloadName)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
