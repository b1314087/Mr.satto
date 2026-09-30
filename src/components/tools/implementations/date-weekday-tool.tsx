"use client";

import { useState } from "react";
import { DateToolsProcessor, dateListToCsvBlob, type DateListItem } from "@/lib/processors/browser/date-tools";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ErrorMessage } from "@/components/common/error-message";
import { downloadBlob } from "@/lib/utils/format";

type Tab = "weekday" | "shift" | "list" | "extract" | "business";

const TABS: { value: Tab; label: string }[] = [
  { value: "weekday", label: "曜日確認" },
  { value: "shift", label: "日付計算" },
  { value: "list", label: "日付一覧" },
  { value: "extract", label: "曜日抽出" },
  { value: "business", label: "営業日計算" },
];

const WEEKDAY_OPTIONS = [
  { value: 0, label: "日" },
  { value: 1, label: "月" },
  { value: 2, label: "火" },
  { value: 3, label: "水" },
  { value: 4, label: "木" },
  { value: 5, label: "金" },
  { value: 6, label: "土" },
];

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 日付・曜日ツール（次工程・軽量便利ツール一括追加 Tool 1）。
 * タブ切り替えで5つの機能（曜日確認/日付計算/日付一覧/曜日抽出/営業日計算）
 * をまとめる。内部処理は1つの DateToolsProcessor に委譲する。
 */
export function DateWeekdayTool() {
  const [tab, setTab] = useState<Tab>("weekday");
  const [baseDate, setBaseDate] = useState(todayIso());
  const [days, setDays] = useState(7);
  const [rangeEnd, setRangeEnd] = useState(todayIso());
  const [excludeWeekends, setExcludeWeekends] = useState(false);
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);

  const [error, setError] = useState<string | null>(null);
  const [resultDate, setResultDate] = useState<string | null>(null);
  const [resultWeekday, setResultWeekday] = useState<string | null>(null);
  const [monthRange, setMonthRange] = useState<{ start: string; end: string } | null>(null);
  const [list, setList] = useState<DateListItem[] | null>(null);
  const [copied, setCopied] = useState(false);

  function resetResults() {
    setError(null);
    setResultDate(null);
    setResultWeekday(null);
    setMonthRange(null);
    setList(null);
    setCopied(false);
  }

  async function handleRun() {
    resetResults();
    try {
      const processor = new DateToolsProcessor();
      if (tab === "weekday") {
        const r = await processor.process({ mode: "weekday", baseDate });
        setResultDate(r.resultDate ?? null);
        setResultWeekday(r.resultWeekday ?? null);
        if (r.monthStart && r.monthEnd) setMonthRange({ start: r.monthStart, end: r.monthEnd });
      } else if (tab === "shift") {
        const r = await processor.process({ mode: "shift", baseDate, days });
        setResultDate(r.resultDate ?? null);
        setResultWeekday(r.resultWeekday ?? null);
      } else if (tab === "business") {
        const r = await processor.process({ mode: "business-shift", baseDate, days });
        setResultDate(r.resultDate ?? null);
        setResultWeekday(r.resultWeekday ?? null);
      } else if (tab === "list") {
        const r = await processor.process({ mode: "list", baseDate, rangeEnd, excludeWeekends });
        setList(r.list ?? []);
      } else if (tab === "extract") {
        const r = await processor.process({
          mode: "list",
          baseDate,
          rangeEnd,
          weekdayFilter: selectedWeekdays,
        });
        setList(r.list ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "計算に失敗しました");
    }
  }

  async function handleCopyList() {
    if (!list || list.length === 0) return;
    const text = list.map((item) => `${item.date}（${item.weekday}）`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボード非対応環境では何もしない
    }
  }

  function handleDownloadCsv() {
    if (!list || list.length === 0) return;
    downloadBlob(dateListToCsvBlob(list), "date-list.csv");
  }

  function toggleWeekday(value: number) {
    setSelectedWeekdays((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value].sort()
    );
  }

  const showRangeEnd = tab === "list" || tab === "extract";
  const showDays = tab === "shift" || tab === "business";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => {
              setTab(t.value);
              resetResults();
            }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.value
                ? "bg-blue-600 text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
          {tab === "shift" || tab === "business" ? "基準日" : showRangeEnd ? "開始日" : "日付"}
          <input
            type="date"
            value={baseDate}
            onChange={(e) => setBaseDate(e.target.value)}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        {showRangeEnd && (
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            終了日
            <input
              type="date"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        )}

        {showDays && (
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            {tab === "business" ? "加減する営業日数（負の値で前へ）" : "加減する日数（負の値で前へ）"}
            <input
              type="number"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        )}
      </div>

      {tab === "list" && (
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={excludeWeekends}
            onChange={(e) => setExcludeWeekends(e.target.checked)}
          />
          土日を除外する
        </label>
      )}

      {tab === "extract" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">抽出する曜日を選択</p>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_OPTIONS.map((w) => (
              <button
                key={w.value}
                type="button"
                onClick={() => toggleWeekday(w.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  selectedWeekdays.includes(w.value)
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleRun}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        計算する
      </button>

      {error && <ErrorMessage message={error} />}

      {(resultDate || resultWeekday) && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
            {resultDate}
            {resultWeekday && `（${resultWeekday}）`}
          </p>
          {monthRange && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              月初: {monthRange.start} ・ 月末: {monthRange.end}
            </p>
          )}
        </div>
      )}

      {list && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{list.length}件</p>
          {list.length > 0 ? (
            <div className="max-h-72 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-left text-sm">
                <tbody>
                  {list.map((item) => (
                    <tr key={item.date} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                      <td className="px-3 py-1.5">{item.date}</td>
                      <td className="px-3 py-1.5 text-neutral-500 dark:text-neutral-400">{item.weekday}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">条件に一致する日付がありません</p>
          )}
          {list.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCopyList}
                className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
              >
                {copied ? "コピーしました" : "一覧をコピー"}
              </button>
              <RewardedDownloadGate onDownload={handleDownloadCsv} label="CSVでダウンロード" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
