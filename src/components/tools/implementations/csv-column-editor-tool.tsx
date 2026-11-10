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
import { CsvColumnEditProcessor, applyRowOrder, editCsvColumnRows, sliceRowRange } from "@/lib/processors/browser/csv-ops";
import { editXlsxColumns, loadXlsxForColumnEdit, type XlsxFormulaReport } from "@/lib/excel/xlsx-column-edit";
import { columnToLetters } from "@/lib/compare/office-reader";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { AdvancedSettings } from "@/components/ui/advanced-settings";

interface ColumnState {
  /** 元のファイルでの列インデックス（0始まり）。並び替えてもこの値は変わらない */
  originalIndex: number;
  included: boolean;
  renameValue: string;
}

type FileKind = "csv" | "xlsx";

/** 新工程1：行の編集の状態（対象の範囲の中の行の番号・0始まり。並び替えてもこの値は変わらない） */
interface RowState {
  index: number;
  included: boolean;
}

/** 行・列のどちらを編集する画面を出すか（どちらの設定も保存のときに両方使う） */
type EditTarget = "columns" | "rows";

/** 行の編集で、1行ずつ並べて表示できる行数の上限（多いときは、対象にする行の範囲を指定してもらう） */
const ROW_EDIT_MAX_ROWS = 1000;

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
 * 新工程1：「行を編集」「列を編集」を切り替えられるようにした。
 * - 行の編集：残す行（チェック）と、行の並び順（↑↓）を選べる。見出しありのときは、見出しの行は先頭に固定する。
 *   列の編集と同じ「対象にする行の範囲」の中で編集する（範囲の中が ROW_EDIT_MAX_ROWS 行を超えるときは、範囲の指定を案内する）。
 * - 行と列の設定は、切り替えても消えない。保存のときは、行の編集（applyRowOrder）→列の編集の順に、両方を反映する。
 * - Excelは、列の編集と同じ仕組み（src/lib/excel/xlsx-column-edit.ts の rowOrder）で、選んだシートだけを書き換える。
 *   数式は、行の並び替え・削除のあとも、安全に合わせられるものは数式のまま残す（合わせられないものだけ値にする）。
 *
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
  const [editTarget, setEditTarget] = useState<EditTarget>("columns");
  // 行の状態も「どのファイル・シート・行の範囲・見出しの有無のものか」と一緒に持つ（変わったら作り直す）
  const [rowsState, setRowsState] = useState<{ key: string; rows: RowState[] } | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    rowCount: number;
    columnCount: number;
    kind: FileKind;
    notices: string[];
    formulas: XlsxFormulaReport | null;
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

  // 行の編集の対象（見出しありのときは、見出しの行を除いた行）
  const rangeRowCount = range.rows?.length ?? 0;
  const firstDataIndex = hasHeader ? 1 : 0;
  const rowKey = `${stateKey}|${rowStartText}|${rowEndText}|${hasHeader}|${rangeRowCount}`;
  const editableRowCount = Math.max(0, rangeRowCount - firstDataIndex);
  const rowEditTooMany = editableRowCount > ROW_EDIT_MAX_ROWS;
  const rows: RowState[] | null =
    range.rows && !rowEditTooMany
      ? rowsState?.key === rowKey
        ? rowsState.rows
        : Array.from({ length: editableRowCount }, (_, i) => ({ index: i + firstDataIndex, included: true }))
      : null;
  const rowsEdited = !!rows && rowsState?.key === rowKey && rows.some((r, i) => !r.included || r.index !== i + firstDataIndex);
  /** 出力する行の順番（対象の範囲の中の番号）。行を編集していなければ undefined（そのまま） */
  const rowOrder: number[] | undefined = useMemo(
    () => (rows && rowsEdited ? [...(hasHeader ? [0] : []), ...rows.filter((r) => r.included).map((r) => r.index)] : undefined),
    [rows, rowsEdited, hasHeader]
  );
  const includedRowCount = rows ? rows.filter((r) => r.included).length : editableRowCount;

  function updateRows(update: (prev: RowState[]) => RowState[]) {
    if (!rows) return;
    setRowsState({ key: rowKey, rows: update(rows) });
    setResult(null);
  }

  /** 行の表示名（元のファイルの何行目か）と、その行の最初のいくつかの値 */
  function rowLabel(index: number): { name: string; values: string } {
    const sheetRow = (rowStart ?? 1) + index;
    const values = (range.rows?.[index] ?? []).filter((v) => v !== "").slice(0, 4).join(" ／ ");
    return { name: `${sheetRow}行目`, values: values || "（空の行）" };
  }

  function moveRow(position: number, direction: -1 | 1) {
    updateRows((prev) => {
      const target = position + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[position], next[target]] = [next[target], next[position]];
      return next;
    });
  }

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
    let all: string[][];
    try {
      all = applyRowOrder(range.rows, rowOrder);
    } catch {
      all = range.rows;
    }
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
  }, [range.rows, columns, columnCount, kind, hasHeader, rowOrder]);

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
      if (rowOrder && rowOrder.length === (hasHeader ? 1 : 0)) {
        throw new Error("残す行を1つ以上選択してください");
      }
      if (kind === "xlsx") {
        // Excelの行の指定は、シートの行番号（1始まり）で渡す
        const sheetRowOrder = rowOrder?.map((i) => (rowStart ?? 1) + i);
        const output = await editXlsxColumns({ file, sheetIndex: safeSheetIndex, ...common, rowOrder: sheetRowOrder });
        setResult({ ...output, kind });
      } else {
        const output = await new CsvColumnEditProcessor().process({ file, ...common, rowOrder });
        setResult({ ...output, kind, notices: [], formulas: null });
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
        compact={!!file}
        accept={ACCEPT}
        label="CSV・Excel（.xlsx）ファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={selectFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
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

      {columns && sourceRows && (
        <div role="group" aria-label="編集の対象" data-testid="column-editor-target" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm font-medium text-ms-text">編集するもの</span>
          <div className="ms-seg">
            {(
              [
                { value: "rows", label: "行を編集" },
                { value: "columns", label: "列を編集" },
              ] as const
            ).map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={editTarget === t.value}
                data-testid={`column-editor-target-${t.value}`}
                onClick={() => setEditTarget(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-ms-muted" data-testid="column-editor-summary" title="行と列の設定は、切り替えても残り、保存のときに両方反映します">
            残す行：{includedRowCount}行 ・ 残す列：{includedCount}列
          </span>
        </div>
      )}

      {/* 読み込みの設定（文字コード・見出しの扱い・対象の行）は、ふだんは変えないので閉じておく。閉じていても今の値を出す */}
      {file && sourceRows && (
        <AdvancedSettings
          title="読み込みの設定"
          summary={
            <span data-testid="column-editor-kind">
              {kind === "xlsx" ? "Excelファイル（このシートだけ編集）" : "CSVファイル"}・{hasHeader ? "1行目を見出し" : "見出しなし"}・
              {rowStartText || rowEndText ? `${rowStartText || 1}〜${rowEndText || sourceRows.length}行` : "全行"}
            </span>
          }
          testId="column-editor-read-settings"
        >
          {kind === "csv" && <CsvEncodingControl files={[file]} />}
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              対象の範囲の1行目を見出し（列名）として扱う
            </label>
            <div className="flex flex-wrap items-end gap-3 text-sm text-neutral-600 dark:text-neutral-300">
              <span className="basis-full text-xs text-ms-muted">対象にする行（空欄ならすべて）</span>
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
          </div>
        </AdvancedSettings>
      )}
      {file && sourceRows && range.error && <p className="text-xs text-red-600 dark:text-red-400">{range.error}</p>}
      {file && sourceRows && kind === "xlsx" && xlsxSheets && xlsxSheets[safeSheetIndex].formulaCount > 0 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="column-editor-formula-note">
          このシートには数式が{xlsxSheets[safeSheetIndex].formulaCount}個あります。数式はできるだけ残し、参照を新しい位置に合わせます
          （合わせられないものだけ値に置き換え、保存のあとに数を表示します）。
        </p>
      )}

      {previewError && <ErrorMessage message={previewError} />}

      {editTarget === "rows" && columns && sourceRows && (
        <div className="flex flex-col gap-2" data-testid="row-editor">
          {rowEditTooMany ? (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="row-editor-too-many">
              対象の行が{editableRowCount}行あります。行の編集は{ROW_EDIT_MAX_ROWS}行までの範囲で使えます。上の「対象にする行」で範囲を指定してください。
            </p>
          ) : rows && rows.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">編集できる行がありません。</p>
          ) : (
            rows && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    チェックを外した行は削除します。↑↓で行の順番を変えられます。
                    {hasHeader && "見出し（列名）の行は、いつも先頭に残します。"}
                  </p>
                  <button
                    type="button"
                    onClick={() => updateRows((prev) => prev.map((r) => ({ ...r, included: true })))}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    すべての行を選ぶ
                  </button>
                  <button
                    type="button"
                    onClick={() => updateRows((prev) => prev.map((r) => ({ ...r, included: false })))}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    すべての行を外す
                  </button>
                  <button
                    type="button"
                    onClick={() => setRowsState(null)}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    元の順に戻す
                  </button>
                </div>
                <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
                  {rows.map((row, position) => {
                    const label = rowLabel(row.index);
                    return (
                      <li
                        key={row.index}
                        data-testid="row-editor-row"
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                          row.included
                            ? "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
                            : "border-red-200 bg-red-50 opacity-70 dark:border-red-900 dark:bg-red-950/20"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={row.included}
                          onChange={() => updateRows((prev) => prev.map((r, i) => (i === position ? { ...r, included: !r.included } : r)))}
                          aria-label={`${label.name}を含める`}
                        />
                        <span className="w-16 shrink-0 text-xs text-neutral-500 dark:text-neutral-400">{label.name}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-200" title={label.values}>
                          {label.values}
                        </span>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => moveRow(position, -1)}
                            disabled={position === 0}
                            aria-label={`${label.name}を上へ移動`}
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => moveRow(position, 1)}
                            disabled={position === rows.length - 1}
                            aria-label={`${label.name}を下へ移動`}
                            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
                          >
                            ↓
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )
          )}
        </div>
      )}

      {editTarget === "columns" && columns && sourceRows && (
        <div className="flex flex-col gap-2" data-testid="column-editor-columns">
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
          title="編集のプレビュー"
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
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || includedCount === 0 || range.error !== null || (!!rows && includedRowCount === 0 && editableRowCount > 0)}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            この内容で保存する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel={result?.kind === "xlsx" ? "Excelの生成が完了しました" : "CSVの生成が完了しました"} />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行 ・ {result.columnCount}列 ・ {formatBytes(result.blob.size)}
          </p>
          {result.formulas && (result.formulas.kept > 0 || result.formulas.converted > 0 || result.formulas.otherAdjusted > 0 || result.formulas.otherConverted > 0) && (
            <div
              data-testid="column-editor-formulas"
              data-converted={result.formulas.converted + result.formulas.otherConverted}
              className={`flex flex-col gap-1 rounded-lg border p-3 text-xs ${
                result.formulas.converted + result.formulas.otherConverted > 0
                  ? "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200"
                  : "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
              }`}
            >
              <p className="font-semibold">数式の扱い</p>
              {result.formulas.kept > 0 && <p>このシートの数式{result.formulas.kept}個は、数式のまま残しました（セルの参照は新しい位置に合わせています）。</p>}
              {result.formulas.converted > 0 && (
                <p className="font-semibold">
                  このシートの数式{result.formulas.converted}個は、参照先を安全に合わせられないため、計算結果の値に置き換えました。これらのセルには数式が残っていません。
                  {result.formulas.convertedEmpty > 0 && `（そのうち${result.formulas.convertedEmpty}個は、計算結果がファイルに保存されていなかったため空欄になりました）`}
                </p>
              )}
              {result.formulas.otherAdjusted > 0 && <p>ほかのシートの数式{result.formulas.otherAdjusted}個の、このシートへの参照を、新しい位置に合わせました。</p>}
              {result.formulas.otherConverted > 0 && (
                <p className="font-semibold">
                  ほかのシートの数式{result.formulas.otherConverted}個は、このシートへの参照を安全に合わせられないため、計算結果の値に置き換えました。これらのセルには数式が残っていません。
                </p>
              )}
            </div>
          )}
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
