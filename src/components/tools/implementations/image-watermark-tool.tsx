"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { SliderField } from "@/components/common/slider-field";
import { PositionSliders } from "@/components/common/position-sliders";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { TextColorField } from "@/components/common/text-color-field";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  ImageWatermarkProcessor,
  WATERMARK_FONT_SIZE_MAX,
  WATERMARK_FONT_SIZE_MIN,
  WATERMARK_DEFAULT_COLOR,
  drawWatermarkText,
  loadImage,
  watermarkCenterOf,
  type ImageWatermarkPosition,
} from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, replaceExtension, stripExtension } from "@/lib/utils/format";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun } from "@/components/common/use-batch-run";
import { RunBar } from "@/components/ui/run-bar";

const POSITION_OPTIONS: { value: ImageWatermarkPosition; label: string }[] = [
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "center", label: "中央" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** プレビュー用に縮小する最長辺(px) */
const PREVIEW_MAX_SIDE = 800;

/** 画像の大きさに合わせた、文字サイズのスライダー上限(px)。写真の長辺ほどまで大きくできる */
function fontSizeSliderMax(naturalWidth: number | null, naturalHeight: number | null): number {
  if (!naturalWidth || !naturalHeight) return 400;
  const longest = Math.max(naturalWidth, naturalHeight);
  return Math.min(WATERMARK_FONT_SIZE_MAX, Math.max(400, longest));
}

/**
 * 画像ウォーターマーク（Phase 8）。
 * PDF透かし（pdf-watermark）の「位置・不透明度・回転」という設定項目の
 * 考え方を踏襲しつつ、Canvas APIのみで実装する（新しい画像用ライブラリは追加しない）。
 *
 * 設定を変えるたびに縮小したプレビューへ同じ描画関数(drawWatermarkText)で透かしを描き直す。
 * 文字サイズは「元画像のピクセル」で指定する(プレビューでは縮小率を掛けて同じ見た目にする)。
 * スライダーの上限は画像の大きさに合わせて広がる。
 */
/**
 * 一括処理で、ほかの画像に使う文字の大きさ。
 * 文字の大きさは1枚目の画像のピクセルで決めているので、画像の短辺の長さに合わせて同じ割合にそろえる
 * （大きな写真で文字が小さくなりすぎたり、小さな画像ではみ出したりしないようにする）。
 */
export function scaleWatermarkFontSize(
  fontSize: number,
  base: { width: number; height: number },
  target: { width: number; height: number }
): number {
  const scaled = (fontSize * Math.min(target.width, target.height)) / Math.max(1, Math.min(base.width, base.height));
  return Math.min(WATERMARK_FONT_SIZE_MAX, Math.max(WATERMARK_FONT_SIZE_MIN, Math.round(scaled)));
}

export function ImageWatermarkTool() {
  // 選んだ画像。2枚以上のとき（プレミアムの一括処理）は、同じ透かしを1枚ずつ順番に入れる
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("image-watermark");
  const batchRun = useBatchRun();
  const [text, setText] = useState("CONFIDENTIAL");
  const [position, setPosition] = useState<ImageWatermarkPosition>("bottom-right");
  const [opacity, setOpacity] = useState(50);
  const [fontSize, setFontSize] = useState(32);
  const [rotation, setRotation] = useState(0);
  const [color, setColor] = useState(WATERMARK_DEFAULT_COLOR);
  // X・Yの調整バーで決めた文字の中心（%）。null のあいだは、選んだ位置（左上・中央など）に置く
  const [customCenter, setCustomCenter] = useState<{ x: number; y: number } | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  // --- プレビュー ---
  const baseRef = useRef<{ canvas: HTMLCanvasElement; scale: number } | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [prepared, setPrepared] = useState<{ file: File; width: number; height: number } | null>(null);
  const [previewErrorFor, setPreviewErrorFor] = useState<{ file: File; message: string } | null>(null);
  const previewReady = file !== null && prepared?.file === file;
  const naturalSize = useMemo(
    () => (previewReady && prepared ? { width: prepared.width, height: prepared.height } : null),
    [previewReady, prepared]
  );
  const previewError = previewErrorFor && previewErrorFor.file === file ? previewErrorFor.message : null;
  const sliderMax = fontSizeSliderMax(naturalSize?.width ?? null, naturalSize?.height ?? null);
  const shownFontSize = fontSize;

  // バーに出す位置（%）：自由に動かしたときはその値、位置のボタンを選んでいるときは、その位置に置いたときの文字の中心
  const shownCenter = useMemo(() => {
    if (customCenter) return customCenter;
    if (!naturalSize || text.trim() === "" || typeof document === "undefined") return { x: 50, y: 50 };
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return { x: 50, y: 50 };
    const c = watermarkCenterOf(ctx, naturalSize.width, naturalSize.height, { text, position, fontSize: shownFontSize });
    return { x: Math.round(c.x * 100), y: Math.round(c.y * 100) };
  }, [customCenter, naturalSize, text, position, shownFontSize]);
  const centerOption = customCenter ? { x: customCenter.x / 100, y: customCenter.y / 100 } : undefined;

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  useEffect(() => {
    let cancelled = false;
    baseRef.current = null;
    if (!file) return;
    (async () => {
      try {
        const img = await loadImage(file);
        if (cancelled) return;
        const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        baseRef.current = { canvas: c, scale };
        setPrepared({ file, width: img.naturalWidth, height: img.naturalHeight });
      } catch (e) {
        if (!cancelled) setPreviewErrorFor({ file, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    const base = baseRef.current;
    const canvas = previewCanvasRef.current;
    if (!previewReady || !base || !canvas) return;
    const frame = requestAnimationFrame(() => {
      canvas.width = base.canvas.width;
      canvas.height = base.canvas.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(base.canvas, 0, 0);
      if (text.trim() !== "") {
        drawWatermarkText(ctx, canvas.width, canvas.height, {
          text,
          position,
          opacity: opacity / 100,
          fontSize: Math.max(1, shownFontSize * base.scale),
          rotation,
          center: customCenter ? { x: customCenter.x / 100, y: customCenter.y / 100 } : undefined,
          color,
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [previewReady, text, position, opacity, shownFontSize, rotation, customCenter, color]);

  // 設定を変えたら、前の設定でまとめて処理した結果は捨てる（違う設定の結果を保存させない）
  const resetBatch = batchRun.reset;
  useEffect(() => {
    resetBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, position, opacity, fontSize, rotation, color, customCenter]);

  function handleSelect(selected: File[]) {
    setFiles(batch.pick(files, selected, "append"));
    setResult(null);
    batchRun.reset();
    setError(null);
    setStatus("idle");
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    batchRun.reset();
    setStatus("idle");
  }

  /** 一括処理：選んだ全部の画像に、同じ透かしを1枚ずつ入れる */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    const base = naturalSize;
    const settings = { text, position, opacity: opacity / 100, rotation, center: centerOption, color };
    setStatus("processing");
    setError(null);
    setResult(null);
    const items = await batchRun.run(files, async (target) => {
      const img = await loadImage(target);
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      const size1 = base ? scaleWatermarkFontSize(shownFontSize, base, size) : shownFontSize;
      const output = await new ImageWatermarkProcessor().process({ file: target, ...settings, fontSize: size1 });
      URL.revokeObjectURL(output.url);
      return {
        blob: output.blob,
        outputName: replaceExtension(target.name, EXT_BY_MIME[output.mimeType] ?? "png"),
        detail: `${output.width}×${output.height}px・文字${size1}px`,
      };
    });
    const summary = summarizeBatch(items, "すべての画像で透かしの追加に失敗しました");
    setStatus(summary.status);
    setError(summary.error);
  }

  async function handleRun() {
    if (!file) return;
    if (isBatch) {
      await handleRunBatch();
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImageWatermarkProcessor().process({
        file,
        text,
        position,
        opacity: opacity / 100,
        fontSize: shownFontSize,
        rotation,
        center: centerOption,
        color,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? replaceExtension(file.name, result ? EXT_BY_MIME[result.mimeType] ?? "png" : "png")
    : "watermarked.png";

  const relativePercent = naturalSize ? Math.round((shownFontSize / Math.min(naturalSize.width, naturalSize.height)) * 100) : null;

  return (
    // 総合改修 26：設定とプレビューを分け、設定を変えている間もプレビューが見える（PCは右に固定・スマホは上に固定）
    <PreviewSplitLayout
      previewWidth="lg"
      mobileSticky
      preview={
        file ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー</p>
            {previewError && <ErrorMessage message={previewError} />}
            <canvas
              ref={previewCanvasRef}
              aria-label="透かし入りプレビュー"
              data-testid="watermark-preview"
              className="mx-auto block h-auto w-auto max-h-[min(34vh,30rem)] max-w-full rounded-lg border border-neutral-200 bg-neutral-100 lg:max-h-[min(70vh,36rem)] dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
        ) : null
      }
    >
      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        multiple
        onFilesSelected={handleSelect}
        onError={setError}
      />
      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} unit="枚" />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}
      {isBatch && (
        <p data-testid="batch-watermark-note" className="text-xs text-ms-muted">
          プレビューは1枚目の画像です。ほかの画像にも同じ位置に入れ、文字の大きさは画像の大きさに合わせて同じ割合にそろえます。
        </p>
      )}

      {file && (
        <SettingsStack testId="watermark-settings">
          <SettingsSection n={1} title="透かしの文字" summary={text}>
            <label className="flex flex-col gap-1 text-sm">
              透かしの文字
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={60}
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <TextColorField value={color} onChange={setColor} testId="watermark-color" />
            <SliderField
              label="フォントサイズ"
              value={shownFontSize}
              min={WATERMARK_FONT_SIZE_MIN}
              max={sliderMax}
              inputMax={WATERMARK_FONT_SIZE_MAX}
              unit="px"
              onChange={setFontSize}
              hint={
                naturalSize
                  ? `元画像(${naturalSize.width}×${naturalSize.height}px)に対する大きさです。画像の短辺の約${relativePercent}%。バーは画像に合わせて最大${sliderMax}pxまで、数値入力なら最大${WATERMARK_FONT_SIZE_MAX}pxまで指定できます。`
                  : undefined
              }
            />
          </SettingsSection>

          <SettingsSection
            n={2}
            title="位置"
            summary={customCenter ? `X ${customCenter.x}%・Y ${customCenter.y}%` : POSITION_OPTIONS.find((o) => o.value === position)?.label}
          >
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">よく使う位置</p>
              <div className="ms-seg" data-testid="watermark-position">
                {POSITION_OPTIONS.map((opt) => (
                  <button aria-pressed={!customCenter && position === opt.value}
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setPosition(opt.value);
                      setCustomCenter(null);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ms-muted">
                下のバーで、文字の中心を自由な位置に動かせます（0%＝左端・上端、100%＝右端・下端）。
                {customCenter && <span data-testid="watermark-custom-position">いまは、バーで決めた位置に置いています。</span>}
              </p>
            </div>
            <PositionSliders
              testId="watermark-xy"
              x={shownCenter.x}
              y={shownCenter.y}
              onChange={(p) => setCustomCenter(p)}
            />
          </SettingsSection>

          <SettingsSection n={3} title="見た目" summary={`不透明度 ${opacity}%・回転 ${rotation}°`}>
            <SliderField label="不透明度" value={opacity} min={5} max={100} unit="%" onChange={setOpacity} />
            <SliderField label="回転角度" value={rotation} min={-90} max={90} unit="°" onChange={setRotation} />
          </SettingsSection>
        </SettingsStack>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || !text.trim()} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${files.length}枚にまとめて透かしを追加する` : "透かしを追加する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={isBatch ? batchRun.progressLabel("透かしを追加しています") : undefined}
        successLabel="処理が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "images") || "images"}-watermarked.zip`} />

      {result && !isBatch && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
