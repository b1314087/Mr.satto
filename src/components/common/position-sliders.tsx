"use client";

import { SliderField } from "@/components/common/slider-field";
import { cn } from "@/lib/utils/cn";

/**
 * 位置の調整（X軸・Y軸のスライダー。総合改修 3-3）。
 *
 * - 横（X）と縦（Y）をそれぞれ独立して動かせる。バーを動かすとすぐ親へ値が渡る（リアルタイムプレビュー用）。
 * - 今の値は数値でも見え、数値を入れて指定することもできる（SliderField）。
 * - 2つを並べると狭い列ではつぶれるので、既定は縦に積む。広い場所では stackOn="never" で横並びにできる。
 * - 値の単位は呼び出し側で決める（既定は 0〜100%）。
 */
export function PositionSliders({
  x,
  y,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  unit = "%",
  xLabel = "横の位置（X）",
  yLabel = "縦の位置（Y）",
  xAriaLabel,
  yAriaLabel,
  hint,
  layout = "stack",
  testId,
  className,
}: {
  x: number;
  y: number;
  onChange: (pos: { x: number; y: number }) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  xLabel?: string;
  yLabel?: string;
  xAriaLabel?: string;
  yAriaLabel?: string;
  hint?: string;
  /** stack: 常に縦に積む / auto: 画面が広いときだけ横に並べる */
  layout?: "stack" | "auto";
  testId?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-testid={testId}>
      <div className={cn("grid grid-cols-1 gap-4", layout === "auto" && "sm:grid-cols-2")}>
        <SliderField
          label={xLabel}
          ariaLabel={xAriaLabel}
          value={x}
          min={min}
          max={max}
          step={step}
          unit={unit}
          onChange={(nx) => onChange({ x: nx, y })}
        />
        <SliderField
          label={yLabel}
          ariaLabel={yAriaLabel}
          value={y}
          min={min}
          max={max}
          step={step}
          unit={unit}
          onChange={(ny) => onChange({ x, y: ny })}
        />
      </div>
      {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
    </div>
  );
}
