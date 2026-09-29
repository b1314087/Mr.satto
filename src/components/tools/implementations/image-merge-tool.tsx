"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImageMergeProcessor,
  type ImageMergeAlignment,
  type ImageMergeDirection,
  type ImageMergeFormat,
  type ImageMergeInput,
  type ImageMergeSizeMode,
  type ImageMergeUniformFit,
} from "@/lib/processors/browser/image-merge";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

// 透明背景をプレビューで分かりやすく示す市松模様。
// electronic-stamp-generator-tool.tsx の CHECKER_STYLE と同じ配色・寸法を再利用する。
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, #d4d4d4 25%, transparent 25%), linear-gradient(-45deg, #d4d4d4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d4 75%), linear-gradient(-45deg, transparent 75%, #d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  backgroundColor: "#f5f5f5",
};

const DIRECTION_OPTIONS: { id: ImageMergeDirection; label: string }[] = [
  { id: "horizontal", label: "横結合" },
  { id: "vertical", label: "縦結合" },
  { id: "grid", label: "グリッド" },
];

const SIZE_MODE_OPTIONS: { id: ImageMergeSizeMode; label: string }[] = [
  { id: "original", label: "元サイズ" },
  { id: "scale", label: "倍率指定" },
  { id: "uniform", label: "サイズを揃える" },
];

const SCALE_PRESETS = [50, 80, 100, 120, 200];

const ALIGNMENT_OPTIONS: { id: ImageMergeAlignment; label: string }[] = [
  { id: "start", label: "始点(上/左)" },
  { id: "center", label: "中央" },
  { id: "end", label: "終点(下/右)" },
];

const GAP_PRESETS = [0, 5, 10, 20];

const BACKGROUND_PRESETS: { id: string; label: string; value: string }[] = [
  { id: "white", label: "白", value: "#ffffff" },
  { id: "black", label: "黒", value: "#000000" },
  { id: "transparent", label: "透明", value: "transparent" },
];

const MAX_SCALE_PERCENT = 500;
const MAX_UNIFORM_DIM = 6000;
const MAX_GAP_PX = 500;
const MAX_COLUMNS = 20;

function toggleButtonClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active
      ? "bg-blue-600 text-white"
      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function ImageMergeTool() {
  const [files, setFiles] = useState<File[]>([]);

  const [direction, setDirection] = useState<ImageMergeDirection>("horizontal");
  const [columns, setColumns] = useState(2);
  const [sizeMode, setSizeMode] = useState<ImageMergeSizeMode>("original");
  const [scalePercent, setScalePercent] = useState(100);
  const [uniformWidth, setUniformWidth] = useState(800);
  const [uniformHeight, setUniformHeight] = useState(600);
  const [uniformFit, setUniformFit] = useState<ImageMergeUniformFit>("fit");
  const [gapPx, setGapPx] = useState(10);
  const [alignment, setAlignment] = useState<ImageMergeAlignment>("center");
  const [background, setBackground] = useState("#ffffff");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  const [previewResult, setPreviewResult] = useState<ImageProcessorOutput | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRunIdRef = useRef(0);

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

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  const scaleInvalid =
    sizeMode === "scale" &&
    (!Number.isFinite(scalePercent) || scalePercent <= 0 || scalePercent > MAX_SCALE_PERCENT);
  const uniformInvalid =
    sizeMode === "uniform" &&
    (!Number.isFinite(uniformWidth) ||
      !Number.isFinite(uniformHeight) ||
      uniformWidth <= 0 ||
      uniformHeight <= 0 ||
      uniformWidth > MAX_UNIFORM_DIM ||
      uniformHeight > MAX_UNIFORM_DIM);
  const gapInvalid = !Number.isFinite(gapPx) || gapPx < 0 || gapPx > MAX_GAP_PX;
  const columnsInvalid = direction === "grid" && (!Number.isInteger(columns) || columns < 1);

  const settingsError = scaleInvalid
    ? `倍率は1〜${MAX_SCALE_PERCENT}%の範囲で指定してください。`
    : uniformInvalid
      ? `幅・高さは1〜${MAX_UNIFORM_DIM}pxの範囲で指定してください。`
      : gapInvalid
        ? `間隔は0〜${MAX_GAP_PX}pxの範囲で指定してください。`
        : columnsInvalid
          ? "列数は1以上の整数を指定してください。"
          : null;

  const canProcess = files.length >= 2 && !settingsError;

  function buildInput(format: ImageMergeFormat): ImageMergeInput {
    return {
      files,
      direction,
      columns: Math.max(1, Math.round(columns)),
      sizeMode,
      scalePercent,
      uniformWidth,
      uniformHeight,
      uniformFit,
      gapPx: Math.max(0, gapPx),
      alignment,
      background,
      format,
    };
  }

  // ライブプレビュー：設定変更のたびに毎回重い処理を行わないよう、
  // 500ms のデバウンスをかけてから実際のProcessorを1回だけ呼ぶ。
  // 既存の別ロジック（CSSだけの近似レイアウト）を新たに作るのではなく、
  // 本番出力と全く同じ計算を使うことで、プレビューと結果のズレを防ぐ。
  useEffect(() => {
    if (!canProcess) {
      // 画像が2枚未満・設定エラー時はプレビューをクリアする
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
          const output = await new ImageMergeProcessor().process(buildInput("png"));
          if (previewRunIdRef.current !== runId) {
            // 設定がさらに変わり追い越された場合は、古い結果を使わず破棄する
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    files,
    direction,
    columns,
    sizeMode,
    scalePercent,
    uniformWidth,
    uniformHeight,
    uniformFit,
    gapPx,
    alignment,
    background,
    canProcess,
  ]);

  async function handleSave(format: ImageMergeFormat) {
    if (!canProcess) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImageMergeProcessor().process(buildInput(format));
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

  const baseName = files[0] ? stripExtension(files[0].name) : "画像結合";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={50}
        label="画像をドラッグ&ドロップ（2枚以上）"
        hint="またはタップして選択。結合したい画像をまとめて選べます"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length === 1 && (
        <p className="text-sm text-amber-600 dark:text-amber-400">
          画像結合には2枚以上の画像が必要です。もう1枚以上追加してください。
        </p>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-5 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">結合方法</p>
            <div className="flex flex-wrap gap-2">
              {DIRECTION_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDirection(opt.id)}
                  className={toggleButtonClass(direction === opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {direction === "grid" && (
              <label className="mt-1 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                列数
                <input
                  type="number"
                  min={1}
                  max={MAX_COLUMNS}
                  value={columns}
                  onChange={(e) => setColumns(Number(e.target.value))}
                  className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">サイズ</p>
            <div className="flex flex-wrap gap-2">
              {SIZE_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSizeMode(opt.id)}
                  className={toggleButtonClass(sizeMode === opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {sizeMode === "scale" && (
              <div className="flex flex-wrap items-center gap-2">
                {SCALE_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setScalePercent(p)}
                    className={toggleButtonClass(scalePercent === p)}
                  >
                    {p}%
                  </button>
                ))}
                <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                  カスタム
                  <input
                    type="number"
                    min={1}
                    max={MAX_SCALE_PERCENT}
                    value={scalePercent}
                    onChange={(e) => setScalePercent(Number(e.target.value))}
                    className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  %
                </label>
              </div>
            )}

            {sizeMode === "uniform" && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                    幅
                    <input
                      type="number"
                      min={1}
                      max={MAX_UNIFORM_DIM}
                      value={uniformWidth}
                      onChange={(e) => setUniformWidth(Number(e.target.value))}
                      className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    px
                  </label>
                  <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                    高さ
                    <input
                      type="number"
                      min={1}
                      max={MAX_UNIFORM_DIM}
                      value={uniformHeight}
                      onChange={(e) => setUniformHeight(Number(e.target.value))}
                      className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    px
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setUniformFit("fit")}
                    className={toggleButtonClass(uniformFit === "fit")}
                  >
                    比率維持+フィット
                  </button>
                  <button
                    type="button"
                    onClick={() => setUniformFit("crop")}
                    className={toggleButtonClass(uniformFit === "crop")}
                  >
                    比率維持+クロップ
                  </button>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  縦横比を無視して引き伸ばすことはありません。フィットは余白が生まれ、クロップは枠いっぱいに埋める代わりに一部が見切れます。
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">間隔</p>
            <div className="flex flex-wrap items-center gap-2">
              {GAP_PRESETS.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGapPx(g)}
                  className={toggleButtonClass(gapPx === g)}
                >
                  {g}px
                </button>
              ))}
              <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                カスタム
                <input
                  type="number"
                  min={0}
                  max={MAX_GAP_PX}
                  value={gapPx}
                  onChange={(e) => setGapPx(Number(e.target.value))}
                  className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                px
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">揃え方</p>
            <div className="flex flex-wrap gap-2">
              {ALIGNMENT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setAlignment(opt.id)}
                  className={toggleButtonClass(alignment === opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">背景</p>
            <div className="flex flex-wrap items-center gap-2">
              {BACKGROUND_PRESETS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setBackground(opt.value)}
                  className={toggleButtonClass(background === opt.value)}
                >
                  {opt.label}
                </button>
              ))}
              <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                カスタム
                <input
                  type="color"
                  value={background === "transparent" ? "#ffffff" : background}
                  onChange={(e) => setBackground(e.target.value)}
                  className="h-8 w-10 cursor-pointer rounded border border-neutral-300 dark:border-neutral-700"
                />
              </label>
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              JPEGで保存する場合、透明は白背景になります。
            </p>
          </div>
        </div>
      )}

      {settingsError && <ErrorMessage message={settingsError} />}

      {files.length >= 2 && !settingsError && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー</p>
          <div
            className="flex min-h-[8rem] items-center justify-center rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
            style={background === "transparent" ? CHECKER_STYLE : { backgroundColor: "#f5f5f5" }}
          >
            {previewResult ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewResult.url}
                alt="結合結果のプレビュー"
                className="max-h-72 max-w-full object-contain"
              />
            ) : (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {previewLoading ? "プレビューを作成しています…" : "設定を変更するとプレビューが表示されます"}
              </p>
            )}
          </div>
        </div>
      )}

      {files.length >= 2 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleSave("png")}
            disabled={!canProcess || status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            PNGで保存
          </button>
          <button
            type="button"
            onClick={() => void handleSave("jpeg")}
            disabled={!canProcess || status === "processing"}
            className="w-fit rounded-lg bg-neutral-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            JPEGで保存
          </button>
        </div>
      )}

      <ProcessingStatus state={status} successLabel="画像結合が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div
            className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-700"
            style={result.mimeType === "image/png" ? CHECKER_STYLE : undefined}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={result.url}
              alt="結合結果のプレビュー"
              className="max-h-72 max-w-full object-contain"
            />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate
            onDownload={() =>
              downloadBlob(
                result.blob,
                `${baseName}_結合.${result.mimeType === "image/png" ? "png" : "jpg"}`
              )
            }
          />
        </div>
      )}
    </div>
  );
}
