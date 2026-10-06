"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  PreviewColumn,
  PreviewGrid,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRows, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvDedupeProcessor, dedupeCsvRows } from "@/lib/processors/browser/csv-ops";
import { parseCsv } from "@/lib/utils/csv";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

export function CsvDedupeTool() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    beforeCount: number;
    afterCount: number;
    removedCount: number;
    previewRows: string[][];
  } | null>(null);

  const { data: sourceRows, error: previewError, loading } = useAsyncFileData(file, loadCsvRows);

  // プレビュー: 出力と同じ dedupeCsvRows で処理する(大きなファイルは先頭の行だけで計算)
  const preview = useMemo(() => {
    if (!sourceRows) return null;
    const limited = sourceRows.length > PREVIEW_COMPUTE_ROWS;
    const rows = limited ? sourceRows.slice(0, PREVIEW_COMPUTE_ROWS) : sourceRows;
    const deduped = dedupeCsvRows(rows);
    const removedRows = Array.from(deduped.removedRowIndexes)
      .slice(0, 5)
      .map((i) => rows[i]);
    return {
      limited,
      total: sourceRows.length,
      before: toGridRows(rows, (r) => (deduped.removedRowIndexes.has(r) ? "removed" : undefined)),
      after: toGridRows(deduped.rows),
      removedCount: deduped.removedCount,
      beforeCount: rows.length - 1,
      afterCount: deduped.rows.length - 1,
      removedExamples: rows.length > 0 ? toGridRows([rows[0], ...removedRows]) : [],
    };
  }, [sourceRows]);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new CsvDedupeProcessor().process({ file });
      const text = await output.blob.text();
      setResult({ ...output, previewRows: parseCsv(text) });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept=".csv,text/csv"
        maxSizeMB={50}
        label="CSVファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (preview || previewError || loading) && (
        <BeforeAfterPreview
          title="重複削除のプレビュー"
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={previewError}
          beforeLabel="削除前"
          afterLabel="削除後"
          summary={
            preview && (
              <span>
                重複として削除される行: {preview.removedCount}行（データ行 {preview.beforeCount}行 → {preview.afterCount}行）
              </span>
            )
          }
          legend={[{ mark: "removed", label: "重複として削除される行" }]}
          notes={[
            "1行目を見出しとして残し、すべての列が同じ内容の行を2行目以降から削除します。",
            ...(preview?.limited
              ? [`ファイルが大きいため、先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(全${preview.total}行)。実際の処理は全行が対象です。`]
              : []),
          ]}
          extra={
            preview && preview.removedCount > 0 ? (
              <PreviewColumn label="重複として削除される行の例(先頭5件)">
                <PreviewGrid rows={preview.removedExamples} maxRows={6} />
              </PreviewColumn>
            ) : null
          }
        />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          重複を削除する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="重複削除が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除前: {result.beforeCount}行 → 削除後: {result.afterCount}行（
            {result.removedCount}行を重複として削除） ・ {formatBytes(result.blob.size)}
          </p>
          <CsvPreviewTable rows={result.previewRows} />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, "deduped.csv")}
            label="CSVでダウンロード"
          />
        </div>
      )}
    </div>
  );
}
