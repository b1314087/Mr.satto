"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

const OPTIONS = [
  { value: "light", label: "ライト", icon: "☀️" },
  { value: "dark", label: "ダーク", icon: "🌙" },
  { value: "system", label: "システム", icon: "🖥️" },
] as const;

/** OSのダークモード設定にも対応する（22章） */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // ハイドレーション不一致を避けるためのマウント検知（next-themes推奨パターン）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-9 w-[124px] rounded-lg bg-neutral-100 dark:bg-neutral-800" />;
  }

  return (
    <div
      role="radiogroup"
      aria-label="テーマ切り替え"
      className="flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-neutral-700 dark:bg-neutral-900"
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={theme === opt.value}
          title={opt.label}
          onClick={() => setTheme(opt.value)}
          className={`flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors ${
            theme === opt.value
              ? "bg-white shadow-sm dark:bg-neutral-700"
              : "text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          }`}
        >
          <span aria-hidden="true">{opt.icon}</span>
          <span className="sr-only">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
