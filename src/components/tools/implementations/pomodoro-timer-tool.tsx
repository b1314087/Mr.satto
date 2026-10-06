"use client";

import { useEffect, useRef, useState } from "react";

const MODES = {
  focus: { label: "集中", defaultMinutes: 25 },
  shortBreak: { label: "小休憩", defaultMinutes: 5 },
  longBreak: { label: "長休憩", defaultMinutes: 15 },
} as const;

type ModeKey = keyof typeof MODES;

const MIN_MINUTES = 1;
const MAX_MINUTES = 180;

type Durations = Record<ModeKey, number>;

const DEFAULT_DURATIONS: Durations = {
  focus: MODES.focus.defaultMinutes,
  shortBreak: MODES.shortBreak.defaultMinutes,
  longBreak: MODES.longBreak.defaultMinutes,
};

/**
 * ポモドーロタイマー。集中・小休憩・長休憩それぞれの長さ(分)を自由に決められる。
 * 時間の変更はタイマーが止まっているときだけでき、変更すると今のモードの残り時間も新しい長さに合わせ直す。
 */
export function PomodoroTimerTool() {
  const [durations, setDurations] = useState<Durations>(DEFAULT_DURATIONS);
  const [mode, setMode] = useState<ModeKey>("focus");
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_DURATIONS.focus * 60);
  const [running, setRunning] = useState(false);
  const [completedRounds, setCompletedRounds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setRunning(false);
          setCompletedRounds((r) => r + (mode === "focus" ? 1 : 0));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  function switchMode(next: ModeKey) {
    setMode(next);
    setRunning(false);
    setSecondsLeft(durations[next] * 60);
  }

  function reset() {
    setRunning(false);
    setSecondsLeft(durations[mode] * 60);
  }

  function changeDuration(key: ModeKey, raw: number) {
    if (!Number.isFinite(raw)) return;
    const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(raw)));
    setDurations((d) => ({ ...d, [key]: minutes }));
    if (key === mode) setSecondsLeft(minutes * 60);
  }

  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  const total = durations[mode] * 60;
  const progress = total === 0 ? 0 : ((total - secondsLeft) / total) * 100;

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-wrap justify-center gap-2">
        {(Object.keys(MODES) as ModeKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => switchMode(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              mode === key
                ? "bg-blue-600 text-white"
                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            {MODES[key].label} ({durations[key]}分)
          </button>
        ))}
      </div>

      <div className="relative flex h-56 w-56 items-center justify-center rounded-full border-8 border-neutral-100 dark:border-neutral-800">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `conic-gradient(#2563eb ${progress}%, transparent ${progress}%)`,
            mask: "radial-gradient(farthest-side, transparent calc(100% - 8px), #000 calc(100% - 8px))",
            WebkitMask:
              "radial-gradient(farthest-side, transparent calc(100% - 8px), #000 calc(100% - 8px))",
          }}
        />
        <span
          data-testid="pomodoro-time"
          className="text-5xl font-bold tabular-nums text-neutral-800 dark:text-neutral-100"
        >
          {minutes}:{seconds}
        </span>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setRunning((r) => !r)}
          className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
        >
          {running ? "一時停止" : "スタート"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-neutral-100 px-6 py-2.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
        >
          リセット
        </button>
      </div>

      <fieldset
        disabled={running}
        className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-neutral-200 p-4 disabled:opacity-60 dark:border-neutral-800"
      >
        <legend className="px-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          時間を決める（{MIN_MINUTES}〜{MAX_MINUTES}分）
        </legend>
        <div className="grid grid-cols-3 gap-3">
          {(Object.keys(MODES) as ModeKey[]).map((key) => (
            <label key={key} className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600 dark:text-neutral-300">{MODES[key].label}（分）</span>
              <input
                key={`${key}-${durations[key]}`}
                type="number"
                inputMode="numeric"
                aria-label={`${MODES[key].label}の時間（分）`}
                min={MIN_MINUTES}
                max={MAX_MINUTES}
                step={1}
                defaultValue={durations[key]}
                onBlur={(e) => changeDuration(key, e.target.valueAsNumber)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") changeDuration(key, (e.target as HTMLInputElement).valueAsNumber);
                }}
                className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          ))}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {running ? "動いている間は時間を変えられません。一時停止してから変更してください。" : "入力して Enter または枠の外をクリックすると反映されます。"}
        </p>
      </fieldset>

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        完了した集中セッション: {completedRounds}回
      </p>
    </div>
  );
}
