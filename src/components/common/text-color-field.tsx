"use client";

import { useId } from "react";

/** よく使う文字の色（押すだけで選べる見本）。それ以外の色は、右の色の選択欄で選ぶ */
export const TEXT_COLOR_SWATCHES: { value: string; label: string }[] = [
  { value: "#ffffff", label: "白" },
  { value: "#111111", label: "黒" },
  { value: "#e53935", label: "赤" },
  { value: "#1e88e5", label: "青" },
  { value: "#fdd835", label: "黄" },
  { value: "#43a047", label: "緑" },
];

/**
 * 文字の色を選ぶ欄（画像の文字入れなど）。よく使う色の見本と、自由に選べる色の選択欄を並べる。
 * 選んだ色は、親のプレビューにすぐ反映される（onChange）。
 */
export function TextColorField({
  label = "文字の色",
  value,
  onChange,
  testId,
}: {
  label?: string;
  value: string;
  onChange: (color: string) => void;
  testId?: string;
}) {
  const inputId = useId();
  const current = value.toLowerCase();
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{label}</p>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
        {TEXT_COLOR_SWATCHES.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-label={`${label}：${s.label}`}
            aria-pressed={current === s.value}
            title={s.label}
            onClick={() => onChange(s.value)}
            data-testid={testId ? `${testId}-${s.label}` : undefined}
            className={`h-9 w-9 rounded-full border border-neutral-300 shadow-sm transition-transform hover:scale-105 dark:border-neutral-600 ${
              current === s.value ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900" : ""
            }`}
            style={{ backgroundColor: s.value }}
          />
        ))}
        <label htmlFor={inputId} className="flex items-center gap-2 text-xs text-ms-muted">
          <input
            id={inputId}
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${label}をほかの色から選ぶ`}
            data-testid={testId ? `${testId}-picker` : undefined}
            className="h-9 w-12 cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-600"
          />
          ほかの色
        </label>
        <span className="font-mono text-xs text-ms-muted" data-testid={testId ? `${testId}-value` : undefined}>
          {value.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
