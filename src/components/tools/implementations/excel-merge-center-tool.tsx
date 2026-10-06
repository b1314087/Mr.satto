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
  limitSheetRows,
  xlsxCellToText,
  type GridCell,
} from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import {
  ExcelMergeCenterProcessor,
  applyMergeCenter,
  type MergeCenterCell,
} from "@/lib/processors/browser/excel-merge-center";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function ExcelMergeCenterTool() {
  const [file, setFile] = useState<File | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);

  const [startRow, setStartRow] = useState(1);
  const [endRow, setEndRow] = useState(1);
  const [startCol, setStartCol] = useState(1);
  const [endCol, setEndCol] = useState(4);
  const [merge, setMerge] = useState(true);
  const [horizontalCenter, setHorizontalCenter] = useState(true);
  const [verticalCenter, setVerticalCenter] = useState(true);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; processedRowCount: number } | null>(null);

  // ファイルの読み込み(シート名の取得とプレビューの両方に使う。ファイルごとに1回だけ読む)
  const { data: sheets, error: loadError, loading } = useAsyncFileData(file, readXlsxSheets);
  const sheetNames = useMemo(() => sheets?.map((s) => s.name) ?? [], [sheets]);

  // プレビュー: 出力と同じ applyMergeCenter で、現在の設定(結合・中央揃え・範囲)を適用した結果を表示する
  const preview = useMemo(() => {
    if (!sheets || sheets.length === 0) return null;
    const { sheets: limitedSheets, limited } = limitSheetRows(sheets);
    const index = Math.min(sheetIndex, limitedSheets.length - 1);
    const sourceRows = limitedSheets[index].rows;
    const cols = Math.max(endCol, sourceRows.reduce((max, r) => Math.max(max, r.length), 0));
    // 対象範囲の1行上から10行を表示する
    const first = Math.max(0, Math.min(startRow - 2, Math.max(0, sourceRows.length - 10)));
    const shownIdx = Array.from({ length: Math.min(10, sourceRows.length - first) }, (_, i) => first + i);
    const inTarget = (r: number, c: number) =>
      r >= startRow - 1 && r <= endRow - 1 && c >= startCol - 1 && c <= endCol - 1;
    const before: GridCell[][] = shownIdx.map((r) =>
      Array.from({ length: cols }, (_, c) => ({
        text: xlsxCellToText(sourceRows[r]?.[c]),
        mark: inTarget(r, c) ? ("target" as const) : undefined,
      }))
    );
    const base = {
      limited,
      totalRows: sheets[index].rows.length,
      rowNumbers: shownIdx.map((r) => r + 1),
      before,
    };
    try {
      const result = applyMergeCenter(limitedSheets, {
        sheetIndex: index,
        startRow,
        endRow,
        startCol,
        endCol,
        merge,
        horizontalCenter,
        verticalCenter,
      });
      const outRows = result.sheets[index].rows as MergeCenterCell[][];
      const after: GridCell[][] = shownIdx.map((r) => {
        const row = outRows[r] ?? [];
        const cells: GridCell[] = [];
        for (let c = 0; c < cols; ) {
          const cell = row[c] as MergeCenterCell;
          const isObj = typeof cell === "object" && cell !== null && !(cell instanceof Date) && "value" in cell;
          const span: number = isObj && typeof cell.columnSpan === "number" ? cell.columnSpan : 1;
          cells.push({
            text: xlsxCellToText(isObj ? cell.value : cell),
            colSpan: span > 1 ? span : undefined,
            align: isObj && cell.align === "center" ? "center" : undefined,
            vAlign: isObj && cell.alignVertical === "center" ? "middle" : undefined,
            mark: inTarget(r, c) ? "target" : undefined,
          });
          c += span;
        }
        return cells;
      });
      return { ...base, error: null as string | null, processed: result.processedRowCount, after };
    } catch (e) {
      return {
        ...base,
        error: e instanceof Error ? e.message : "プレビューを作成できませんでした",
        processed: 0,
        after: null,
      };
    }
  }, [sheets, sheetIndex, startRow, endRow, startCol, endCol, merge, horizontalCenter, verticalCenter]);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setSheetIndex(0);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelMergeCenterProcessor().process({
        file,
        sheetIndex,
        startRow,
        endRow,
        startCol,
        endCol,
        merge,
        horizontalCenter,
        verticalCenter,
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
    downloadBlob(result.blob, `${stripExtension(file.name)}-merged.xlsx`);
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
      {file && loadError && <ErrorMessage message={loadError} />}

      {sheetNames.length > 1 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">対象シート</p>
          <div className="flex flex-wrap gap-2">
            {sheetNames.map((name, i) => (
              <button
                key={`${name}-${i}`}
                type="button"
                onClick={() => setSheetIndex(i)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  i === sheetIndex
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {file && sheetNames.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            対象範囲（行番号・列番号は1始まり。複数行を指定すると各行に同じ処理を適用します）
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              開始行
              <input
                type="number"
                min={1}
                value={startRow}
                onChange={(e) => setStartRow(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              終了行
              <input
                type="number"
                min={1}
                value={endRow}
                onChange={(e) => setEndRow(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              開始列
              <input
                type="number"
                min={1}
                value={startCol}
                onChange={(e) => setStartCol(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              終了列
              <input
                type="number"
                min={1}
                value={endCol}
                onChange={(e) => setEndCol(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-neutral-600 dark:text-neutral-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
              セルを結合する
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={horizontalCenter}
                onChange={(e) => setHorizontalCenter(e.target.checked)}
              />
              水平方向中央揃え
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={verticalCenter}
                onChange={(e) => setVerticalCenter(e.target.checked)}
              />
              垂直方向中央揃え
            </label>
          </div>
          {!merge && (
            <p className="text-xs text-neutral-400">
              「セルを結合する」をオフにすると、結合せずに中央揃えだけを適用します
            </p>
          )}
        </div>
      )}

      {file && (preview || loading) && (
        <BeforeAfterPreview
          title="結合・中央揃えのプレビュー"
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={preview?.error ?? null}
          beforeLabel="処理前"
          afterLabel="処理後"
          maxRows={10}
          maxCols={8}
          headerRow={false}
          beforeRowLabels={preview?.rowNumbers}
          afterRowLabels={preview?.rowNumbers}
          summary={
            preview &&
            !preview.error && <span>対象は{preview.processed}行です（対象シート: {sheetNames[sheetIndex] ?? ""}）</span>
          }
          legend={[{ mark: "target", label: "対象範囲" }]}
          notes={[
            "セルを結合すると、範囲の一番左のセルの値だけが残り、他のセルの値は消えます。",
            ...(preview?.limited
              ? [`ファイルが大きいため、先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(全${preview.totalRows}行)。実際の処理は全行が対象です。`]
              : []),
          ]}
        />
      )}

      {file && sheetNames.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          実行する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{result.processedRowCount}行を処理しました</p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
