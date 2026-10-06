"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import {
  PREVIEW_COMPUTE_ROWS,
  PreviewColumn,
  PreviewColumns,
  PreviewGrid,
  PreviewNotice,
  PreviewShell,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRowSets, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvMergeProcessor, mergeCsvRowSets } from "@/lib/processors/browser/csv-ops";
import { parseCsv } from "@/lib/utils/csv";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

export function CsvMergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; rowCount: number; previewRows: string[][] } | null>(
    null
  );

  const { data: fileRowSets, error: previewError, loading } = useAsyncFileData(
    files.length > 0 ? files : null,
    loadCsvRowSets
  );

  // プレビュー: 出力と同じ mergeCsvRowSets で結合する(大きなファイルは各ファイルの先頭の行だけで計算)
  const preview = useMemo(() => {
    if (!fileRowSets || fileRowSets.length < 2) return null;
    const sets = fileRowSets.map((f) => ({ name: f.name, rows: f.rows.slice(0, PREVIEW_COMPUTE_ROWS) }));
    const limited = fileRowSets.some((f) => f.rows.length > PREVIEW_COMPUTE_ROWS);
    try {
      const merged = mergeCsvRowSets(sets);
      // 各ファイルから結合結果に入る行の境界(ファイルを1つずつ足したときの行数)
      const bounds = sets.map((_, k) => mergeCsvRowSets(sets.slice(0, k + 1)).length);
      // 見出し+各ファイルの先頭数行を抜粋して表示する
      const indexes: number[] = [0];
      sets.forEach((_, k) => {
        const start = k === 0 ? 1 : bounds[k - 1];
        const take = k === 0 ? 4 : 3;
        for (let i = start; i < Math.min(bounds[k], start + take); i++) indexes.push(i);
      });
      const fromFileIndex = (row: number) => bounds.findIndex((b) => row < b);
      return {
        error: null as string | null,
        limited,
        mergedCount: merged.length,
        rows: indexes.map(
          (i) => toGridRows([merged[i]], () => (i > 0 && fromFileIndex(i) > 0 ? "target" : undefined))[0]
        ),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "結合できませんでした", limited, mergedCount: 0, rows: [] };
    }
  }, [fileRowSets]);

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRun() {
    if (files.length < 2) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new CsvMergeProcessor().process({ files });
      const text = await output.blob.text();
      setResult({ blob: output.blob, rowCount: output.rowCount, previewRows: parseCsv(text) });
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
        multiple
        maxSizeMB={50}
        label="CSVをドラッグ&ドロップ（複数可）"
        hint="またはタップして選択。結合する順序で選択してください"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length > 0 && files.length < 2 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          結合するには、もう1つ以上CSVを追加してください。
        </p>
      )}

      {files.length >= 2 && (previewError || loading || preview) && (
        <PreviewShell
          title="結合のプレビュー"
          loading={loading}
          summary={preview && !preview.error && <span>結合後の行数: {preview.mergedCount}行（見出し含む）</span>}
          legend={[{ mark: "target", label: "2つ目以降のファイルから追加される行" }]}
          notes={[
            "各ファイルの先頭の数行を抜粋して表示しています。",
            "2つ目以降のファイルの1行目が1つ目の見出しと同じ場合は、見出し行として重ねずに結合します。",
            ...(preview?.limited
              ? [`ファイルが大きいため、各ファイルの先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです。実際の処理は全行が対象です。`]
              : []),
          ]}
        >
          {previewError && <PreviewNotice message={previewError} />}
          {fileRowSets && (
            <PreviewColumns>
              <PreviewColumn label="結合前(各ファイルの先頭)">
                <div className="flex flex-col gap-3">
                  {fileRowSets.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="flex flex-col gap-1">
                      <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                        {i + 1}. {f.name}（{f.rows.length}行）
                      </p>
                      <PreviewGrid rows={toGridRows(f.rows)} maxRows={3} />
                    </div>
                  ))}
                </div>
              </PreviewColumn>
              <PreviewColumn label="結合後">
                {preview?.error ? (
                  <PreviewNotice message={preview.error} />
                ) : (
                  preview && <PreviewGrid rows={preview.rows} maxRows={14} />
                )}
              </PreviewColumn>
            </PreviewColumns>
          )}
        </PreviewShell>
      )}

      {files.length >= 2 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件のCSVを結合する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="結合が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行に結合しました ・ {formatBytes(result.blob.size)}
          </p>
          <CsvPreviewTable rows={result.previewRows} />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, "merged.csv")}
            label="CSVでダウンロード"
          />
        </div>
      )}
    </div>
  );
}
