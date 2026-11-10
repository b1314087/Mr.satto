"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * セグメントボタン（UI・UX改善）。選択肢が少ない（2〜5個ほど）の「1つを選ぶ」操作に使う。
 * 選択肢が多いもの（月・用紙・列の対応付けなど）は、プルダウン（select）のままにする。
 *
 * - 見た目は src/app/globals.css の .ms-seg（ガラスの溝の上に、選んだものだけ青いつまみ）。
 * - 中身はラジオボタンのまとまり（role="radiogroup" / role="radio"）。← → ↑ ↓ キーで選び直せる。
 * - 画面が狭いときは折り返す（はみ出さない）。wide を付けると横幅いっぱいに均等に並べる。
 * - 色を選ぶときは swatch に色を渡すと、文字の前に色の丸が出る。
 * - testId を渡すと、各ボタンには「testId-値」の識別子が付く（自動テスト用）。
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** 押せない選択肢（元の値より大きい解像度など） */
  disabled?: boolean;
  /** 補足（カーソルを乗せたときに出る） */
  title?: string;
  /** 色の丸（色を選ぶ選択肢） */
  swatch?: string;
  testId?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  ariaLabel,
  testId,
  disabled = false,
  wide = false,
  size = "md",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** 上に出す見出し。出さないときは ariaLabel で名前を付ける */
  label?: ReactNode;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  wide?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const labelId = useId();
  const groupRef = useRef<HTMLDivElement>(null);

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const enabled = options.map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled);
    if (enabled.length === 0) return;
    const at = enabled.findIndex(({ i }) => i === index);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(next.o.value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next.i]?.focus();
  };

  const group = (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-labelledby={label ? labelId : undefined}
      aria-label={label ? undefined : ariaLabel}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      className={cn("ms-seg", wide && "ms-seg-wide", size === "sm" && "ms-seg-sm", !label && className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!options.some((x) => x.value === value) && i === 0) ? 0 : -1}
            disabled={disabled || o.disabled}
            title={o.title}
            data-testid={o.testId ?? (testId ? `${testId}-${o.value}` : undefined)}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
          >
            {o.swatch && <span aria-hidden="true" className="ms-seg-swatch" style={{ background: o.swatch }} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );

  if (!label) return group;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span id={labelId} className="text-sm font-medium text-ms-text">
        {label}
      </span>
      {group}
    </div>
  );
}
