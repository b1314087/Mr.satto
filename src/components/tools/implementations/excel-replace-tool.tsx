"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  SheetTabs,
  limitSheetRows,
  pickPreviewRowIndexes,
  toGridRows,
  xlsxCellToText,
  xlsxRowsToText,
} from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { ExcelReplaceProcessor, replaceInSheets, type ExcelReplaceScope } from "@/lib/processors/browser/excel-replace";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SCOPE_OPTIONS: { value: ExcelReplaceScope; label: string }[] = [
  { value: "all", label: "シート全体" },
  { value: "column", label: "指定列" },
  { value: "range", label: "指定範囲" },
];

export function ExcelReplaceTool() {
  const [file, setFile] = useState<File | null>(null);
  const [operation, setOperation] = useState<"delete" | "replace">("replace");
  const [find, setFind] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [scope, setScope] = useState<ExcelReplaceScope>("all");
  const [columnLetter, setColumnLetter] = useState("A");
  const [rangeStartRow, setRangeStartRow] = useState(1);
  const [rangeEndRow, setRangeEndRow] = useState(100);
  const [rangeStartCol, setRangeStartCol] = useState(1);
  const [rangeEndCol, setRangeEndCol] = useState(10);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; replacedCount: number } | null>(null);

  const [tab, setTab] = useState(0);
  const { data: sheets, error: previewError, loading } = useAsyncFileData(file, readXlsxSheets);

  // プレビュー: 出力と同じ replaceInSheets で、現在の設定を全シートに適用した結果を表示する
  const preview = useMemo(() => {
    if (!sheets || sheets.length === 0) return null;
    const { sheets: limitedSheets, limited } = limitSheetRows(sheets);
    const index = Math.min(tab, limitedSheets.length - 1);
    const names = sheets.map((s) => s.name);
    const base = { names, index, limited, totalRows: sheets[index].rows.length };
    const sourceRows = limitedSheets[index].rows;
    if (find === "") {
      return {
        ...base,
        error: null as string | null,
        replacedCount: null as number | null,
        rowNumbers: sourceRows.slice(0, 10).map((_, i) => i + 1),
        before: toGridRows(xlsxRowsToText(sourceRows.slice(0, 10))),
        after: null,
      };
    }
    try {
      const result = replaceInSheets(limitedSheets, {
        find,
        replaceWith,
        mode: operation,
        caseSensitive,
        scope,
        columnLetter: scope === "column" ? columnLetter : undefined,
        ...(scope === "range" ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol } : {}),
      });
      const afterRows = result.sheets[index].rows;
      const cols = sourceRows.reduce((max, r) => Math.max(max, r.length), 0);
      const changedRows = new Set<number>();
      sourceRows.forEach((row, r) => {
        for (let c = 0; c < cols; c++) {
          if (xlsxCellToText(row[c]) !== xlsxCellToText(afterRows[r]?.[c])) {
            changedRows.add(r);
            break;
          }
        }
      });
      const picked = pickPreviewRowIndexes(changedRows, sourceRows.length, 10);
      const changed = (r: number, c: number) =>
        xlsxCellToText(sourceRows[r]?.[c]) !== xlsxCellToText(afterRows[r]?.[c]) ? ("changed" as const) : undefined;
      return {
        ...base,
        error: null,
        replacedCount: result.replacedCount,
        rowNumbers: picked.map((r) => r + 1),
        before: picked.map((r) => toGridRows([xlsxRowsToText([sourceRows[r]], cols)[0]], (_, c) => changed(r, c))[0]),
        after: picked.map((r) => toGridRows([xlsxRowsToText([afterRows[r] ?? []], cols)[0]], (_, c) => changed(r, c))[0]),
      };
    } catch (e) {
      return {
        ...base,
        error: e instanceof Error ? e.message : "プレビューを作成できませんでした",
        replacedCount: null,
        rowNumbers: sourceRows.slice(0, 10).map((_, i) => i + 1),
        before: toGridRows(xlsxRowsToText(sourceRows.slice(0, 10))),
        after: null,
      };
    }
  }, [sheets, tab, find, replaceWith, operation, caseSensitive, scope, columnLetter, rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol]);

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
      const output = await new ExcelReplaceProcessor().process({
        file,
        find,
        replaceWith,
        mode: operation,
        caseSensitive,
        scope,
        columnLetter: scope === "column" ? columnLetter : undefined,
        ...(scope === "range" ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol } : {}),
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-replaced.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={50}
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOperation("replace")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                operation === "replace"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              置換
            </button>
            <button
              type="button"
              onClick={() => setOperation("delete")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                operation === "delete"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              削除
            </button>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              検索する文字列
              <input
                type="text"
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="例: 株式会社"
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            {operation === "replace" && (
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                置換後の文字列
                <input
                  type="text"
                  value={replaceWith}
                  onChange={(e) => setReplaceWith(e.target.value)}
                  placeholder="例: ㈱"
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            大文字・小文字を区別する
          </label>

          <div className="flex flex-col gap-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">対象範囲</p>
            <div className="flex flex-wrap gap-2">
              {SCOPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setScope(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    scope === opt.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {scope === "column" && (
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400 sm:w-32">
              対象の列（例: B）
              <input
                type="text"
                value={columnLetter}
                onChange={(e) => setColumnLetter(e.target.value)}
                maxLength={3}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}

          {scope === "range" && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                開始行
                <input
                  type="number"
                  min={1}
                  value={rangeStartRow}
                  onChange={(e) => setRangeStartRow(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                終了行
                <input
                  type="number"
                  min={1}
                  value={rangeEndRow}
                  onChange={(e) => setRangeEndRow(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                開始列
                <input
                  type="number"
                  min={1}
                  value={rangeStartCol}
                  onChange={(e) => setRangeStartCol(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                終了列
                <input
                  type="number"
                  min={1}
                  value={rangeEndCol}
                  onChange={(e) => setRangeEndCol(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {file && (preview || previewError || loading) && (
        <BeforeAfterPreview
          title={operation === "delete" ? "削除のプレビュー" : "置換のプレビュー"}
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={previewError ?? preview?.error ?? null}
          beforeLabel={operation === "delete" ? "削除前" : "置換前"}
          afterLabel={operation === "delete" ? "削除後" : "置換後"}
          maxRows={10}
          maxCols={8}
          headerRow={false}
          beforeRowLabels={preview?.rowNumbers}
          afterRowLabels={preview?.rowNumbers}
          header={preview && <SheetTabs names={preview.names} active={preview.index} onChange={setTab} />}
          summary={
            preview &&
            (preview.replacedCount === null ? (
              !preview.error && <span>「検索する文字列」を入力すると、{operation === "delete" ? "削除" : "置換"}後の表がここに表示されます。</span>
            ) : (
              <span>
                {operation === "delete" ? "削除" : "置換"}される見込み: {preview.replacedCount}箇所（文字列のセルだけが対象。全シートに同じ設定を適用）
              </span>
            ))
          }
          legend={preview?.replacedCount != null ? [{ mark: "changed", label: "変更されるセル(変更のある行を優先して表示。左端の数字は元の行番号)" }] : undefined}
          notes={
            preview?.limited
              ? [`ファイルが大きいため、各シートの先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(表示中のシートは全${preview.totalRows}行)。実際の処理は全行が対象です。`]
              : undefined
          }
        />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || find === ""}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {operation === "delete" ? "削除を実行する" : "置換を実行する"}
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{result.replacedCount}箇所を処理しました</p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
