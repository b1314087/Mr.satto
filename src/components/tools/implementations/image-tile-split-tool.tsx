"use client";

import { useEffect, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { ImageTileSplitProcessor, computeTileBoundaries } from "@/lib/processors/browser/image-tile-split";
import { createZip, type ZipEntry } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun } from "@/components/common/use-batch-run";

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

/** 1枚の画像を分割し、ZIPに入れるファイルの一覧を作る（単体・一括で共通） */
async function splitToEntries(file: File, rows: number, cols: number, format: OutputFormat): Promise<{ base: string; entries: ZipEntry[] }> {
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
  return { base, entries };
}

export function ImageTileSplitTool() {
  // 選んだ画像。2枚以上のとき（プレミアムの一括処理）は、同じ行数・列数で1枚ずつ順番に分割する
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("image-tile-split");
  const batchRun = useBatchRun();
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

  // 設定を変えたら、前の設定でまとめて処理した結果は捨てる（違う設定の結果を保存させない）
  const resetBatch = batchRun.reset;
  useEffect(() => {
    resetBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, format]);

  function handleSelect(selected: File[]) {
    setFiles(batch.pick(files, selected, "append"));
    batchRun.reset();
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    batchRun.reset();
    setStatus("idle");
  }

  /** 一括処理：選んだ全部の画像を、同じ行数・列数で1枚ずつ分割する */
  async function handleExportBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    setStatus("processing");
    setError(null);
    setZipResult(null);
    const items = await batchRun.run(files, async (target) => {
      const { base, entries } = await splitToEntries(target, rows, cols, format);
      return { blob: await createZip(entries), outputName: `${base}_タイル分割.zip`, entries, detail: `${entries.length}枚に分割` };
    });
    const summary = summarizeBatch(items, "すべての画像で分割に失敗しました");
    setStatus(summary.status);
    setError(summary.error);
  }

  async function handleExport() {
    if (!file || !canProcess) return;
    if (isBatch) {
      await handleExportBatch();
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const { base, entries } = await splitToEntries(file, rows, cols, format);
      const zipBlob = await createZip(entries);
      setZipResult({ blob: zipBlob, name: `${base}_タイル分割.zip`, count: entries.length });
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
          <p className="text-xs text-neutral-500 dark:text-neutral-400">分割線と番号は出力画像には入りません。</p>
        </div>
      ) : null}
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
        <p data-testid="batch-tile-note" className="text-xs text-ms-muted">
          プレビューは1枚目の画像です。ほかの画像も同じ行数・列数で分割します。
        </p>
      )}

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
        <RunBar>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={!canProcess || status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${files.length}枚をまとめて${tileCount}枚ずつに分割する` : `${tileCount}枚に分割する`}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={isBatch ? batchRun.progressLabel("分割しています") : undefined}
        successLabel="タイル分割が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "images") || "images"}_タイル分割.zip`} />

      {zipResult && !isBatch && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {zipResult.count}枚に分割しました ・ {formatBytes(zipResult.blob.size)}
          </p>
          <RewardedDownloadGate
            label="ZIPをダウンロード"
            onDownload={() => downloadBlob(zipResult.blob, zipResult.name)}
          />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
