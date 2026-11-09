"use client";

import { useCsvExport } from "@/components/common/csv-export-encoding";
import { CsvEncodingControl } from "@/components/common/csv-encoding-control";
import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRows, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { CsvColumnEditProcessor, editCsvColumnRows, sliceRowRange } from "@/lib/processors/browser/csv-ops";
import { editXlsxColumns, loadXlsxForColumnEdit } from "@/lib/excel/xlsx-column-edit";
import { columnToLetters } from "@/lib/compare/office-reader";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

interface ColumnState {
  /** 元のファイルでの列インデックス（0始まり）。並び替えてもこの値は変わらない */
  originalIndex: number;
  included: boolean;
  renameValue: string;
}

type FileKind = "csv" | "xlsx";

const ACCEPT = ".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function kindOf(file: File): FileKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx")) return "xlsx";
  return null;
}

function unsupportedMessage(file: File): string {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) return `${file.name}：古い形式（.xls）は読み込めません。Excelで「.xlsx」形式で保存し直してから選んでください。`;
  return `${file.name}：対応している形式は、CSV（.csv）とExcel（.xlsx）です。`;
}

function initialColumns(count: number): ColumnState[] {
  return Array.from({ length: count }, (_, i) => ({ originalIndex: i, included: true, renameValue: "" }));
}

/** 入力欄の文字を行番号にする（空欄は「指定なし」） */
function parseRowNumber(value: string): number | undefined {
  const t = value.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * CSV・Excel列編集（Phase 8。工程3でExcel（.xlsx）に対応）。
 *
 * - CSV：既存のRFC4180準拠パーサー/シリアライザ（src/lib/utils/csv.ts）と文字コードの共通処理だけを経由し、CSVで書き出す。
 * - Excel：選んだシートだけを、元のファイルの中で直接書き換えて、Excel（.xlsx）で書き出す（src/lib/excel/xlsx-column-edit.ts）。
 *   ほかのシート・書式・値の種類（数値・日付など）はそのまま保つ。
 * - どちらも、残す列（複数まとめて選べる）・並び順・見出しの名前・対象にする行の範囲を選べる。
 *   プレビューは、出力と同じ列の並べ替え（editCsvColumnRows）を、読み込んだ表に適用したもの。
 */
export function CsvColumnEditorTool() {
  /** CSVの書き出しの文字コード（UTF-8 BOM付き・BOMなし・Shift_JIS）を選んでダウンロードする */
  const csvExport = useCsvExport();
  const [file, setFile] = useState<File | null>(null);
  const kind = file ? kindOf(file) : null;
  const [sheetIndex, setSheetIndex] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [rowStartText, setRowStartText] = useState("");
  const [rowEndText, setRowEndText] = useState("");
  // 列の状態は「どのファイル・どのシートのものか」と一緒に持つ（ファイル・シートが変わったら作り直す）
  const [columnsState, setColumnsState] = useState<{ key: string; columns: ColumnState[] } | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    rowCount: number;
    columnCount: number;
    kind: FileKind;
    notices: string[];
  } | null>(null);

  const { data: csvRows, error: csvError } = useAsyncFileData(kind === "csv" ? file : null, loadCsvRows);
  const { data: xlsxSheets, error: xlsxError } = useAsyncFileData(kind === "xlsx" ? file : null, loadXlsxForColumnEdit);
  const previewError = kind === "csv" ? csvError : kind === "xlsx" ? xlsxError : null;
  const safeSheetIndex = xlsxSheets ? Math.min(sheetIndex, xlsxSheets.length - 1) : 0;
  const sourceRows: string[][] | null = kind === "csv" ? csvRows : xlsxSheets ? xlsxSheets[safeSheetIndex].rows : null;
  const columnCount = sourceRows ? (kind === "csv" ? (sourceRows[0]?.length ?? 0) : Math.max(0, ...sourceRows.map((r) => r.length))) : 0;
  const stateKey = file ? `${file.name}|${file.size}|${file.lastModified}|${kind}|${safeSheetIndex}|${columnCount}` : "";
  const columns = sourceRows && columnsState?.key === stateKey ? columnsState.columns : sourceRows ? initialColumns(columnCount) : null;

  const rowStart = parseRowNumber(rowStartText);
  const rowEnd = parseRowNumber(rowEndText);
  const range = useMemo(() => {
    if (!sourceRows) return { rows: null as string[][] | null, error: null as string | null };
    try {
      return { rows: sliceRowRange(sourceRows, rowStart, rowEnd), error: null };
    } catch (e) {
      return { rows: null, error: e instanceof Error ? e.message : "対象にする行の範囲が正しくありません" };
    }
  }, [sourceRows, rowStart, rowEnd]);

  /** 列の見出し（見出しありのときは、対象の範囲の最初の行の値。無ければ列記号） */
  function labelOf(index: number): string {
    const letter = kind === "xlsx" ? `${columnToLetters(index + 1)}列` : `列${index + 1}`;
    const head = hasHeader ? range.rows?.[0]?.[index] : undefined;
    return head ? head : letter;
  }

  function updateColumns(update: (prev: ColumnState[]) => ColumnState[]) {
    if (!columns) return;
    setColumnsState({ key: stateKey, columns: update(columns) });
    setResult(null);
  }

  function selectFile(files: File[]) {
    const next = files[0];
    if (!next) return;
    setResult(null);
    setStatus("idle");
    setError(null);
    setSheetIndex(0);
    setRowStartText("");
    setRowEndText("");
    if (!kindOf(next)) {
      setFile(null);
      setError(unsupportedMessage(next));
      return;
    }
    setFile(next);
  }

  // プレビュー: 出力と同じ editCsvColumnRows で、現在の設定(残す列・順序・列名・行の範囲)を適用した表を作る
  const preview = useMemo(() => {
    if (!range.rows || !columns) return null;
    const all = range.rows;
    const limited = all.length > PREVIEW_COMPUTE_ROWS;
    const rows = limited ? all.slice(0, PREVIEW_COMPUTE_ROWS) : all;
    const width = Math.max(columnCount, 0);
    const padded = kind === "xlsx" ? rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "")) : rows;
    const included = columns.filter((c) => c.included);
    const excluded = new Set(columns.filter((c) => !c.included).map((c) => c.originalIndex));
    const renames: Record<number, string> = {};
    for (const c of included) {
      if (c.renameValue.trim() !== "") renames[c.originalIndex] = c.renameValue.trim();
    }
    let after: string[][] | null = null;
    let afterError: string | null = null;
    try {
      after = editCsvColumnRows(padded, included.map((c) => c.originalIndex), renames, hasHeader);
    } catch (e) {
      afterError = e instanceof Error ? e.message : "プレビューを作成できませんでした";
    }
    const renamedCols = new Set(Object.keys(renames).map(Number));
    return {
      limited,
      total: all.length,
      before: toGridRows(padded.slice(0, 10), (_, c) => (excluded.has(c) ? "removed" : undefined)),
      after: after
        ? toGridRows(after.slice(0, 10), (r, c) =>
            hasHeader && r === 0 && renamedCols.has(included[c]?.originalIndex) ? "changed" : undefined
          )
        : null,
      afterError,
      rowCount: rows.length,
    };
  }, [range.rows, columns, columnCount, kind, hasHeader]);

  function toggleColumn(index: number) {
    updateColumns((prev) => prev.map((c, i) => (i === index ? { ...c, included: !c.included } : c)));
  }

  function setAllIncluded(included: boolean) {
    updateColumns((prev) => prev.map((c) => ({ ...c, included })));
  }

  function updateRename(index: number, value: string) {
    updateColumns((prev) => prev.map((c, i) => (i === index ? { ...c, renameValue: value } : c)));
  }

  function move(index: number, direction: -1 | 1) {
    updateColumns((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleRun() {
    if (!file || !columns || !kind) return;
    const included = columns.filter((c) => c.included);
    if (included.length === 0) {
      setError("残す列を1つ以上選択してください");
      setStatus("error");
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const renames: Record<number, string> = {};
      for (const c of included) {
        if (c.renameValue.trim() !== "") renames[c.originalIndex] = c.renameValue.trim();
      }
      const common = { columnOrder: included.map((c) => c.originalIndex), renames, hasHeader, rowStart, rowEnd };
      if (kind === "xlsx") {
        const output = await editXlsxColumns({ file, sheetIndex: safeSheetIndex, ...common });
        setResult({ ...output, kind });
      } else {
        const output = await new CsvColumnEditProcessor().process({ file, ...common });
        setResult({ ...output, kind, notices: [] });
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-edited.${result?.kind === "xlsx" ? "xlsx" : "csv"}` : "edited.csv";
  const includedCount = columns?.filter((c) => c.included).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        label="CSV・Excel（.xlsx）ファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={selectFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
      {file && kind === "csv" && <CsvEncodingControl files={[file]} />}
      {file && kind && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="column-editor-kind">
          {kind === "xlsx"
            ? "Excelファイルとして読み込みました。選んだシートだけを編集し、Excel（.xlsx）で書き出します（ほかのシートはそのまま残ります）。"
            : "CSVファイルとして読み込みました。CSVで書き出します。"}
        </p>
      )}

      {kind === "xlsx" && xlsxSheets && xlsxSheets.length > 1 && (
        <label className="flex flex-col gap-1 text-sm text-neutral-600 dark:text-neutral-300">
          編集するシート
          <select
            aria-label="編集するシート"
            value={safeSheetIndex}
            onChange={(e) => {
              setSheetIndex(Number(e.target.value));
              setRowStartText("");
              setRowEndText("");
              setResult(null);
            }}
            className="w-fit rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            {xlsxSheets.map((s, i) => (
              <option key={`${s.name}-${i}`} value={i}>
                {s.name}
                {s.hidden ? "（非表示のシート）" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      {file && sourceRows && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
            対象の範囲の1行目を見出し（列名）として扱う
          </label>
          <div className="flex flex-wrap items-end gap-3 text-sm text-neutral-600 dark:text-neutral-300">
            <span className="basis-full text-xs text-neutral-500 dark:text-neutral-400">
              対象にする行（空欄のときはすべての行。範囲外の行は書き出しに含めません）
            </span>
            <label className="flex flex-col gap-1">
              開始行
              <input
                type="number"
                min={1}
                max={sourceRows.length}
                value={rowStartText}
                placeholder="1"
                aria-label="対象にする行の開始行"
                onChange={(e) => {
                  setRowStartText(e.target.value);
                  setResult(null);
                }}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1">
              終了行
              <input
                type="number"
                min={1}
                max={sourceRows.length}
                value={rowEndText}
                placeholder={String(sourceRows.length)}
                aria-label="対象にする行の終了行"
                onChange={(e) => {
                  setRowEndText(e.target.value);
                  setResult(null);
                }}
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>
          {range.error && <p className="text-xs text-red-600 dark:text-red-400">{range.error}</p>}
          {kind === "xlsx" && xlsxSheets && xlsxSheets[safeSheetIndex].formulaCount > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="column-editor-formula-note">
              このシートには数式が{xlsxSheets[safeSheetIndex].formulaCount}個あります。列の削除・並び替えや行の範囲の指定をすると、
              参照先がずれないよう、このシートの数式は計算結果の値に置き換えます（列名の変更だけなら、数式はそのまま残ります）。
            </p>
          )}
        </div>
      )}

      {previewError && <ErrorMessage message={previewError} />}

      {columns && sourceRows && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {range.rows?.length ?? sourceRows.length}行 ・ {columns.length}列（残す列：{includedCount}列）
            </p>
            <button
              type="button"
              onClick={() => setAllIncluded(true)}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              すべての列を選ぶ
            </button>
            <button
              type="button"
              onClick={() => setAllIncluded(false)}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              すべての列を外す
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {columns.map((col, index) => {
              const label = labelOf(col.originalIndex);
              return (
                <li
                  key={col.originalIndex}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <input type="checkbox" checked={col.included} onChange={() => toggleColumn(index)} aria-label={`${label}を含める`} />
                  <span className="w-36 shrink-0 truncate text-neutral-500 dark:text-neutral-400" title={label}>
                    {label}
                  </span>
                  <input
                    type="text"
                    value={col.renameValue}
                    onChange={(e) => updateRename(index, e.target.value)}
                    placeholder={hasHeader ? "新しい列名（任意）" : "リネームはヘッダーがある場合のみ有効"}
                    disabled={!hasHeader}
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`${label}を上へ移動`}
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === columns.length - 1}
                      aria-label={`${label}を下へ移動`}
                      className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {preview && (
        <BeforeAfterPreview
          title="列編集のプレビュー"
          before={preview.before}
          after={preview.after}
          afterError={preview.afterError}
          beforeLabel="編集前"
          afterLabel="編集後"
          maxRows={10}
          maxCols={8}
          totalRows={preview.rowCount}
          afterTotalRows={preview.rowCount}
          legend={[
            { mark: "removed", label: "削除される列" },
            ...(hasHeader ? [{ mark: "changed" as const, label: "名前を変更する列" }] : []),
          ]}
          notes={[
            ...(preview.limited
              ? [`ファイルが大きいため、先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(全${preview.total}行)。実際の処理は全行が対象です。`]
              : []),
            ...(kind === "xlsx" ? ["Excelの値は表示用の文字で表しています（書き出すファイルでは、数値・日付などの種類と書式をそのまま保ちます）。"] : []),
          ]}
        />
      )}

      {columns && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || includedCount === 0 || range.error !== null}
          aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          この内容で保存する
        </button>
      )}

      <ProcessingStatus state={status} successLabel={result?.kind === "xlsx" ? "Excelの生成が完了しました" : "CSVの生成が完了しました"} />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行 ・ {result.columnCount}列 ・ {formatBytes(result.blob.size)}
          </p>
          {result.notices.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-amber-800 dark:text-amber-300" data-testid="column-editor-notices">
              {result.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {result.kind === "csv" && csvExport.picker}
          {result.kind === "csv" && csvExport.confirm}
          <RewardedDownloadGate
            label={result.kind === "xlsx" ? "Excelでダウンロード" : undefined}
            onDownload={() => (result.kind === "xlsx" ? downloadBlob(result.blob, downloadName) : void csvExport.download(result.blob, downloadName))}
          />
        </ResultPopup>
      )}
    </div>
  );
}
