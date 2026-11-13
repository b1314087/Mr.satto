"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { SliderField } from "@/components/common/slider-field";
import { loadImage } from "@/lib/processors/browser/image";
import {
  ImageMosaicProcessor,
  applyMosaicRegions,
  MIN_LEVEL,
  MAX_LEVEL,
  DEFAULT_LEVEL,
  MAX_REGIONS,
  type MosaicRegion,
  type MosaicKind,
} from "@/lib/processors/browser/image-mosaic";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun } from "@/components/common/use-batch-run";

/**
 * 画像モザイク（Step 8）。
 *
 * 「画像レイアウト」「画像結合」「画像一括余白・文字入れ」「画像タイル分割」の
 * いずれとも別役割：1枚の画像の内側の一部（顔・ナンバープレート・個人情報等）を
 * モザイク／ぼかしで隠すための専用ツール。今回のスコープは静止画・矩形選択のみで、
 * 動画トラッキング・AI顔検出・ブラシ編集は対象外（開発指示書2章・24〜26章）。
 *
 * 座標設計（開発指示書22〜23章）: 各範囲は常に「元画像の実ピクセル座標系」で
 * 保持する（MosaicRegion.x/y/width/height）。画面上には
 * `naturalPx × 現在のズーム倍率(scale)` で毎回変換して表示するだけなので、
 * ズームしても・画面サイズが変わっても、範囲が指す元画像上の位置はずれない。
 *
 * プレビュー設計（開発指示書15・30章）: ドラッグ中は範囲の枠線だけを
 * 軽量に動かし（再処理なし）、操作が止まってから500ms後に実際の
 * ImageMosaicProcessorを1回だけ呼んで背景画像を更新する
 * （画像結合・画像一括余白/文字入れと同じデバウンス方式）。背景には常に
 * 「直近のモザイク済み画像」を表示し続けるため、元画像に戻って迷うことがない。
 */

const MIN_REGION_SIZE_PX = 8;
const ZOOM_PRESETS = [25, 50, 75, 150, 200, 300];
// 大きな写真（カメラの写真など）でも「画面に合わせる」で全体が収まるよう、1%まで小さくできる
const MIN_ZOOM = 1;
/** プレビュー欄の高さの上限（px）。「画面に合わせる」も、この高さに収まる倍率にする */
const PREVIEW_MAX_HEIGHT = 512;
const MAX_ZOOM = 400;

type Corner = "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: "move" | "resize";
  corner?: Corner;
  regionId: string;
  startClientX: number;
  startClientY: number;
  startRegion: MosaicRegion;
  /** ドラッグ開始時点の 画面px / 元画像px 比率（そのドラッグ中はこの値で固定する） */
  scale: number;
}

const KIND_LABEL: Record<MosaicKind, string> = { mosaic: "モザイク", blur: "ぼかし" };

function clampRegionBox(region: MosaicRegion, imgWidth: number, imgHeight: number): MosaicRegion {
  const width = Math.min(Math.max(Math.round(region.width), MIN_REGION_SIZE_PX), imgWidth);
  const height = Math.min(Math.max(Math.round(region.height), MIN_REGION_SIZE_PX), imgHeight);
  const x = Math.min(Math.max(Math.round(region.x), 0), Math.max(0, imgWidth - width));
  const y = Math.min(Math.max(Math.round(region.y), 0), Math.max(0, imgHeight - height));
  return { ...region, x, y, width, height };
}

/**
 * 一括処理で、1枚目の画像で決めた範囲を、ほかの画像に当てはめる。
 * 範囲は1枚目の画像のピクセルで持っているので、画像の幅・高さの比で伸び縮みさせ、同じ割合の位置にする
 * （同じ大きさの画像なら、まったく同じ位置になる）。
 */
export function scaleMosaicRegions(
  regions: readonly MosaicRegion[],
  base: { width: number; height: number },
  target: { width: number; height: number }
): MosaicRegion[] {
  const sx = target.width / Math.max(1, base.width);
  const sy = target.height / Math.max(1, base.height);
  return regions.map((r) =>
    clampRegionBox({ ...r, x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy }, target.width, target.height)
  );
}

export function ImageMosaicTool() {
  // 選んだ画像。2枚以上のとき（プレミアムの一括処理）は、1枚目で決めた範囲を、ほかの画像にも同じ割合の位置で当てはめる
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("image-mosaic");
  const batchRun = useBatchRun();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [regions, setRegions] = useState<MosaicRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  const containerRef = useRef<HTMLDivElement>(null);
  /** 画像を読み込んだあと、表示欄ができてから「画面に合わせる」倍率にする（縦長・横長のどちらでも、最初は画面に収まる大きさ） */
  const fitPendingRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const nextIdRef = useRef(1);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    if (!file) {
      // ファイル選択解除時に関連stateをリセットする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setImageUrl(null);
      setNaturalSize(null);
      setRegions([]);
      setSelectedId(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setLoadError(null);
    const img = new Image();
    img.onload = () => {
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      setNaturalSize(size);
      fitPendingRef.current = true;
    };
    img.onerror = () => {
      setLoadError(
        "画像を読み込めませんでした。ファイルが壊れているか、対応していない形式の可能性があります"
      );
    };
    img.src = url;
    setRegions([]);
    setSelectedId(null);
    setResult(null);
    setError(null);
    setStatus("idle");
    setZoomPercent(100);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // --- プレビュー（総合改修 21）---
  // 以前は、操作が止まって500ms後に書き出しと同じ処理をかけた画像を背景に出していたため、
  // ドラッグ中や直後は「古い位置のモザイク」が見え、枠と結果がずれて見えていた。
  // いまは、元画像を元の解像度のままCanvasに描き、書き出しと同じ関数（applyMosaicRegions）で
  // 範囲を変えるたびにすぐ描き直す。表示は画面の倍率に縮めるだけなので、位置・範囲・大きさ・見た目が出力と一致する。
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [baseReadyFor, setBaseReadyFor] = useState<File | null>(null);

  useEffect(() => {
    baseCanvasRef.current = null;
    if (!file) return;
    let cancelled = false;
    (async () => {
      try {
        const img = await loadImage(file);
        if (cancelled) return;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        baseCanvasRef.current = c;
        setBaseReadyFor(file);
      } catch {
        // 読み込みの失敗は、上の読み込み処理（loadError）で知らせる
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const baseReady = !!file && baseReadyFor === file;
  useEffect(() => {
    const base = baseCanvasRef.current;
    const canvas = previewCanvasRef.current;
    if (!baseReady || !base || !canvas) return;
    const frame = requestAnimationFrame(() => {
      if (canvas.width !== base.width) canvas.width = base.width;
      if (canvas.height !== base.height) canvas.height = base.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      applyMosaicRegions(ctx, canvas, regions);
    });
    return () => cancelAnimationFrame(frame);
  }, [baseReady, regions, zoomPercent]);

  const selectedRegion = useMemo(
    () => regions.find((r) => r.id === selectedId) ?? null,
    [regions, selectedId]
  );

  function updateRegion(id: string, patch: Partial<MosaicRegion>) {
    if (!naturalSize) return;
    setRegions((prev) =>
      prev.map((r) =>
        r.id === id ? clampRegionBox({ ...r, ...patch }, naturalSize.width, naturalSize.height) : r
      )
    );
  }

  function addRegion() {
    if (!naturalSize) return;
    if (regions.length >= MAX_REGIONS) {
      setError(`追加できる範囲は最大${MAX_REGIONS}個までです`);
      return;
    }
    const w = Math.max(MIN_REGION_SIZE_PX, Math.round(naturalSize.width * 0.2));
    const h = Math.max(MIN_REGION_SIZE_PX, Math.round(naturalSize.height * 0.2));
    const stepBase = Math.round(Math.min(naturalSize.width, naturalSize.height) * 0.04);
    const offset = (regions.length % 6) * stepBase;
    const x = Math.min(
      Math.max(Math.round((naturalSize.width - w) / 2) + offset, 0),
      Math.max(0, naturalSize.width - w)
    );
    const y = Math.min(
      Math.max(Math.round((naturalSize.height - h) / 2) + offset, 0),
      Math.max(0, naturalSize.height - h)
    );
    // 新しい範囲は指示書13章の通りモザイクをデフォルトとする
    const region: MosaicRegion = {
      id: `region-${nextIdRef.current++}`,
      kind: "mosaic",
      x,
      y,
      width: w,
      height: h,
      level: DEFAULT_LEVEL,
    };
    setRegions((prev) => [...prev, region]);
    setSelectedId(region.id);
    setError(null);
  }

  function removeRegion(id: string) {
    setRegions((prev) => prev.filter((r) => r.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }

  function handleReset() {
    setRegions([]);
    setSelectedId(null);
    setError(null);
  }

  function handleRegionPointerDown(e: ReactPointerEvent<HTMLDivElement>, region: MosaicRegion) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedId(region.id);
    dragRef.current = {
      mode: "move",
      regionId: region.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRegion: region,
      scale: zoomPercent / 100,
    };
  }

  // corner引数をクロージャで直接キャプチャせず、DOM要素のdata属性から読み取る。
  // （regions.map内のcorner.map由来の値をそのままコールバック引数として
  // 渡すと、なぜかReact Compilerのref解析(`react-hooks/refs`)が実行時には
  // 発生しない誤検知を出すため、data属性経由に変更して回避している）
  function handleHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, region: MosaicRegion) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const corner = (e.currentTarget.dataset.corner ?? "se") as Corner;
    setSelectedId(region.id);
    dragRef.current = {
      mode: "resize",
      corner,
      regionId: region.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startRegion: region,
      scale: zoomPercent / 100,
    };
  }

  function handleStagePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dxImg = (e.clientX - drag.startClientX) / drag.scale;
    const dyImg = (e.clientY - drag.startClientY) / drag.scale;

    if (drag.mode === "move") {
      updateRegion(drag.regionId, {
        x: drag.startRegion.x + dxImg,
        y: drag.startRegion.y + dyImg,
      });
      return;
    }

    let { x, y, width, height } = drag.startRegion;
    const corner = drag.corner ?? "se";
    if (corner.includes("e")) width = drag.startRegion.width + dxImg;
    if (corner.includes("s")) height = drag.startRegion.height + dyImg;
    if (corner.includes("w")) {
      width = drag.startRegion.width - dxImg;
      x = drag.startRegion.x + dxImg;
    }
    if (corner.includes("n")) {
      height = drag.startRegion.height - dyImg;
      y = drag.startRegion.y + dyImg;
    }
    updateRegion(drag.regionId, { x, y, width, height });
  }

  function handleStagePointerUp() {
    dragRef.current = null;
  }

  function handleStageBackgroundPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) setSelectedId(null);
  }

  function zoomTo(percent: number) {
    setZoomPercent(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent))));
  }

  /**
   * 画面に合わせる倍率：プレビュー欄の幅と高さ（欄の高さの上限と、画面の高さの7割の小さい方）の両方に、
   * 画像の全体が収まる倍率（100%より大きくはしない）。縦長の画像は高さで、横長の画像は幅で決まる。
   * 少しでもはみ出すとスクロールが出て端が切れて見えるため、切り捨てで求める。
   */
  function fitZoomPercent(size: { width: number; height: number }): number {
    const container = containerRef.current;
    const availableWidth = container?.clientWidth || size.width;
    const viewport = typeof window !== "undefined" ? Math.max(240, window.innerHeight * 0.7) : PREVIEW_MAX_HEIGHT;
    const availableHeight = Math.min(PREVIEW_MAX_HEIGHT, viewport) - 2; // 枠線の分
    const fit = Math.min(availableWidth / size.width, availableHeight / size.height) * 100;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(Math.min(100, fit))));
  }

  useEffect(() => {
    if (!naturalSize || !fitPendingRef.current || !containerRef.current) return;
    fitPendingRef.current = false;
    // 画面より小さい画像は100%のまま
    setZoomPercent(fitZoomPercent(naturalSize));
  }, [naturalSize]);

  function handleZoomFit() {
    if (!naturalSize) return;
    zoomTo(fitZoomPercent(naturalSize));
  }

  // 範囲を変えたら、前の範囲でまとめて処理した結果は捨てる（違う設定の結果を保存させない）
  const resetBatch = batchRun.reset;
  useEffect(() => {
    resetBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions]);

  function handleSelect(selected: File[]) {
    setFiles(batch.pick(files, selected, "append"));
    batchRun.reset();
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    batchRun.reset();
    setStatus("idle");
  }

  /** 一括処理：1枚目で決めた範囲を、すべての画像に同じ割合の位置で当てはめて、1枚ずつモザイクをかける */
  async function handleSaveBatch(format: "png" | "jpeg") {
    if (!naturalSize) return;
    if (!(await batch.confirmBatch(files.length))) return;
    const base = naturalSize;
    const usedRegions = regions;
    setStatus("processing");
    setError(null);
    const items = await batchRun.run(files, async (target) => {
      const img = await loadImage(target);
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      const output = await new ImageMosaicProcessor().process({ file: target, regions: scaleMosaicRegions(usedRegions, base, size), format });
      URL.revokeObjectURL(output.url);
      return {
        blob: output.blob,
        outputName: `${stripExtension(target.name)}_mosaic.${output.mimeType === "image/png" ? "png" : "jpg"}`,
        detail: `${output.width}×${output.height}px`,
      };
    });
    const summary = summarizeBatch(items, "すべての画像でモザイク処理に失敗しました");
    setStatus(summary.status);
    setError(summary.error);
  }

  async function handleSave(format: "png" | "jpeg") {
    if (!file) return;
    if (regions.length === 0) {
      setError("モザイク領域を1つ以上指定してください");
      return;
    }
    if (isBatch) {
      await handleSaveBatch(format);
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImageMosaicProcessor().process({ file, regions, format });
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return output;
      });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const baseName = file ? stripExtension(file.name) : "image";
  const scale = zoomPercent / 100;
  const stageWidth = naturalSize ? Math.round(naturalSize.width * scale) : 0;
  const stageHeight = naturalSize ? Math.round(naturalSize.height * scale) : 0;

  return (
    <PreviewSplitLayout
      preview={
        file && imageUrl && naturalSize ? (
          <div className="flex flex-col gap-4">
          <div
            ref={containerRef}
            data-testid="tool-preview"
            className="w-full max-w-full overflow-auto rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700"
            // サイト共通の scrollbar-gutter: stable（globals.css）が効くと、右にスクロールバー分の黒い帯ができ、真ん中からずれるため、ここでは外す
            style={{ maxHeight: PREVIEW_MAX_HEIGHT, scrollbarGutter: "auto" }}
          >
            <div
              // 欄より小さいときは真ん中に置く（右側に空いた黒い余白だけが目立たないように）
              className="relative mx-auto select-none"
              style={{ width: stageWidth, height: stageHeight }}
              onPointerDown={handleStageBackgroundPointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerUp}
            >
              <canvas
                ref={previewCanvasRef}
                aria-label="モザイク編集対象の画像（プレビュー）"
                data-testid="mosaic-preview-canvas"
                className="pointer-events-none block select-none"
                style={{ width: stageWidth, height: stageHeight }}
              />

              {regions.map((region) => {
                const selected = region.id === selectedId;
                const colorClass =
                  region.kind === "blur"
                    ? "border-purple-400 bg-purple-400/10"
                    : "border-blue-400 bg-blue-400/10";
                return (
                  <div
                    key={region.id}
                    onPointerDown={(e) => handleRegionPointerDown(e, region)}
                    aria-label={`${KIND_LABEL[region.kind]}の範囲${selected ? "（選択中）" : ""}`}
                    className={`absolute touch-none cursor-move border-2 ${colorClass} ${
                      selected ? "ring-2 ring-white/80" : ""
                    }`}
                    style={{
                      left: region.x * scale,
                      top: region.y * scale,
                      width: region.width * scale,
                      height: region.height * scale,
                    }}
                  >
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => removeRegion(region.id)}
                      aria-label={`${KIND_LABEL[region.kind]}の範囲を削除`}
                      className="absolute -right-2 -top-2 flex h-5 w-5 touch-none items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white shadow"
                    >
                      ×
                    </button>
                    {selected &&
                      (["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                        <div
                          key={corner}
                          data-corner={corner}
                          onPointerDown={(e) => handleHandlePointerDown(e, region)}
                          aria-label={`範囲の${corner}角をドラッグしてサイズ変更`}
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
                );
              })}
            </div>
          </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">画像を追加してください。</div>
        )
      }
      previewWidth="lg"
    >
      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）。隠したい範囲は1枚の画像に複数指定できます"
        multiple
        onFilesSelected={handleSelect}
        onError={setError}
      />
      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} unit="枚" />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}
      {isBatch && (
        <p data-testid="batch-mosaic-note" className="text-xs text-ms-muted">
          1枚目の画像で決めた範囲を、ほかの画像にも同じ割合の位置で当てはめます（同じ大きさの画像なら、同じ位置になります）。
        </p>
      )}
      {loadError && <ErrorMessage message={loadError} />}

      {file && imageUrl && naturalSize && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addRegion}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              ＋ 範囲を追加
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={regions.length === 0}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-600 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300"
            >
              編集をリセット
            </button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {regions.length}個の範囲
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="表示倍率">
            <button
              type="button"
              onClick={() => zoomTo(zoomPercent - 25)}
              aria-label="縮小"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            >
              －
            </button>
            <span data-testid="zoom-percent-display" className="w-14 text-center text-sm tabular-nums">{zoomPercent}%</span>
            <button
              type="button"
              onClick={() => zoomTo(zoomPercent + 25)}
              aria-label="拡大"
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            >
              ＋
            </button>
            <button
              type="button"
              onClick={handleZoomFit}
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            >
              画面に合わせる
            </button>
            <button
              type="button"
              onClick={() => zoomTo(100)}
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            >
              100%
            </button>
            {ZOOM_PRESETS.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => zoomTo(z)}
                aria-pressed={zoomPercent === z}
                className={`hidden rounded px-2 py-1 text-sm sm:inline-block ${
                  zoomPercent === z
                    ? "bg-blue-600 text-white"
                    : "border border-neutral-300 dark:border-neutral-700"
                }`}
              >
                {z}%
              </button>
            ))}
          </div>

          <SliderField
            label="表示倍率（ズーム）"
            value={zoomPercent}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            unit="%"
            onChange={zoomTo}
            hint="表示の大きさだけが変わります（範囲の位置・大きさと、書き出す画像は変わりません）。"
          />

          {regions.length > 0 && (
            <div className="ms-seg">
              {regions.map((region, index) => (
                <button aria-pressed={region.id === selectedId}
                  key={region.id}
                  type="button"
                  onClick={() => setSelectedId(region.id)}
                >
                  {index + 1}: {KIND_LABEL[region.kind]}
                </button>
              ))}
            </div>
          )}

          {selectedRegion && naturalSize && (
            <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                選択中の範囲の設定
              </p>

              <div className="flex flex-col gap-2">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">種類</p>
                <div className="ms-seg">
                  {(["mosaic", "blur"] as MosaicKind[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => updateRegion(selectedRegion.id, { kind })}
                      aria-pressed={selectedRegion.kind === kind}
                    >
                      {KIND_LABEL[kind]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                  <span>弱い</span>
                  <span>強度: {selectedRegion.level}</span>
                  <span>強い</span>
                </div>
                <input
                  type="range"
                  min={MIN_LEVEL}
                  max={MAX_LEVEL}
                  step={1}
                  value={selectedRegion.level}
                  onChange={(e) =>
                    updateRegion(selectedRegion.id, { level: Number(e.target.value) })
                  }
                  aria-label="モザイク・ぼかしの強度"
                  className="w-full"
                />
              </div>

              {/* 総合改修 21：位置（X・Y）と大きさ（幅・高さ）をバーでも動かせる。数値でも確認・入力できる（元画像のピクセル） */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="mosaic-region-sliders">
                {(
                  [
                    { key: "x", label: "X(px)", bar: "横の位置（X）", max: Math.max(0, naturalSize.width - selectedRegion.width), min: 0 },
                    { key: "y", label: "Y(px)", bar: "縦の位置（Y）", max: Math.max(0, naturalSize.height - selectedRegion.height), min: 0 },
                    { key: "width", label: "幅(px)", bar: "範囲の幅", max: naturalSize.width, min: MIN_REGION_SIZE_PX },
                    { key: "height", label: "高さ(px)", bar: "範囲の高さ", max: naturalSize.height, min: MIN_REGION_SIZE_PX },
                  ] as const
                ).map((f) => (
                  <div key={f.key} className="flex flex-col gap-1">
                    <label className="flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <span>{f.bar}</span>
                      <span className="flex items-center gap-1">
                        <span className="sr-only">{f.label}</span>
                        <input
                          type="number"
                          aria-label={f.label}
                          value={Math.round(selectedRegion[f.key])}
                          onChange={(e) => updateRegion(selectedRegion.id, { [f.key]: Number(e.target.value) })}
                          className="w-20 rounded border border-neutral-300 px-2 py-1 text-right text-sm text-neutral-900 tabular-nums dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                        />
                        px
                      </span>
                    </label>
                    <input
                      type="range"
                      aria-label={`${f.bar}のバー`}
                      min={f.min}
                      max={Math.max(f.min, f.max)}
                      step={1}
                      value={Math.round(selectedRegion[f.key])}
                      onChange={(e) => updateRegion(selectedRegion.id, { [f.key]: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={() => removeRegion(selectedRegion.id)}
                className="w-fit rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                この範囲を削除
              </button>
            </div>
          )}

          <RunBar>
            <button
              type="button"
              onClick={() => void handleSave("png")}
              disabled={status === "processing" || regions.length === 0} aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {isBatch ? `${files.length}枚をまとめてPNGで保存` : "PNGで保存"}
            </button>
            <button
              type="button"
              onClick={() => void handleSave("jpeg")}
              disabled={status === "processing" || regions.length === 0} aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-neutral-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              {isBatch ? `${files.length}枚をまとめてJPEGで保存` : "JPEGで保存"}
            </button>
          </RunBar>
        </div>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={isBatch ? batchRun.progressLabel("モザイクをかけています") : undefined}
        successLabel="モザイク処理が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${baseName}_mosaic.zip`} />

      {result && !isBatch && (
        <ResultPopup>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.url}
            alt="モザイク処理結果のプレビュー"
            className="max-h-[min(55vh,28rem)] max-w-full object-contain"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px（元画像と同じサイズ）・{formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate
            onDownload={() =>
              downloadBlob(
                result.blob,
                `${baseName}_mosaic.${result.mimeType === "image/png" ? "png" : "jpg"}`
              )
            }
          />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
