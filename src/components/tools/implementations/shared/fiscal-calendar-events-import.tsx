"use client";

import { useId, useState } from "react";
import { placeEvents, calendarDateRange } from "@/lib/calendar/events";
import {
  COLUMN_ROLES,
  COLUMN_ROLE_LABELS,
  columnLabels,
  detectLayout,
  parseEventRows,
  pickEventSheet,
  summarizeImport,
  type ColumnMapping,
  type ColumnRole,
  type EventCellValue,
  type ImportResult,
} from "@/lib/calendar/event-import";
import type { FiscalCalendar } from "@/lib/calendar/model";

/** 読み込んだExcelの予定表（シートごとの行）と、いま選んでいるシート・列の割り当て・読み取り結果 */
export interface EventImportState {
  fileName: string;
  sheets: { name: string; rows: EventCellValue[][] }[];
  sheetIndex: number;
  /** 見出し行の位置（0始まり）。見出しなしは -1 */
  headerRow: number;
  mapping: ColumnMapping;
  /** 列を自動で判定できたか（false のときは、列の選択を開いて知らせる） */
  detected: boolean;
  /** 日付・予定の列が決まっているときの読み取り結果 */
  result: ImportResult | null;
  /** 読み取りで起きたエラー（行数が多すぎるなど） */
  error: string | null;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ISSUE_ROWS_SHOWN = 30;

const EMPTY_MAPPING: ColumnMapping = { date: null, title: null, start: null, end: null };

/** 列の割り当てから読み取り結果を作る（日付・予定の列が決まっていないときは null） */
function compute(rows: EventCellValue[][], mapping: ColumnMapping, headerRow: number): { result: ImportResult | null; error: string | null } {
  if (mapping.date === null || mapping.title === null) return { result: null, error: null };
  try {
    return { result: parseEventRows(rows, mapping, headerRow), error: null };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : "予定表の読み込みに失敗しました" };
  }
}

function stateForSheet(base: Pick<EventImportState, "fileName" | "sheets">, sheetIndex: number): EventImportState {
  const rows = base.sheets[sheetIndex].rows;
  const layout = detectLayout(rows);
  const mapping = layout?.mapping ?? EMPTY_MAPPING;
  const headerRow = layout?.headerRow ?? 0;
  return { ...base, sheetIndex, headerRow, mapping, detected: !!layout, ...compute(rows, mapping, headerRow) };
}

const selectClass = "rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * Excelの予定表（日付・予定・開始時刻・終了時刻の一覧）を読み込む部品。
 * ファイルの内容は、この端末のブラウザの中だけで読み取り、外部へは送信しない。
 */
export function FiscalCalendarEventsImport({
  calendar,
  value,
  onChange,
}: {
  calendar: FiscalCalendar;
  value: EventImportState | null;
  onChange: (next: EventImportState | null) => void;
}) {
  const inputId = useId();
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
      setFileError(
        /\.xls$/i.test(file.name)
          ? "古い形式（.xls）は読み込めません。Excelで「名前を付けて保存」から、Excelブック（.xlsx）にして選んでください。"
          : "Excelファイル（.xlsx）を選んでください。",
      );
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError("ファイルが大きすぎます（10MBまで）。予定の行だけを残したExcelにして選んでください。");
      return;
    }
    setReading(true);
    try {
      const { readXlsxSheets } = await import("@/lib/excel/xlsx-simple-io");
      const sheets = await readXlsxSheets(file);
      const base = { fileName: file.name, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows as EventCellValue[][] })) };
      onChange(stateForSheet(base, pickEventSheet(base.sheets)));
    } catch (e) {
      setFileError(e instanceof Error ? e.message : "Excelファイルを読み込めませんでした");
    } finally {
      setReading(false);
    }
  }

  function update(patch: Partial<Pick<EventImportState, "mapping" | "headerRow">>) {
    if (!value) return;
    const mapping = patch.mapping ?? value.mapping;
    const headerRow = patch.headerRow ?? value.headerRow;
    onChange({ ...value, mapping, headerRow, ...compute(value.sheets[value.sheetIndex].rows, mapping, headerRow) });
  }

  const rows = value ? value.sheets[value.sheetIndex].rows : [];
  const labels = value ? columnLabels(rows, value.headerRow) : [];
  const placed = value?.result ? placeEvents(calendar, value.result.events) : null;
  const summary = value?.result && placed ? summarizeImport(value.result, placed.inRange.length) : null;
  const range = calendarDateRange(calendar);
  const rangeLabel = `${range.start.replace(/-/g, "/")}〜${range.end.replace(/-/g, "/")}`;
  const outOfRangeSample = placed ? [...new Set(placed.outOfRange.map((e) => e.date.replace(/-/g, "/")))].sort().slice(0, 5) : [];

  return (
    <fieldset data-testid="events-import" className="flex flex-col gap-2 text-sm">
      <legend className="mb-1 text-neutral-600 dark:text-neutral-300">予定データ</legend>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        日付・予定・開始時刻・終了時刻が並んだExcelの予定表を選ぶと、カレンダーの該当する日に予定を入れます。ファイルの内容は、この端末の中だけで処理され、サーバーには送信されません。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={inputId}
          className="cursor-pointer rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          Excelの予定表を選ぶ
        </label>
        <input
          id={inputId}
          data-testid="events-file"
          type="file"
          accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            // 同じファイルをもう一度選べるようにする
            e.target.value = "";
          }}
        />
        {value && (
          <button
            type="button"
            data-testid="events-clear"
            onClick={() => {
              setFileError(null);
              onChange(null);
            }}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            予定の読み込みを取り消す
          </button>
        )}
        {reading && <span className="text-xs text-neutral-500">読み込み中…</span>}
      </div>
      {fileError && (
        <p role="alert" data-testid="events-file-error" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          {fileError}
        </p>
      )}

      {value && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
          <p className="break-all text-xs text-neutral-600 dark:text-neutral-300">
            ファイル: <span data-testid="events-file-name">{value.fileName}</span>
          </p>

          {value.sheets.length > 1 && (
            <label className="flex flex-col gap-1 text-xs sm:w-2/3">
              <span className="text-neutral-600 dark:text-neutral-300">読み込むシート</span>
              <select
                data-testid="events-sheet"
                value={value.sheetIndex}
                onChange={(e) => onChange(stateForSheet({ fileName: value.fileName, sheets: value.sheets }, Number(e.target.value)))}
                className={selectClass}
              >
                {value.sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {value.error && (
            <p role="alert" data-testid="events-error" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
              {value.error}
            </p>
          )}

          {!value.detected && !value.result && !value.error && (
            <p data-testid="events-undetected" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              列の見出しから「日付」「予定」の列を自動では判定できませんでした。下で、日付と予定の列を選んでください。
            </p>
          )}

          {summary && placed && (
            <div data-testid="events-summary" className="flex flex-col gap-0.5 text-sm">
              <p data-testid="events-count-recognized" className="font-medium">
                {summary.recognized}件の予定を読み込みました
              </p>
              <p data-testid="events-count-rows" className="text-xs text-neutral-600 dark:text-neutral-300">
                読み込んだ行数: {summary.totalRows}行（空の行は数えません）
              </p>
              <p data-testid="events-count-inyear">対象年度内：{summary.inYear}件（{rangeLabel}）</p>
              <p data-testid="events-count-outyear" className={summary.outOfYear > 0 ? "text-amber-800 dark:text-amber-300" : ""}>
                対象年度外：{summary.outOfYear}件
                {summary.outOfYear > 0 && (
                  <span className="block text-xs">
                    対象年度外のためカレンダーには配置されません（{outOfRangeSample.join("、")}
                    {new Set(placed.outOfRange.map((e) => e.date)).size > outOfRangeSample.length ? " ほか" : ""}）
                  </span>
                )}
              </p>
              <p data-testid="events-count-baddate" className={summary.badDateRows > 0 ? "text-red-700 dark:text-red-300" : ""}>
                日付を認識できない行：{summary.badDateRows}件
              </p>
              <p data-testid="events-count-emptytitle" className={summary.emptyTitleRows > 0 ? "text-red-700 dark:text-red-300" : ""}>
                予定名が空の行：{summary.emptyTitleRows}件
              </p>
              {summary.badTimeRows > 0 && (
                <p data-testid="events-count-badtime" className="text-amber-800 dark:text-amber-300">
                  時刻を読み取れない行：{summary.badTimeRows}件（その時刻は使わずに配置します）
                </p>
              )}
              {summary.weekdayMismatchRows > 0 && (
                <p data-testid="events-count-weekday" className="text-amber-800 dark:text-amber-300">
                  日付と曜日が合わない行：{summary.weekdayMismatchRows}件（要確認）
                </p>
              )}
              {summary.duplicateDates > 0 && (
                <p data-testid="events-count-duplicate" className="text-amber-800 dark:text-amber-300">
                  同じ日付の予定が複数ある日：{summary.duplicateDates}日（要確認）
                </p>
              )}
            </div>
          )}

          {value.result && value.result.warnings.length > 0 && (
            <div data-testid="events-warnings" className="flex flex-col gap-1 text-xs">
              <p className="font-medium text-neutral-700 dark:text-neutral-200">ご確認ください（読み込みはそのまま行います）</p>
              <p className="text-neutral-500 dark:text-neutral-400">
                次の内容は、予定を削除・統合・修正せず、読み込んだままカレンダーに使います。意図したものであれば、そのままで大丈夫です。
              </p>
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950">
                {value.result.warnings.slice(0, MAX_ISSUE_ROWS_SHOWN).map((warning) => (
                  <li
                    key={`${warning.kind}-${warning.date}-${warning.rows[0]}`}
                    data-testid="events-warning"
                    data-kind={warning.kind}
                    className="break-all text-amber-900 dark:text-amber-100"
                  >
                    <span className="font-medium">{warning.kind === "weekday-mismatch" ? "曜日の不一致" : "同じ日付が複数"}</span>
                    ：{warning.message}
                    <span className="block font-mono text-amber-800 dark:text-amber-300">
                      対象: {warning.rows.slice(0, 10).join("・")}
                      行目{warning.rows.length > 10 ? ` ほか${warning.rows.length - 10}行` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {value.result.warnings.length > MAX_ISSUE_ROWS_SHOWN && (
                <p className="text-neutral-500 dark:text-neutral-400">ほか{value.result.warnings.length - MAX_ISSUE_ROWS_SHOWN}件</p>
              )}
            </div>
          )}

          {value.result && value.result.issues.length > 0 && (
            <div data-testid="events-issues" className="flex flex-col gap-1 text-xs">
              <p className="font-medium text-neutral-700 dark:text-neutral-200">確認が必要な行</p>
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-950">
                {value.result.issues.slice(0, MAX_ISSUE_ROWS_SHOWN).map((issue) => (
                  <li key={`${issue.row}-${issue.kind}`} data-testid="events-issue" data-kind={issue.kind} className="break-all">
                    <span className="font-mono">{issue.row}行目</span>：{issue.message}
                    {issue.raw && <span className="text-neutral-500 dark:text-neutral-400">（{issue.raw}）</span>}
                  </li>
                ))}
              </ul>
              {value.result.issues.length > MAX_ISSUE_ROWS_SHOWN && (
                <p className="text-neutral-500 dark:text-neutral-400">ほか{value.result.issues.length - MAX_ISSUE_ROWS_SHOWN}行</p>
              )}
            </div>
          )}

          <details open={!value.detected} data-testid="events-mapping" className="text-xs">
            <summary className="cursor-pointer text-neutral-700 dark:text-neutral-200">列の割り当てを確認・変更する</summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-neutral-600 dark:text-neutral-300">見出しの行</span>
                <select
                  data-testid="events-header-row"
                  value={value.headerRow}
                  onChange={(e) => update({ headerRow: Number(e.target.value) })}
                  className={selectClass}
                >
                  <option value={-1}>見出しなし（1行目から予定）</option>
                  {Array.from({ length: Math.min(10, rows.length) }, (_, i) => (
                    <option key={i} value={i}>
                      {i + 1}行目
                    </option>
                  ))}
                </select>
              </label>
              {COLUMN_ROLES.map((role: ColumnRole) => (
                <label key={role} className="flex flex-col gap-1">
                  <span className="text-neutral-600 dark:text-neutral-300">
                    {COLUMN_ROLE_LABELS[role]}の列{role === "date" || role === "title" ? "（必須）" : ""}
                  </span>
                  <select
                    data-testid={`events-col-${role}`}
                    value={value.mapping[role] ?? ""}
                    onChange={(e) => update({ mapping: { ...value.mapping, [role]: e.target.value === "" ? null : Number(e.target.value) } })}
                    className={selectClass}
                  >
                    <option value="">{role === "date" || role === "title" ? "（選んでください）" : "（使わない）"}</option>
                    {labels.map((label, c) => (
                      <option key={c} value={c}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </details>
        </div>
      )}
    </fieldset>
  );
}
