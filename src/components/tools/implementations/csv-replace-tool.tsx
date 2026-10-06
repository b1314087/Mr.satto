"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  pickPreviewRowIndexes,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRows, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvReplaceProcessor, replaceCsvRows } from "@/lib/processors/browser/csv-ops";
import { parseCsv } from "@/lib/utils/csv";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

export function CsvReplaceTool() {
  const [file, setFile] = useState<File | null>(null);
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    replacedCount: number;
    previewRows: string[][];
  } | null>(null);

  const { data: sourceRows, error: previewError, loading } = useAsyncFileData(file, loadCsvRows);

  // プレビュー: 出力と同じ replaceCsvRows で処理する(大きなファイルは先頭の行だけで計算)
  const preview = useMemo(() => {
    if (!sourceRows) return null;
    const limited = sourceRows.length > PREVIEW_COMPUTE_ROWS;
    const rows = limited ? sourceRows.slice(0, PREVIEW_COMPUTE_ROWS) : sourceRows;
    if (search === "") {
      return { limited, total: sourceRows.length, before: toGridRows(rows.slice(0, 10)), after: null, replacedCount: 0 };
    }
    const replaced = replaceCsvRows(rows, search, replace);
    const changedRows = new Set<number>();
    rows.forEach((row, r) => {
      if (row.some((cell, c) => cell !== replaced.rows[r][c])) changedRows.add(r);
    });
    const indexes = pickPreviewRowIndexes(changedRows, rows.length, 10);
    return {
      limited,
      total: sourceRows.length,
      before: indexes.map((r) => toGridRows([rows[r]], (_, c, text) => (text !== replaced.rows[r][c] ? "changed" : undefined))[0]),
      after: indexes.map((r) => toGridRows([replaced.rows[r]], (_, c, text) => (text !== rows[r][c] ? "changed" : undefined))[0]),
      replacedCount: replaced.replacedCount,
    };
  }, [sourceRows, search, replace]);

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
      const output = await new CsvReplaceProcessor().process({ file, search, replace });
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

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              検索する文字列
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="置換前の文字列"
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              置換後の文字列
              <input
                type="text"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder="置換後の文字列（空欄可）"
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>
        </div>
      )}

      {file && (preview || previewError || loading) && (
        <BeforeAfterPreview
          title="置換のプレビュー"
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={previewError}
          beforeLabel="置換前"
          afterLabel="置換後"
          summary={
            preview &&
            (search === "" ? (
              <span>「検索する文字列」を入力すると、置換後の表がここに表示されます。</span>
            ) : (
              <span>置換される見込み: {preview.replacedCount}箇所</span>
            ))
          }
          legend={search === "" ? undefined : [{ mark: "changed", label: "置換されるセル(変更のある行を優先して表示)" }]}
          notes={
            preview?.limited
              ? [`ファイルが大きいため、先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(全${preview.total}行)。実際の処理は全行が対象です。`]
              : undefined
          }
        />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || search === ""}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          置換を実行する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="置換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.replacedCount}件を置換しました ・ {formatBytes(result.blob.size)}
          </p>
          <CsvPreviewTable rows={result.previewRows} />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, "replaced.csv")}
            label="CSVでダウンロード"
          />
        </div>
      )}
    </div>
  );
}
