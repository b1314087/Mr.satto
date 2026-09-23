"use client";

import { useEffect, useRef, useState } from "react";

const MODES = {
  focus: { label: "集中", minutes: 25 },
  shortBreak: { label: "小休憩", minutes: 5 },
  longBreak: { label: "長休憩", minutes: 15 },
} as const;

type ModeKey = keyof typeof MODES;

export function PomodoroTimerTool() {
  const [mode, setMode] = useState<ModeKey>("focus");
  const [secondsLeft, setSecondsLeft] = useState(MODES.focus.minutes * 60);
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
    setSecondsLeft(MODES[next].minutes * 60);
  }

  function reset() {
    setRunning(false);
    setSecondsLeft(MODES[mode].minutes * 60);
  }

  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  const total = MODES[mode].minutes * 60;
  const progress = total === 0 ? 0 : ((total - secondsLeft) / total) * 100;

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex gap-2">
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
            {MODES[key].label} ({MODES[key].minutes}分)
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
        <span className="text-5xl font-bold tabular-nums text-neutral-800 dark:text-neutral-100">
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

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        完了した集中セッション: {completedRounds}回
      </p>
    </div>
  );
}
