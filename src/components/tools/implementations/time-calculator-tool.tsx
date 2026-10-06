"use client";

import { useEffect, useState } from "react";
import { TimeToolsProcessor, type TimeToolMode } from "@/lib/processors/browser/time-tools";
import { ErrorMessage } from "@/components/common/error-message";

const TABS: { value: TimeToolMode; label: string }[] = [
  { value: "diff", label: "時間差" },
  { value: "add", label: "時刻に加算" },
  { value: "subtract", label: "時刻から減算" },
  { value: "sum", label: "複数時間の合計" },
  { value: "work", label: "実働時間（休憩差引）" },
  { value: "convert", label: "時間⇔小数変換" },
];

/** "H:MM" 形式の時間量（経過時間）の文字列を分に変換する。時刻ではないため24時を超えてもよい */
function parseDurationStr(input: string): number | null {
  const m = /^(\d{1,4}):(\d{1,2})$/.exec(input.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min < 0 || min > 59) return null;
  return h * 60 + min;
}

interface TimeParams {
  tab: TimeToolMode;
  start: string;
  end: string;
  breakMinutes: number;
  base: string;
  deltaHours: number;
  deltaMinutes: number;
  sumText: string;
  convertDirection: "toDecimal" | "toClock";
  convertHours: number;
  convertMinutes: number;
  convertDecimal: number;
}

interface TimeView {
  durationLabel?: string | null;
  decimalHours?: number | null;
  resultTime?: string | null;
  convertResult?: string | null;
}

async function computeTimeView(p: TimeParams): Promise<{ result: TimeView | null; error: string | null }> {
  try {
    const processor = new TimeToolsProcessor();
    const { tab } = p;
    if (tab === "diff") {
      const r = await processor.process({ mode: "diff", start: p.start, end: p.end });
      return { error: null, result: { durationLabel: r.durationLabel ?? null, decimalHours: r.decimalHours ?? null } };
    }
    if (tab === "add" || tab === "subtract") {
      const r = await processor.process({ mode: tab, base: p.base, deltaMinutes: p.deltaHours * 60 + p.deltaMinutes });
      return { error: null, result: { resultTime: r.resultTime ?? null } };
    }
    if (tab === "sum") {
      const lines = p.sumText.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
      const durations: number[] = [];
      for (const line of lines) {
        const mins = parseDurationStr(line);
        if (mins === null) {
          throw new Error(`「${line}」を時間として読み取れませんでした（例: 2:30）`);
        }
        durations.push(mins);
      }
      const r = await processor.process({ mode: "sum", durationsMinutes: durations });
      return { error: null, result: { durationLabel: r.durationLabel ?? null, decimalHours: r.decimalHours ?? null } };
    }
    if (tab === "work") {
      const r = await processor.process({ mode: "work", start: p.start, end: p.end, breakMinutes: p.breakMinutes });
      return { error: null, result: { durationLabel: r.durationLabel ?? null, decimalHours: r.decimalHours ?? null } };
    }
    if (p.convertDirection === "toDecimal") {
      const r = await processor.process({ mode: "convert", hours: p.convertHours, minutes: p.convertMinutes });
      return { error: null, result: { convertResult: `${r.decimalHours}時間` } };
    }
    const r = await processor.process({ mode: "convert", decimalHours: p.convertDecimal });
    return { error: null, result: { convertResult: r.durationLabel ?? null } };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : "計算に失敗しました" };
  }
}

export function TimeCalculatorTool() {
  const [tab, setTab] = useState<TimeToolMode>("diff");

  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:30");
  const [breakMinutes, setBreakMinutes] = useState(60);
  const [base, setBase] = useState("09:00");
  const [deltaHours, setDeltaHours] = useState(1);
  const [deltaMinutes, setDeltaMinutes] = useState(0);
  const [sumText, setSumText] = useState("2:30\n1:45");
  const [convertDirection, setConvertDirection] = useState<"toDecimal" | "toClock">("toDecimal");
  const [convertHours, setConvertHours] = useState(7);
  const [convertMinutes, setConvertMinutes] = useState(30);
  const [convertDecimal, setConvertDecimal] = useState(7.5);

  const [live, setLive] = useState<{ key: string; result: TimeView | null; error: string | null } | null>(null);

  // 入力・タブを変えるたびに、その場で結果を再計算して表示する（プレビュー）。
  // 「計算する」ボタンも同じ computeTimeView を使う。
  const params: TimeParams = {
    tab, start, end, breakMinutes, base, deltaHours, deltaMinutes, sumText,
    convertDirection, convertHours, convertMinutes, convertDecimal,
  };
  const liveKey = JSON.stringify(params);
  useEffect(() => {
    let cancelled = false;
    computeTimeView({
      tab, start, end, breakMinutes, base, deltaHours, deltaMinutes, sumText,
      convertDirection, convertHours, convertMinutes, convertDecimal,
    }).then((r) => {
      if (!cancelled) setLive({ key: liveKey, ...r });
    });
    return () => {
      cancelled = true;
    };
  }, [
    liveKey, tab, start, end, breakMinutes, base, deltaHours, deltaMinutes, sumText,
    convertDirection, convertHours, convertMinutes, convertDecimal,
  ]);

  const view = live && live.key === liveKey ? live : null;
  const error = view?.error ?? null;
  const durationLabel = view?.result?.durationLabel ?? null;
  const decimalHours = view?.result?.decimalHours ?? null;
  const resultTime = view?.result?.resultTime ?? null;
  const convertResult = view?.result?.convertResult ?? null;

  async function handleRun() {
    const r = await computeTimeView(params);
    setLive({ key: liveKey, ...r });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => {
              setTab(t.value);
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

      {(tab === "diff" || tab === "work") && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            開始時刻
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            終了時刻
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          {tab === "work" && (
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              休憩時間（分）
              <input
                type="number"
                min={0}
                value={breakMinutes}
                onChange={(e) => setBreakMinutes(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}
        </div>
      )}

      {(tab === "add" || tab === "subtract") && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            基準時刻
            <input
              type="time"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            {tab === "add" ? "加算する時間" : "減算する時間"}（時）
            <input
              type="number"
              min={0}
              value={deltaHours}
              onChange={(e) => setDeltaHours(Number(e.target.value))}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            （分）
            <input
              type="number"
              min={0}
              max={59}
              value={deltaMinutes}
              onChange={(e) => setDeltaMinutes(Number(e.target.value))}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>
      )}

      {tab === "sum" && (
        <label className="flex flex-col gap-1.5 text-sm">
          合計する時間（1行に1つ、「H:MM」形式）
          <textarea
            value={sumText}
            onChange={(e) => setSumText(e.target.value)}
            rows={5}
            placeholder={"2:30\n1:45"}
            className="rounded-xl border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      )}

      {tab === "convert" && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConvertDirection("toDecimal")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                convertDirection === "toDecimal"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              時間・分 → 小数時間
            </button>
            <button
              type="button"
              onClick={() => setConvertDirection("toClock")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                convertDirection === "toClock"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              小数時間 → 時間・分
            </button>
          </div>
          {convertDirection === "toDecimal" ? (
            <div className="grid grid-cols-2 gap-3 sm:w-64">
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                時間
                <input
                  type="number"
                  min={0}
                  value={convertHours}
                  onChange={(e) => setConvertHours(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                分
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={convertMinutes}
                  onChange={(e) => setConvertMinutes(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400 sm:w-40">
              小数時間
              <input
                type="number"
                step={0.01}
                value={convertDecimal}
                onChange={(e) => setConvertDecimal(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}
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

      {resultTime && (
        <div
          data-testid="tool-preview"
          className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">{resultTime}</p>
        </div>
      )}

      {convertResult && (
        <div
          data-testid="tool-preview"
          className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">{convertResult}</p>
        </div>
      )}

      {durationLabel && !resultTime && !convertResult && (
        <div
          data-testid="tool-preview"
          className="flex flex-col gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">{durationLabel}</p>
          {decimalHours !== null && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">小数表記: {decimalHours}時間</p>
          )}
        </div>
      )}
    </div>
  );
}
