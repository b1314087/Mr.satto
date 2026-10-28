"use client";

import { useState } from "react";
import {
  CALENDAR_CUSTOM_DEFAULT,
  CALENDAR_CUSTOM_ROLES,
  CALENDAR_CUSTOM_ROLE_LABELS,
  contrastRatio,
  normalizeHexColor,
  type CalendarCustomPalette,
  type CalendarCustomRole,
  type CalendarTheme,
} from "@/lib/calendar/themes";

/** 読みやすさの目安にするコントラスト比（WCAG 2.x の通常の文字の基準） */
const READABLE_RATIO = 4.5;

/**
 * カスタム配色の4色を決める部品。各色は、ブラウザ標準のカラーピッカーと、#RRGGBB の入力欄の両方で変えられる。
 * 4色は互いに独立（1色を変えても、ほかの3色は変わらない）。色の組み合わせは自由で、制限はしない。
 * 読みにくくなりそうな組み合わせは、コントラスト比の目安で知らせるだけにしている。
 */
export function FiscalCalendarCustomColors({
  palette,
  theme,
  onChange,
  onReset,
}: {
  palette: CalendarCustomPalette;
  /** 4色から決まった、プレビュー・Excel・PDFで使う配色（読みやすさの確認用） */
  theme: CalendarTheme;
  onChange: (role: CalendarCustomRole, color: string) => void;
  onReset: () => void;
}) {
  // 色コードの入力途中の文字（正しい色コードになるまで、パレットには反映しない）
  const [drafts, setDrafts] = useState<Partial<Record<CalendarCustomRole, string>>>({});

  const setDraft = (role: CalendarCustomRole, value: string | undefined) =>
    setDrafts((d) => {
      const next = { ...d };
      if (value === undefined) delete next[role];
      else next[role] = value;
      return next;
    });

  const checks: { id: string; label: string; fg: string; bg: string }[] = [
    { id: "weekday", label: "平日の日付（文字と背景）", fg: theme.dayText.weekday, bg: theme.dayBg.weekday },
    { id: "saturday", label: "土曜日の日付", fg: theme.dayText.saturday, bg: theme.dayBg.saturday },
    { id: "sunday", label: "日曜日・祝日の日付と祝日名", fg: theme.dayText.sunday, bg: theme.dayBg.sunday },
    { id: "title", label: "月の見出し帯の文字（自動で白か黒）", fg: theme.titleText, bg: theme.titleBg },
  ];

  return (
    <div
      data-testid="custom-colors"
      className="flex flex-col gap-3 rounded-lg border border-neutral-300 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CALENDAR_CUSTOM_ROLES.map((role) => {
          const { label } = CALENDAR_CUSTOM_ROLE_LABELS[role];
          const draft = drafts[role];
          const invalid = draft !== undefined && normalizeHexColor(draft) === null;
          return (
            <div key={role} className="flex flex-col gap-1">
              <span className="text-sm font-medium">{label}</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`${label}（色を選択）`}
                  data-testid={`custom-color-${role}`}
                  value={palette[role].toLowerCase()}
                  onChange={(e) => {
                    const v = normalizeHexColor(e.target.value);
                    if (v) {
                      onChange(role, v);
                      setDraft(role, undefined);
                    }
                  }}
                  className="h-10 w-14 cursor-pointer rounded border border-neutral-300 bg-white p-0.5 dark:border-neutral-600"
                />
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={7}
                  aria-label={`${label}（色コード）`}
                  aria-invalid={invalid}
                  data-testid={`custom-hex-${role}`}
                  value={draft ?? palette[role]}
                  onChange={(e) => {
                    const text = e.target.value;
                    const v = normalizeHexColor(text);
                    if (v) {
                      onChange(role, v);
                      // 正しい色コードになったら、入力途中の文字は捨てて、確定した色を表示する
                      setDraft(role, undefined);
                    } else {
                      setDraft(role, text);
                    }
                  }}
                  onBlur={() => setDraft(role, undefined)}
                  className={`w-28 rounded-lg border px-2 py-2 font-mono text-sm ${
                    invalid ? "border-red-500" : "border-neutral-300 dark:border-neutral-600"
                  } bg-white dark:bg-neutral-950`}
                />
              </div>
              {invalid && (
                <span role="alert" className="text-xs text-red-600 dark:text-red-400">色コードは #1F3864 の形式で入力してください</span>
              )}
            </div>
          );
        })}
      </div>

      <div data-testid="custom-contrast" className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">読みやすさの目安（文字と背景のコントラスト比）</span>
        <ul className="flex flex-col gap-0.5">
          {checks.map((c) => {
            const ratio = contrastRatio(c.fg, c.bg);
            const ok = ratio >= READABLE_RATIO;
            return (
              <li key={c.id} data-testid={`custom-contrast-${c.id}`} data-ok={ok} className="flex flex-wrap items-center gap-2">
                <span className="inline-block h-4 w-8 rounded border border-neutral-300 text-center text-[10px] leading-4" style={{ background: c.bg, color: c.fg }} aria-hidden="true">
                  Aa
                </span>
                <span>{c.label}</span>
                <span className={ok ? "text-emerald-700 dark:text-emerald-400" : "font-medium text-amber-700 dark:text-amber-400"}>
                  {ratio.toFixed(1)}:1 {ok ? "（読みやすい）" : "（読みにくい可能性があります）"}
                </span>
              </li>
            );
          })}
        </ul>
        <span className="text-neutral-500 dark:text-neutral-400">
          {READABLE_RATIO}:1以上が目安です。目安に届かなくても、そのまま作成できます。
        </span>
      </div>

      <div>
        <button
          type="button"
          onClick={() => {
            setDrafts({});
            onReset();
          }}
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          カスタム配色を初期値に戻す
        </button>
        <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
          （初期値: {CALENDAR_CUSTOM_ROLES.map((r) => CALENDAR_CUSTOM_DEFAULT[r]).join(" / ")}）
        </span>
      </div>
    </div>
  );
}
