"use client";

import { useId } from "react";

/**
 * バー(スライダー)と数値入力を並べて、どちらからでも値を変えられる入力部品。
 *
 * 数値入力は、入力途中(空欄・範囲外)の値は親へ渡さず、確定(フォーカスを外す)時に
 * 範囲内へ丸めて渡す。スライダーを動かすと即座に親へ値が渡る(リアルタイムプレビュー用)。
 */
export function SliderField({
  label,
  value,
  min,
  max,
  inputMax,
  step = 1,
  unit,
  onChange,
  onReset,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** 数値入力だけで指定できる上限(バーの上限より大きくしたいとき)。省略時はmax */
  inputMax?: number;
  step?: number;
  /** 数値の横に表示する単位(例: "px"、"%") */
  unit?: string;
  onChange: (value: number) => void;
  /** 指定するとリセットボタンを表示する */
  onReset?: () => void;
  hint?: string;
}) {
  const id = useId();

  function commit(raw: string) {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    onChange(Math.min(inputMax ?? max, Math.max(min, Math.round(n / step) * step)));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {label}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            key={value /* 外部(スライダー等)からの変更を数値欄へ反映する */}
            type="number"
            inputMode="numeric"
            aria-label={`${label}の数値`}
            min={min}
            max={inputMax ?? max}
            step={step}
            defaultValue={value}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
            }}
            className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-1 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
          {unit && <span className="text-xs text-neutral-500 dark:text-neutral-400">{unit}</span>}
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              リセット
            </button>
          )}
        </div>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
      {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
    </div>
  );
}
