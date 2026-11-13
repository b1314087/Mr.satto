"use client";

/**
 * 表示倍率（拡大・縮小）のバー（2026-11：ツールの拡大・縮小は、すべてバーでもできるようにした）。
 * ボタン（－・＋・決まった倍率）の横に置いて使う。値は%（100 = 等倍）。
 */
export function ZoomSlider({
  value,
  min,
  max,
  step = 5,
  onChange,
  testId,
  label = "表示倍率",
  className = "",
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (percent: number) => void;
  testId?: string;
  label?: string;
  className?: string;
}) {
  return (
    <label className={`flex min-w-32 items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300 ${className}`}>
      <span className="sr-only">{label}</span>
      <input
        type="range"
        aria-label={`${label}のバー`}
        aria-valuetext={`${Math.round(value)}%`}
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={testId}
        className="w-full min-w-24 flex-1"
      />
    </label>
  );
}
