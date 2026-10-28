"use client";

import { useMemo, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  FISCAL_YEAR_UI_MAX,
  FISCAL_YEAR_UI_MIN,
  FiscalCalendarProcessor,
  buildFiscalCalendarFileName,
  validateFiscalCalendarInput,
  type FiscalCalendarFormat,
  type FiscalCalendarInput,
  type FiscalCalendarOrientation,
} from "@/lib/processors/browser/fiscal-calendar";
import { buildFiscalCalendar, monthNote, fiscalYearEraLabel, type WeekStart } from "@/lib/calendar/model";
import { placeEvents } from "@/lib/calendar/events";
import { groupButtonLabel, groupMonths, sheetArrangement, type MonthsPerSheet } from "@/lib/calendar/layout";
import {
  CALENDAR_CUSTOM_DEFAULT,
  CALENDAR_THEME_CHOICES,
  resolveCalendarTheme,
  themeSwatchColors,
  type CalendarCustomPalette,
  type CalendarThemeChoice,
} from "@/lib/calendar/themes";
import { FiscalCalendarCustomColors } from "./shared/fiscal-calendar-custom-colors";
import { FiscalCalendarEventsImport, type EventImportState } from "./shared/fiscal-calendar-events-import";
import { CONFIRMED_THROUGH_YEAR, HOLIDAY_DATA_CHECKED_AT, HOLIDAY_DATA_SOURCES } from "@/lib/calendar/holiday-data";
import { downloadBlob } from "@/lib/utils/format";
import { FiscalCalendarPreview } from "./shared/fiscal-calendar-preview";

const YEARS = Array.from({ length: FISCAL_YEAR_UI_MAX - FISCAL_YEAR_UI_MIN + 1 }, (_, i) => FISCAL_YEAR_UI_MIN + i);

/** 今日が属する年度（4月始まり）。画面を開いた端末の日付で決める */
function currentFiscalYear(): number {
  const now = new Date();
  const fy = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return Math.min(FISCAL_YEAR_UI_MAX, Math.max(FISCAL_YEAR_UI_MIN, fy));
}

const optionButtonClass = (active: boolean) =>
  `rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
    active
      ? "border-blue-600 bg-blue-600 text-white"
      : "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
  }`;

export function FiscalCalendarTool() {
  // 初期値は今日が属する年度（日付・曜日ツールが今日の日付を初期値にしているのと同じ方式）
  const [fiscalYear, setFiscalYear] = useState(currentFiscalYear);
  const [weekStart, setWeekStart] = useState<WeekStart>("mon");
  const [theme, setTheme] = useState<CalendarThemeChoice>("business");
  // カスタムの4色。プリセットを選んでいる間も保持するが、プリセットの配色には一切混ざらない（resolveCalendarTheme 参照）
  const [customPalette, setCustomPalette] = useState<CalendarCustomPalette>({ ...CALENDAR_CUSTOM_DEFAULT });
  const [orientation, setOrientation] = useState<FiscalCalendarOrientation>("landscape");
  const [showAdjacentDays, setShowAdjacentDays] = useState(false);
  const [monthsPerSheet, setMonthsPerSheet] = useState<MonthsPerSheet>(1);
  // Excelの予定表から読み込んだ予定（この端末の中だけで保持。年度を変えても、新しい年度の範囲で振り分け直す）
  const [eventImport, setEventImport] = useState<EventImportState | null>(null);
  const [previewMonth, setPreviewMonth] = useState(0);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [excelResult, setExcelResult] = useState<Blob | null>(null);
  const [pdfResult, setPdfResult] = useState<Blob | null>(null);

  const calendar = useMemo(() => buildFiscalCalendar({ fiscalYear, weekStart }), [fiscalYear, weekStart]);
  // プレビュー・Excel・PDFで共通に使う、解決済みのテーマ
  const themeDef = useMemo(() => resolveCalendarTheme(theme, customPalette), [theme, customPalette]);
  // 2か月の並べ方（横向きは左右、縦向きは上下）。プレビュー・Excel・PDFで同じ並べ方にする
  const arrangement = sheetArrangement(orientation, monthsPerSheet);
  const groups = useMemo(() => groupMonths(calendar, monthsPerSheet), [calendar, monthsPerSheet]);
  const previewGroup = groups[Math.floor(previewMonth / monthsPerSheet)] ?? groups[0];
  // プレビュー・Excel・PDFが同じ予定（共通の予定モデルを年度の範囲で振り分けたもの）を使う
  // 通常の読み取り結果 + 利用者がAIの提案から採用した予定
  const readEvents = eventImport?.result?.events;
  const aiEvents = eventImport?.aiEvents;
  const importedEvents = useMemo(
    () => (readEvents ? (aiEvents && aiEvents.length > 0 ? [...readEvents, ...aiEvents] : readEvents) : undefined),
    [readEvents, aiEvents],
  );
  const placed = useMemo(() => placeEvents(calendar, importedEvents ?? []), [calendar, importedEvents]);

  function resetResults() {
    setExcelResult(null);
    setPdfResult(null);
    setStatus("idle");
    setError(null);
  }

  function baseInput(format: FiscalCalendarFormat): FiscalCalendarInput {
    return {
      fiscalYear,
      weekStart,
      theme,
      customPalette: theme === "custom" ? customPalette : undefined,
      orientation,
      showAdjacentDays,
      monthsPerSheet,
      events: importedEvents,
      format,
    };
  }

  async function handleGenerate(format: FiscalCalendarFormat) {
    const input = baseInput(format);
    const validationError = validateFiscalCalendarInput(input);
    if (validationError) {
      setError(validationError);
      setStatus("error");
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await new FiscalCalendarProcessor().process(input);
      if (format === "excel") setExcelResult(output.blob);
      else setPdfResult(output.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const lastYear = calendar.months[11].year;
  const lastConfirmed = lastYear <= CONFIRMED_THROUGH_YEAR;

  return (
    <div className="flex flex-col gap-6">
      <PreviewSplitLayout
        previewWidth="lg"
        preview={
          <div data-testid="tool-preview" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-sm font-medium">プレビュー</p>
            <div className="flex flex-wrap gap-1" role="group" aria-label="プレビューする月">
              {groups.map((g, i) => {
                const index = i * monthsPerSheet;
                const active = Math.floor(previewMonth / monthsPerSheet) === i;
                return (
                  <button
                    key={`${g[0].year}-${g[0].month}`}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setPreviewMonth(index)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      active
                        ? "bg-blue-600 text-white"
                        : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
                    }`}
                  >
                    {groupButtonLabel(g)}
                  </button>
                );
              })}
            </div>
            <div
              data-testid="calendar-preview-sheet"
              data-months-per-sheet={monthsPerSheet}
              data-arrangement={arrangement}
              data-orientation={orientation}
              className={
                arrangement === "stacked"
                  ? "mx-auto flex w-full max-w-md flex-col gap-3"
                  : arrangement === "side-by-side"
                    ? "grid grid-cols-1 gap-3 sm:grid-cols-2"
                    : ""
              }
            >
              {previewGroup.map((m) => (
                <FiscalCalendarPreview
                  key={`${m.year}-${m.month}`}
                  calendar={calendar}
                  month={m}
                  theme={themeDef}
                  landscape={orientation === "landscape"}
                  showAdjacentDays={showAdjacentDays}
                  events={placed.byDate}
                  pair={monthsPerSheet === 2}
                  stacked={arrangement === "stacked"}
                />
              ))}
            </div>
            {previewGroup.map(
              (m) =>
                monthNote(m) && (
                  <p key={`${m.year}-${m.month}-note`} className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="calendar-estimated-note">
                    {monthsPerSheet === 2 ? `${m.month}月: ` : ""}
                    {monthNote(m)}
                  </p>
                ),
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium">カレンダーの設定</p>

          <label className="flex flex-col gap-1 text-sm sm:w-1/2">
            <span className="text-neutral-600 dark:text-neutral-300">年度（4月〜翌年3月）</span>
            <select
              aria-label="年度"
              value={fiscalYear}
              onChange={(e) => {
                setFiscalYear(Number(e.target.value));
                setPreviewMonth(0);
                resetResults();
              }}
              className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}年度（{fiscalYearEraLabel(y)}）　{y}年4月〜{y + 1}年3月
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-300">週の始まり</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["mon", "月曜日始まり"],
                  ["sun", "日曜日始まり"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={weekStart === id}
                  onClick={() => {
                    setWeekStart(id);
                    resetResults();
                  }}
                  className={optionButtonClass(weekStart === id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-300">デザイン</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CALENDAR_THEME_CHOICES.map((id) => {
                const t = resolveCalendarTheme(id, customPalette);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={theme === id}
                    data-testid={`theme-${id}`}
                    onClick={() => {
                      setTheme(id);
                      resetResults();
                    }}
                    className={`flex flex-col gap-1.5 rounded-lg border p-3 text-left ${
                      theme === id ? "border-blue-600 ring-2 ring-blue-600" : "border-neutral-300 dark:border-neutral-700"
                    }`}
                  >
                    <span className="flex gap-1" aria-hidden="true">
                      {themeSwatchColors(t).map((c, i) => (
                        <span key={i} data-testid={`theme-${id}-swatch`} className="h-4 w-6 rounded border border-neutral-400" style={{ background: c }} />
                      ))}
                    </span>
                    <span className="font-medium">{t.label}</span>
                  </button>
                );
              })}
            </div>
            {theme === "custom" && (
              <FiscalCalendarCustomColors
                palette={customPalette}
                theme={themeDef}
                onChange={(role, color) => {
                  setCustomPalette((p) => ({ ...p, [role]: color }));
                  resetResults();
                }}
                onReset={() => {
                  setCustomPalette({ ...CALENDAR_CUSTOM_DEFAULT });
                  resetResults();
                }}
              />
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-300">カレンダー形式</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  [1, "1か月 / 1シート"],
                  [2, "2か月 / 1シート"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  data-testid={`months-per-sheet-${id}`}
                  aria-pressed={monthsPerSheet === id}
                  onClick={() => {
                    setMonthsPerSheet(id);
                    resetResults();
                  }}
                  className={optionButtonClass(monthsPerSheet === id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {arrangement === "stacked"
                ? "4月+5月・6月+7月…のように、2か月を上下（上が前の月、下が次の月）に並べて6シート（PDFは6ページ）にします。A4縦向きで作成します。"
                : arrangement === "side-by-side"
                  ? "4月+5月・6月+7月…のように、2か月を左右（左が前の月、右が次の月）に並べて6シート（PDFは6ページ）にします。A4横向きで作成します。"
                  : "1か月を1シート（PDFは1ページ）にして、12シート（12ページ）にします。"}
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-neutral-600 dark:text-neutral-300">用紙（A4）の向き</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["landscape", "横向き"],
                  ["portrait", "縦向き"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={orientation === id}
                  onClick={() => {
                    setOrientation(id);
                    resetResults();
                  }}
                  className={optionButtonClass(orientation === id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {monthsPerSheet === 2 && (
              <p data-testid="orientation-arrangement" className="text-xs text-neutral-500 dark:text-neutral-400">
                {arrangement === "stacked"
                  ? "2か月表示・縦向き: 上に前の月、下に次の月を並べます。"
                  : "2か月表示・横向き: 左に前の月、右に次の月を並べます。"}
              </p>
            )}
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAdjacentDays}
              onChange={(e) => {
                setShowAdjacentDays(e.target.checked);
                resetResults();
              }}
            />
            <span>前後の月の日付も薄く表示する（初期は空欄）</span>
          </label>
        </div>

        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <FiscalCalendarEventsImport
            calendar={calendar}
            value={eventImport}
            onChange={(next) => {
              setEventImport(next);
              resetResults();
            }}
          />
        </div>

        {!lastConfirmed && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {fiscalYear}年度には、確定していない祝日が含まれます。「※」の日は、暦要項の公示前の推定です。「※」のない祝日も、現行の祝日法にもとづく日付で、法改正で変わることがあります。
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => handleGenerate("excel")}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {monthsPerSheet === 2 ? "Excelを作成（2か月ずつ6シート）" : "Excelを作成（月別12シート）"}
          </button>
          <button
            type="button"
            onClick={() => handleGenerate("pdf")}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-neutral-800 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
          >
            {monthsPerSheet === 2 ? "PDFを作成（2か月ずつ6ページ）" : "PDFを作成（月別12ページ）"}
          </button>
        </div>

        <ProcessingStatus state={status} successLabel="作成しました" />
        {error && <ErrorMessage message={error} />}

        {(excelResult || pdfResult) && (
          <ResultPopup>
            {excelResult && (
              <RewardedDownloadGate
                onDownload={() => downloadBlob(excelResult, buildFiscalCalendarFileName(baseInput("excel")))}
                label="Excelファイルをダウンロード"
              />
            )}
            {pdfResult && (
              <RewardedDownloadGate
                onDownload={() => downloadBlob(pdfResult, buildFiscalCalendarFileName(baseInput("pdf")))}
                label="PDFファイルをダウンロード"
              />
            )}
          </ResultPopup>
        )}

        <div className="rounded-lg bg-neutral-50 p-3 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
          <p>
            祝日は、祝日法に基づく計算で求めています。{CONFIRMED_THROUGH_YEAR}年までは国立天文台の暦要項で公示済みの日付で、確認日は
            {HOLIDAY_DATA_CHECKED_AT}です。それより先は、春分の日・秋分の日が推定（「※」付き）で、そのほかの祝日は現行の祝日法による日付です。
          </p>
          <p className="mt-1">
            出典:
            {HOLIDAY_DATA_SOURCES.map((s, i) => (
              <span key={s.url}>
                {i > 0 ? "、" : " "}
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                  {s.label}
                </a>
              </span>
            ))}
          </p>
        </div>
      </PreviewSplitLayout>
    </div>
  );
}
