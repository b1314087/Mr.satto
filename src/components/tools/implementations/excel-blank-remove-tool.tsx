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
  toGridRows,
  xlsxRowsToText,
} from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { columnIndexToLetter, readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import {
  ExcelBlankRemoveProcessor,
  removeBlanksFromSheetRows,
  type BlankRemoveMode,
} from "@/lib/processors/browser/excel-blank-remove";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MODE_OPTIONS: { value: BlankRemoveMode; label: string }[] = [
  { value: "rows", label: "空白行のみ" },
  { value: "columns", label: "空白列のみ" },
  { value: "both", label: "両方" },
];

export function ExcelBlankRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<BlankRemoveMode>("both");
  const [useRange, setUseRange] = useState(false);
  const [rangeStartRow, setRangeStartRow] = useState(1);
  const [rangeEndRow, setRangeEndRow] = useState(100);
  const [rangeStartCol, setRangeStartCol] = useState(1);
  const [rangeEndCol, setRangeEndCol] = useState(20);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; removedRows: number; removedColumns: number } | null>(null);

  const [tab, setTab] = useState(0);
  const { data: sheets, error: previewError, loading } = useAsyncFileData(file, readXlsxSheets);

  // プレビュー: 出力と同じ removeBlanksFromSheetRows で、選んだシートの空白行・空白列を取り除く
  const preview = useMemo(() => {
    if (!sheets || sheets.length === 0) return null;
    const { sheets: limitedSheets, limited } = limitSheetRows(sheets);
    const index = Math.min(tab, limitedSheets.length - 1);
    const names = sheets.map((s) => s.name);
    try {
      const result = removeBlanksFromSheetRows(limitedSheets[index].rows, {
        mode,
        ...(useRange ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol } : {}),
      });
      const source = xlsxRowsToText(result.source);
      const removedRowList = Array.from(result.removedRowIndexes).map((r) => r + 1);
      const removedColList = Array.from(result.removedColumnIndexes).map((c) => columnIndexToLetter(c));
      // 削除される行がある場合は、その周辺が見えるよう、削除行を含む行を優先して表示する
      const shownIdx: number[] = [];
      const wanted = new Set<number>();
      for (const r of result.removedRowIndexes) {
        if (wanted.size >= 4) break;
        wanted.add(r);
        if (r > 0) wanted.add(r - 1);
      }
      for (let r = 0; r < source.length && shownIdx.length < 10; r++) {
        if (r < 4 || wanted.has(r)) shownIdx.push(r);
      }
      const afterText = xlsxRowsToText(result.rows);
      return {
        error: null as string | null,
        names,
        index,
        limited,
        totalRows: sheets[index].rows.length,
        removedRowList,
        removedColList,
        shownRowNumbers: shownIdx.map((r) => r + 1),
        before: shownIdx.map(
          (r) =>
            toGridRows([source[r]], (_, c) =>
              result.removedRowIndexes.has(r) || result.removedColumnIndexes.has(c) ? "removed" : undefined
            )[0]
        ),
        after: toGridRows(afterText.slice(0, 10)),
        afterSize: [afterText.length, afterText[0]?.length ?? 0],
        beforeSize: [source.length, source[0]?.length ?? 0],
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : "プレビューを作成できませんでした",
        names,
        index,
        limited,
        totalRows: 0,
        removedRowList: [] as number[],
        removedColList: [] as string[],
        shownRowNumbers: [] as number[],
        before: null,
        after: null,
        afterSize: [0, 0],
        beforeSize: [0, 0],
      };
    }
  }, [sheets, tab, mode, useRange, rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol]);

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
      const output = await new ExcelBlankRemoveProcessor().process({
        file,
        mode,
        ...(useRange
          ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol }
          : {}),
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
    downloadBlob(result.blob, `${stripExtension(file.name)}-cleaned.xlsx`);
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
          <div className="flex flex-wrap gap-2">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} />
            範囲を指定する（未指定の場合はシート全体が対象）
          </label>

          {useRange && (
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
          title="空白削除のプレビュー"
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={previewError ?? preview?.error ?? null}
          beforeLabel="削除前"
          afterLabel="削除後"
          maxRows={10}
          maxCols={8}
          headerRow={false}
          afterTotalRows={preview?.afterSize[0]}
          beforeRowLabels={preview?.shownRowNumbers}
          header={preview && <SheetTabs names={preview.names} active={preview.index} onChange={setTab} />}
          summary={
            preview &&
            !preview.error && (
              <span>
                {preview.beforeSize[0]}行 × {preview.beforeSize[1]}列 → {preview.afterSize[0]}行 × {preview.afterSize[1]}列
                {preview.removedRowList.length > 0 &&
                  ` ／ 除去される行: ${preview.removedRowList.slice(0, 8).join("、")}${preview.removedRowList.length > 8 ? "…" : ""}行目`}
                {preview.removedColList.length > 0 &&
                  ` ／ 除去される列: ${preview.removedColList.slice(0, 8).join("、")}${preview.removedColList.length > 8 ? "…" : ""}列`}
                （すべてのシートに同じ設定を適用）
              </span>
            )
          }
          legend={[{ mark: "removed", label: "削除される空白の行・列" }]}
          notes={[
            "削除される行がある場合は、その周辺の行を優先して表示しています(左端の数字は元の行番号)。",
            ...(preview?.limited
              ? [`ファイルが大きいため、各シートの先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(表示中のシートは全${preview.totalRows}行)。実際の処理は全行が対象です。`]
              : []),
          ]}
        />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          空白を削除する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="削除が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除した行: {result.removedRows} ・ 削除した列: {result.removedColumns}
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
