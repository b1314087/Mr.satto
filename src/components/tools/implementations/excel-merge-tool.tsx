"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import {
  PREVIEW_COMPUTE_ROWS,
  PreviewColumn,
  PreviewColumns,
  PreviewGrid,
  PreviewNotice,
  PreviewShell,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { cellToText, mergeTables, MERGE_MAX_SOURCES, MergeError, type MergeResult } from "@/lib/excel/merge-tables";
import {
  buildMergeSources,
  classifyMergeFile,
  ExcelMergeProcessor,
  loadMergeFiles,
  MERGE_FILE_ACCEPT,
  MERGE_LEGACY_EXCEL_MESSAGE,
  MERGE_UNSUPPORTED_MESSAGE,
  type MergeOutputFormat,
} from "@/lib/processors/browser/excel-merge";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/** 列の対応表に出す列数の上限（これ以上は省略して件数だけ示す） */
const MAX_COLUMN_ROWS = 30;
/** プレビューで、ファイルごとに見せる先頭の行数 */
const SAMPLE_ROWS_PER_FILE = 3;

function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function toSampleGrid(result: MergeResult) {
  const indexes: number[] = [];
  const fileCount = result.stats.inputRows.length;
  for (let k = 0; k < fileCount; k++) {
    let taken = 0;
    for (let i = 0; i < result.rows.length && taken < SAMPLE_ROWS_PER_FILE; i++) {
      if (result.rowSourceIndex[i] === k) {
        indexes.push(i);
        taken++;
      }
    }
  }
  const body = indexes.map(
    (i) =>
      toGridRows([result.rows[i].map(cellToText)], () => (result.rowSourceIndex[i] > 0 ? "target" : undefined))[0]
  );
  return [toGridRows([result.header])[0], ...body];
}

export function ExcelMergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [sheetChoice, setSheetChoice] = useState<Record<string, number>>({});
  const [addSourceColumn, setAddSourceColumn] = useState(false);
  const [removeDuplicates, setRemoveDuplicates] = useState(false);
  const [format, setFormat] = useState<MergeOutputFormat>("xlsx");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; fileName: string; result: MergeResult; format: MergeOutputFormat } | null>(
    null
  );

  const { data: loaded, error: loadError, loading } = useAsyncFileData(files.length > 0 ? files : null, loadMergeFiles);

  const sheetIndexes = useMemo(() => files.map((f) => sheetChoice[fileKey(f)] ?? 0), [files, sheetChoice]);

  // プレビュー: 出力と同じ mergeTables で結合する（大きなファイルは、各表の先頭の行だけで計算する）
  const preview = useMemo(() => {
    if (!loaded || loaded.length < 2 || loaded.length !== files.length) return null;
    const sources = buildMergeSources(loaded, sheetIndexes, PREVIEW_COMPUTE_ROWS);
    const limited = loaded.some((f, i) => {
      const index = Math.min(sheetIndexes[i] ?? 0, f.sheets.length - 1);
      return f.sheets[index].rows.length > PREVIEW_COMPUTE_ROWS;
    });
    try {
      const merged = mergeTables(sources, { addSourceColumn, removeDuplicates });
      return { error: null as string | null, limited, merged, sample: toSampleGrid(merged) };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : "結合できませんでした",
        limited,
        merged: null as MergeResult | null,
        sample: [],
      };
    }
  }, [loaded, files.length, sheetIndexes, addSourceColumn, removeDuplicates]);

  function invalidate() {
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function addFiles(newFiles: File[]) {
    const accepted: File[] = [];
    let message: string | null = null;
    for (const f of newFiles) {
      const kind = classifyMergeFile(f);
      if (kind === "legacy-excel") message = MERGE_LEGACY_EXCEL_MESSAGE;
      else if (kind === "unsupported") message = MERGE_UNSUPPORTED_MESSAGE;
      else accepted.push(f);
    }
    const room = MERGE_MAX_SOURCES - files.length;
    if (accepted.length > room) {
      message = `一度に結合できるのは${MERGE_MAX_SOURCES}件までです。超えた分は追加していません。`;
    }
    setFiles((prev) => [...prev, ...accepted.slice(0, Math.max(room, 0))]);
    setResult(null);
    setStatus("idle");
    setError(message);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    invalidate();
  }

  function reorderFiles(next: File[]) {
    setFiles(next);
    invalidate();
  }

  async function handleRun() {
    if (files.length < 2) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelMergeProcessor().process({
        files,
        sheetIndexes,
        options: { addSourceColumn, removeDuplicates },
        format,
      });
      setResult({ ...output, format });
      setStatus("success");
    } catch (e) {
      setError(e instanceof MergeError || e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const multiSheetFiles = loaded && loaded.length === files.length ? loaded.map((f, i) => ({ f, i })).filter(({ f }) => f.sheets.length > 1) : [];
  const canRun = files.length >= 2 && !loading && !loadError && preview !== null && !preview.error && status !== "processing";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={MERGE_FILE_ACCEPT}
        multiple
        maxSizeMB={50}
        label="Excel（.xlsx）・CSVをドラッグ&ドロップ（2〜20件）"
        hint="またはタップして選択"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && <ReorderableFileList files={files} onReorder={reorderFiles} onRemove={removeFile} />}

      {files.length > 0 && files.length < 2 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">もう1つ以上、ファイルを追加してください。</p>
      )}

      {files.length >= 2 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          {multiSheetFiles.map(({ f, i }) => (
            <label key={fileKey(files[i]) + i} className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              <span className="truncate">{f.fileName} のシート</span>
              <select
                aria-label={`${f.fileName} の結合するシート`}
                value={sheetIndexes[i] ?? 0}
                onChange={(e) => {
                  setSheetChoice((prev) => ({ ...prev, [fileKey(files[i])]: Number(e.target.value) }));
                  invalidate();
                }}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              >
                {f.sheets.map((s, si) => (
                  <option key={`${s.name}-${si}`} value={si}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ))}

          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={addSourceColumn}
              onChange={(e) => {
                setAddSourceColumn(e.target.checked);
                invalidate();
              }}
            />
            どのファイルの行かが分かる「結合元」の列を足す
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={removeDuplicates}
              onChange={(e) => {
                setRemoveDuplicates(e.target.checked);
                invalidate();
              }}
            />
            値がすべて同じ行は、2行目以降を除く
          </label>

          <div role="radiogroup" aria-label="出力形式" className="flex flex-wrap gap-2">
            {(
              [
                { value: "xlsx", label: "Excel（.xlsx）" },
                { value: "csv", label: "CSV" },
              ] as { value: MergeOutputFormat; label: string }[]
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={format === opt.value}
                onClick={() => {
                  setFormat(opt.value);
                  invalidate();
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  format === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {files.length >= 2 && (loadError || loading || preview) && (
        <PreviewShell
          title="結合のプレビュー"
          loading={loading}
          summary={
            preview?.merged && (
              <span>
                結合後: {preview.merged.rows.length}行 × {preview.merged.header.length}列（見出しを除く）
                {preview.merged.stats.duplicatesRemoved > 0 && `・同じ行を${preview.merged.stats.duplicatesRemoved}行除きます`}
                {preview.merged.stats.addedColumns > 0 &&
                  `・1つ目のファイルに無い列が${preview.merged.stats.addedColumns}列あります`}
              </span>
            )
          }
          legend={[{ mark: "target", label: "2つ目以降のファイルから追加される行" }]}
          notes={[
            "各ファイルの最初の空でない行を見出し行として、同じ名前の列を揃えます（全角・半角、前後の空白の違いは無視します）。",
            "他のファイルに無い列は右に足し、そのファイルに無い行のセルは空になります。完全に空の行は取り除きます。",
            "セルの値だけを結合します。色・罫線・数式・結合セルなどの書式は引き継がれません。CSVの値は文字として扱います。",
            ...(preview?.limited
              ? [`ファイルが大きいため、各表の先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです。実際の処理は全行が対象です。`]
              : []),
          ]}
        >
          {loadError && <PreviewNotice message={loadError} />}
          {preview?.error && <PreviewNotice message={preview.error} />}
          {preview?.merged && (
            <PreviewColumns>
              <PreviewColumn label="列の対応（✓＝そのファイルにある列）">
                <div className="max-h-72 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                  <table className="w-full border-collapse text-xs" aria-label="列の対応">
                    <thead>
                      <tr className="bg-neutral-100 dark:bg-neutral-800">
                        <th scope="col" className="px-2 py-1 text-left font-medium">
                          結合後の列
                        </th>
                        {files.map((f, i) => (
                          <th key={fileKey(f) + i} scope="col" title={f.name} className="px-2 py-1 text-center font-medium">
                            {i + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.merged.columns.slice(0, MAX_COLUMN_ROWS).map((col, ci) => (
                        <tr key={`${col.name}-${ci}`} className="border-t border-neutral-200 dark:border-neutral-800">
                          <th scope="row" className="max-w-48 truncate px-2 py-1 text-left font-normal" title={col.name}>
                            {col.name}
                            {col.isSource && "（結合元）"}
                          </th>
                          {col.presentIn.map((present, fi) => (
                            <td key={fi} className="px-2 py-1 text-center text-neutral-600 dark:text-neutral-300">
                              {col.isSource ? "—" : present ? "✓" : "—"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.merged.columns.length > MAX_COLUMN_ROWS && (
                  <p className="text-xs text-neutral-400 dark:text-neutral-500">
                    先頭{MAX_COLUMN_ROWS}列のみ表示（全{preview.merged.columns.length}列）
                  </p>
                )}
                <ol className="flex flex-col gap-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {files.map((f, i) => (
                    <li key={fileKey(f) + i} className="truncate" title={f.name}>
                      {i + 1}. {f.name}（{preview.merged?.stats.inputRows[i] ?? 0}行）
                    </li>
                  ))}
                </ol>
              </PreviewColumn>
              <PreviewColumn label="結合後（各ファイルの先頭の行）">
                <PreviewGrid rows={preview.sample} maxRows={SAMPLE_ROWS_PER_FILE * files.length + 1} />
              </PreviewColumn>
            </PreviewColumns>
          )}
        </PreviewShell>
      )}

      {files.length >= 2 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={!canRun}
          aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件を結合する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="結合が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.result.rows.length}行 × {result.result.header.length}列に結合しました ・ {formatBytes(result.blob.size)}
            {result.result.stats.duplicatesRemoved > 0 && `（同じ行を${result.result.stats.duplicatesRemoved}行除きました）`}
          </p>
          <PreviewGrid
            rows={toGridRows([result.result.header, ...result.result.rows.slice(0, 5).map((r) => r.map(cellToText))])}
            maxRows={6}
            totalRows={result.result.rows.length + 1}
          />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, result.fileName)}
            label={result.format === "csv" ? "CSVでダウンロード" : "Excelでダウンロード"}
          />
        </ResultPopup>
      )}
    </div>
  );
}
