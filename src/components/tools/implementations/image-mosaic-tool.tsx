"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImageMosaicProcessor,
  MIN_LEVEL,
  MAX_LEVEL,
  DEFAULT_LEVEL,
  MAX_REGIONS,
  type MosaicRegion,
  type MosaicKind,
} from "@/lib/processors/browser/image-mosaic";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

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
const MIN_ZOOM = 10;
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

export function ImageMosaicTool() {
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [regions, setRegions] = useState<MosaicRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const nextIdRef = useRef(1);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  const [previewResult, setPreviewResult] = useState<ImageProcessorOutput | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRunIdRef = useRef(0);

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
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
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

  useEffect(() => {
    return () => {
      if (previewResult) URL.revokeObjectURL(previewResult.url);
    };
  }, [previewResult]);

  const canProcess = !!file && !!naturalSize;

  // ライブプレビュー: 範囲のドラッグ中は枠線の再描画だけ（軽量）に留め、
  // 操作が止まって500ms経ってから実際のProcessorを1回だけ呼ぶ。
  useEffect(() => {
    // 範囲が1つもない場合は、Processorが例外を投げるようになった（保存時の
    // 安全対策）ため、ここでも処理自体をスキップし、プレビューは元画像
    // （stageImageUrlのフォールバック）にそのまま戻す。こうしないと、範囲を
    // 最後の1つまで削除した際に、直前の（モザイク適用済みの）古いプレビュー画像が
    // 残り続けてしまう。
    if (!canProcess || !file || regions.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
      setPreviewLoading(false);
      return;
    }
    const runId = ++previewRunIdRef.current;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const output = await new ImageMosaicProcessor().process({ file, regions, format: "png" });
          if (previewRunIdRef.current !== runId) {
            // 追い越された古い結果は破棄する
            URL.revokeObjectURL(output.url);
            return;
          }
          setPreviewResult((prev) => {
            if (prev) URL.revokeObjectURL(prev.url);
            return output;
          });
          setPreviewLoading(false);
        } catch {
          if (previewRunIdRef.current === runId) setPreviewLoading(false);
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [file, regions, canProcess]);

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

  function handleZoomFit() {
    const container = containerRef.current;
    if (!container || !naturalSize) return;
    const availableWidth = container.clientWidth || naturalSize.width;
    const fitPercent = (availableWidth / naturalSize.width) * 100;
    zoomTo(Math.min(100, fitPercent));
  }

  async function handleSave(format: "png" | "jpeg") {
    if (!file) return;
    if (regions.length === 0) {
      setError("モザイク領域を1つ以上指定してください");
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
  const stageImageUrl = previewResult?.url ?? imageUrl;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）。隠したい範囲は1枚の画像に複数指定できます"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
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
              {previewLoading ? "・プレビュー更新中…" : ""}
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

          <div
            ref={containerRef}
            data-testid="tool-preview"
            className="w-full max-w-full overflow-auto rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700"
            style={{ maxHeight: "32rem" }}
          >
            <div
              className="relative select-none"
              style={{ width: stageWidth, height: stageHeight }}
              onPointerDown={handleStageBackgroundPointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerUp}
            >
              {stageImageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={stageImageUrl}
                  alt="モザイク編集対象の画像"
                  draggable={false}
                  className="pointer-events-none block select-none"
                  style={{ width: stageWidth, height: stageHeight }}
                />
              )}

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
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            枠をドラッグして移動、四隅のハンドルでサイズ変更できます。ズームしても範囲は元画像上の同じ位置を維持します。
          </p>

          {regions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {regions.map((region, index) => (
                <button
                  key={region.id}
                  type="button"
                  onClick={() => setSelectedId(region.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    region.id === selectedId
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {index + 1}: {KIND_LABEL[region.kind]}
                </button>
              ))}
            </div>
          )}

          {selectedRegion && (
            <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                選択中の範囲の設定
              </p>

              <div className="flex flex-col gap-2">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">種類</p>
                <div className="flex gap-2">
                  {(["mosaic", "blur"] as MosaicKind[]).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => updateRegion(selectedRegion.id, { kind })}
                      aria-pressed={selectedRegion.kind === kind}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                        selectedRegion.kind === kind
                          ? "bg-blue-600 text-white"
                          : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                      }`}
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

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                  X(px)
                  <input
                    type="number"
                    value={Math.round(selectedRegion.x)}
                    onChange={(e) => updateRegion(selectedRegion.id, { x: Number(e.target.value) })}
                    className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                  Y(px)
                  <input
                    type="number"
                    value={Math.round(selectedRegion.y)}
                    onChange={(e) => updateRegion(selectedRegion.id, { y: Number(e.target.value) })}
                    className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                  幅(px)
                  <input
                    type="number"
                    value={Math.round(selectedRegion.width)}
                    onChange={(e) =>
                      updateRegion(selectedRegion.id, { width: Number(e.target.value) })
                    }
                    className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                  高さ(px)
                  <input
                    type="number"
                    value={Math.round(selectedRegion.height)}
                    onChange={(e) =>
                      updateRegion(selectedRegion.id, { height: Number(e.target.value) })
                    }
                    className="rounded border border-neutral-300 px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </label>
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

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSave("png")}
              disabled={status === "processing" || regions.length === 0}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              PNGで保存
            </button>
            <button
              type="button"
              onClick={() => void handleSave("jpeg")}
              disabled={status === "processing" || regions.length === 0}
              className="w-fit rounded-lg bg-neutral-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              JPEGで保存
            </button>
          </div>
        </div>
      )}

      <ProcessingStatus state={status} successLabel="モザイク処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.url}
            alt="モザイク処理結果のプレビュー"
            className="max-h-72 max-w-full object-contain"
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
        </div>
      )}
    </div>
  );
}
