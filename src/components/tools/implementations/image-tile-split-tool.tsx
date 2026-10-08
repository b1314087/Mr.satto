"use client";

import { useEffect, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageTileSplitProcessor, computeTileBoundaries } from "@/lib/processors/browser/image-tile-split";
import { createZip, type ZipEntry } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

type OutputFormat = "png" | "jpeg";

interface Preset {
  label: string;
  rows: number;
  cols: number;
}

const PRESETS: Preset[] = [
  { label: "2×2", rows: 2, cols: 2 },
  { label: "3×3", rows: 3, cols: 3 },
  { label: "4×4", rows: 4, cols: 4 },
];

const MAX_AXIS = 20;
const MAX_TOTAL_TILES = 200;

function toggleButtonClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active
      ? "bg-blue-600 text-white"
      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function ImageTileSplitTool() {
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [format, setFormat] = useState<OutputFormat>("png");
  const [showNumbers, setShowNumbers] = useState(true);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [zipResult, setZipResult] = useState<{ blob: Blob; name: string; count: number } | null>(null);

  useEffect(() => {
    if (!file) {
      // ファイル選択が解除された際に関連stateをリセットする
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
      setError("画像を読み込めませんでした。ファイルが破損していないかご確認ください。");
      setStatus("error");
    };
    img.src = url;
    setZipResult(null);
    setError(null);
    setStatus("idle");
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const rowsInvalid = !Number.isInteger(rows) || rows < 1 || rows > MAX_AXIS;
  const colsInvalid = !Number.isInteger(cols) || cols < 1 || cols > MAX_AXIS;
  const totalInvalid = !rowsInvalid && !colsInvalid && rows * cols > MAX_TOTAL_TILES;
  const tooSmallInvalid =
    !!naturalSize && !rowsInvalid && !colsInvalid && (naturalSize.width < cols || naturalSize.height < rows);

  const settingsError = rowsInvalid
    ? `行数は1〜${MAX_AXIS}の範囲で指定してください。`
    : colsInvalid
      ? `列数は1〜${MAX_AXIS}の範囲で指定してください。`
      : totalInvalid
        ? `分割数が多すぎます（最大${MAX_TOTAL_TILES}枚まで）。行数・列数を見直してください。`
        : tooSmallInvalid
          ? "画像が小さすぎて、指定した行数・列数には分割できません。"
          : null;

  // プレビューの分割線は、書き出しと同じ境界計算を使う
  const xBounds = naturalSize && !colsInvalid ? computeTileBoundaries(naturalSize.width, cols) : [];
  const yBounds = naturalSize && !rowsInvalid ? computeTileBoundaries(naturalSize.height, rows) : [];

  const canProcess = !!file && !!naturalSize && !settingsError;
  const tileCount = !rowsInvalid && !colsInvalid ? rows * cols : 0;

  async function handleExport() {
    if (!file || !canProcess) return;
    setStatus("processing");
    setError(null);
    try {
      const result = await new ImageTileSplitProcessor().process({ file, rows, cols, format });
      const ext = format === "jpeg" ? "jpg" : "png";
      const base = stripExtension(file.name) || "image";
      // 指示書の例（3×3=9枚でも「01」「02」…と2桁ゼロ埋め）に合わせ、
      // 最低2桁、タイル数が100以上になる場合のみそれ以上へ桁数を広げる。
      const padWidth = Math.max(2, String(result.tiles.length).length);
      const entries: ZipEntry[] = result.tiles.map((tile) => ({
        name: `${base}_${String(tile.index + 1).padStart(padWidth, "0")}.${ext}`,
        blob: tile.blob,
      }));
      const zipBlob = await createZip(entries);
      setZipResult({ blob: zipBlob, name: `${base}_タイル分割.zip`, count: result.tiles.length });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={file && imageUrl && naturalSize && !rowsInvalid && !colsInvalid ? (
        <div data-testid="tool-preview" className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            プレビュー（{naturalSize.width} × {naturalSize.height}px ・ 1枚あたり約{Math.round(naturalSize.width / cols)} × {Math.round(naturalSize.height / rows)}px）
          </p>
          <div className="relative inline-block w-fit overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="分割対象の画像" className="block max-h-[28rem] max-w-full select-none" />
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: rows * cols }).map((_, i) => {
                const r = Math.floor(i / cols);
                const c = i % cols;
                // 出力と同じ境界(computeTileBoundaries)で分割線を引く
                return (
                  <div
                    key={i}
                    className="absolute flex items-center justify-center border border-blue-400/70"
                    style={{
                      left: `${(xBounds[c] / naturalSize.width) * 100}%`,
                      width: `${((xBounds[c + 1] - xBounds[c]) / naturalSize.width) * 100}%`,
                      top: `${(yBounds[r] / naturalSize.height) * 100}%`,
                      height: `${((yBounds[r + 1] - yBounds[r]) / naturalSize.height) * 100}%`,
                    }}
                  >
                    {showNumbers && (
                      <span className="rounded bg-black/40 px-1 text-xs text-white/90">{i + 1}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            分割線と番号はプレビュー表示専用で、出力画像には焼き込まれません。
          </p>
        </div>
      ) : null}
    >
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">分割方法</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setRows(preset.rows);
                    setCols(preset.cols);
                  }}
                  className={toggleButtonClass(rows === preset.rows && cols === preset.cols)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                行
                <input
                  type="number"
                  min={1}
                  max={MAX_AXIS}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                  className="w-16 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                列
                <input
                  type="number"
                  min={1}
                  max={MAX_AXIS}
                  value={cols}
                  onChange={(e) => setCols(Number(e.target.value))}
                  className="w-16 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              {tileCount > 0 && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">合計{tileCount}枚に分割</span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">出力形式</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setFormat("png")} className={toggleButtonClass(format === "png")}>
                PNG
              </button>
              <button
                type="button"
                onClick={() => setFormat("jpeg")}
                className={toggleButtonClass(format === "jpeg")}
              >
                JPEG
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={showNumbers} onChange={(e) => setShowNumbers(e.target.checked)} />
            プレビューに番号を表示する（出力画像には含まれません）
          </label>
        </div>
      )}

      {settingsError && <ErrorMessage message={settingsError} />}


      {file && (
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={!canProcess || status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {tileCount}枚に分割する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="タイル分割が完了しました" />
      {error && <ErrorMessage message={error} />}

      {zipResult && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {zipResult.count}枚に分割しました ・ {formatBytes(zipResult.blob.size)}
          </p>
          <RewardedDownloadGate
            label="ZIPをダウンロード"
            onDownload={() => downloadBlob(zipResult.blob, zipResult.name)}
          />
        </div>
      )}
    </PreviewSplitLayout>
  );
}
