"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatAiTokens, type AiModelTier } from "@/lib/ai/pricing";

/**
 * 年度カレンダーの「AIで読み取る」パネル（画像・スキャンPDF用 / Excelの読み取れなかった行用）で共通に使う部品。
 * 文章を減らし、見出し・手順の番号・カード・色で、何をすればよいかが一目で分かるようにする。
 * 送る内容の確認・毎回の同意・利用枠の表示といった、安全のための要素は減らさない（言い方を短くしただけ）。
 */

export type AiUsage = { limitAiTokens: number; usedAiTokens: number; remainingAiTokens: number; periodEnd: string };

function formatPeriodEnd(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** きらめきのアイコン（AIの印） */
export function SparkleIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 2.5l1.9 5.6a2 2 0 0 0 1.3 1.3l5.6 1.9-5.6 1.9a2 2 0 0 0-1.3 1.3L12 20.1l-1.9-5.6a2 2 0 0 0-1.3-1.3L3.2 11.3l5.6-1.9a2 2 0 0 0 1.3-1.3L12 2.5z" />
      <path d="M19 15.5l.7 2a1 1 0 0 0 .6.6l2 .7-2 .7a1 1 0 0 0-.6.6l-.7 2-.7-2a1 1 0 0 0-.6-.6l-2-.7 2-.7a1 1 0 0 0 .6-.6l.7-2z" opacity=".7" />
    </svg>
  );
}

/** パネルの見出し: 紫のアイコン＋タイトル＋「プレミアム」の印。右側に操作ボタンなどを置ける */
export function AiPanelHeader({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white shadow-sm">
        <SparkleIcon />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-violet-950 dark:text-violet-50">
          {title}
          <span className="rounded-full bg-violet-200 px-2 py-0.5 text-[11px] font-semibold text-violet-800 dark:bg-violet-800 dark:text-violet-100">プレミアム</span>
        </p>
        {sub && <p className="text-xs text-violet-800 dark:text-violet-200">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** 手順の見出し（丸い番号つき） */
export function StepLabel({ n, children, hint }: { n: number; children: ReactNode; hint?: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
      <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-bold text-white">
        {n}
      </span>
      {children}
      {hint && <span className="text-xs font-normal text-neutral-600 dark:text-neutral-300">{hint}</span>}
    </p>
  );
}

/** 今期のAI利用枠（残りを棒グラフで示す）。AIトークン表記と「残り」は、画面の利用枠表示の約束事 */
export function AiUsageMeter({ usage }: { usage: AiUsage }) {
  const ratio = usage.limitAiTokens > 0 ? Math.max(0, Math.min(1, usage.remainingAiTokens / usage.limitAiTokens)) : 0;
  const low = ratio < 0.15;
  return (
    <div data-testid="ai-usage" className="flex flex-col gap-1 rounded-lg bg-white px-3 py-2 dark:bg-neutral-900">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-neutral-600 dark:text-neutral-300">今期のAI利用枠</span>
        <span className={low ? "font-semibold text-red-700 dark:text-red-300" : "font-semibold text-violet-900 dark:text-violet-100"}>
          残り {formatAiTokens(usage.remainingAiTokens)} AIトークン
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="AI利用枠の残り"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900"
      >
        <div className={`h-full rounded-full ${low ? "bg-red-500" : "bg-violet-600"}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
        使用済み {formatAiTokens(usage.usedAiTokens, "ceil")} / {formatAiTokens(usage.limitAiTokens)}
        {usage.periodEnd && <span>　リセット日 {formatPeriodEnd(usage.periodEnd)}</span>}
      </p>
    </div>
  );
}

/** 使えない理由（ログイン必要・プレミアムではない・提供停止）と、次にすることへのリンク */
export function AiUnavailableNotice({
  reason,
  text,
  loginNext,
}: {
  reason: "login_required" | "not_premium" | "unavailable";
  text: string;
  loginNext: string;
}) {
  const linkClass =
    "inline-flex items-center rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800";
  return (
    <div data-testid="ai-unavailable" className="flex flex-col gap-2 rounded-lg bg-white px-3 py-2.5 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
      <span>{text}</span>
      {reason === "not_premium" && (
        <Link href="/pricing" data-testid="ai-upgrade-link" className={`${linkClass} w-fit`}>
          プレミアムプランを見る
        </Link>
      )}
      {reason === "login_required" && (
        <Link href={`/login?next=${encodeURIComponent(loginNext)}`} data-testid="ai-login-link" className={`${linkClass} w-fit`}>
          ログインする
        </Link>
      )}
    </div>
  );
}

/** 読み取りの種類（標準／高精度）を、2枚のカードから選ぶ */
export function TierPicker({
  name,
  value,
  onChange,
  standardTestId,
  advancedTestId,
  advancedHint,
}: {
  name: string;
  value: AiModelTier;
  onChange: (tier: AiModelTier) => void;
  standardTestId: string;
  advancedTestId: string;
  advancedHint: string;
}) {
  const card = (selected: boolean) =>
    `flex cursor-pointer items-start gap-2 rounded-lg border-2 p-2.5 text-sm transition-colors ${
      selected
        ? "border-violet-600 bg-white dark:border-violet-400 dark:bg-neutral-900"
        : "border-neutral-200 bg-white/60 hover:border-violet-300 dark:border-neutral-700 dark:bg-neutral-900/60"
    }`;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label className={card(value === "standard")}>
        <input type="radio" name={name} data-testid={standardTestId} checked={value === "standard"} onChange={() => onChange("standard")} className="mt-1 accent-violet-700" />
        <span className="flex flex-col">
          <span className="font-semibold text-neutral-900 dark:text-neutral-100">
            標準 <span className="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-900 dark:text-green-100">おすすめ</span>
          </span>
          <span className="text-xs text-neutral-600 dark:text-neutral-300">利用枠の消費が少なめ</span>
        </span>
      </label>
      <label className={card(value === "advanced")}>
        <input type="radio" name={name} data-testid={advancedTestId} checked={value === "advanced"} onChange={() => onChange("advanced")} className="mt-1 accent-violet-700" />
        <span className="flex flex-col">
          <span className="font-semibold text-neutral-900 dark:text-neutral-100">高精度</span>
          <span className="text-xs text-neutral-600 dark:text-neutral-300">{advancedHint}・消費は大きめ</span>
        </span>
      </label>
    </div>
  );
}

/** 毎回の同意。短い一文を主役にし、補足は小さく添える（同意は実行のたびに確認する） */
export function ConsentBox({
  testId,
  checked,
  onChange,
  children,
}: {
  testId: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 同意する内容（短い一文） */
  children: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3 transition-colors ${
        checked ? "border-violet-600 bg-white dark:border-violet-400 dark:bg-neutral-900" : "border-violet-300 bg-white dark:border-violet-700 dark:bg-neutral-950"
      }`}
    >
      <input type="checkbox" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-700" />
      <span className="flex flex-col gap-0.5 text-sm">
        <span className="font-semibold text-neutral-900 dark:text-neutral-100">{children}</span>
        <span className="text-xs text-neutral-600 dark:text-neutral-300">
          送った内容は保存されません。同意は、実行のたびに確認します。
          <Link href="/privacy" target="_blank" className="ml-1 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
            プライバシーポリシー
          </Link>
        </span>
      </span>
    </label>
  );
}

/** 実行ボタン（幅いっぱいの大きなボタン）。同意していないときは、押せない理由を横に出す */
export function AiRunButton({
  testId,
  disabled,
  running,
  label,
  consentGiven,
  onClick,
  onCancel,
  cancelTestId,
}: {
  testId: string;
  disabled: boolean;
  running: boolean;
  label: string;
  consentGiven: boolean;
  onClick: () => void;
  onCancel: () => void;
  cancelTestId: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={testId}
          disabled={disabled}
          onClick={onClick}
          className="inline-flex min-w-48 flex-1 items-center justify-center gap-2 rounded-xl bg-violet-700 px-5 py-3 text-base font-bold text-white shadow-sm transition-colors hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
        >
          <SparkleIcon className="h-4 w-4" />
          {running ? "読み取り中…" : label}
        </button>
        {running && (
          <button
            type="button"
            data-testid={cancelTestId}
            onClick={onCancel}
            className="rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            中止する
          </button>
        )}
      </div>
      {!consentGiven && !running && <p className="text-xs text-neutral-600 dark:text-neutral-300">同意にチェックすると押せます。</p>}
    </div>
  );
}

/** 読み取り中の表示（回転する印と経過時間） */
export function AiProgress({ testId, seconds }: { testId: string; seconds: number }) {
  return (
    <p role="status" data-testid={testId} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-violet-900 dark:bg-neutral-900 dark:text-violet-100">
      <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-violet-300 border-t-violet-700" />
      AIが読み取っています…（{seconds}秒。1〜2分かかることがあります）
    </p>
  );
}

/** 画面共通の枠（紫のカード） */
export const AI_PANEL_CLASS =
  "flex flex-col gap-4 rounded-xl border border-violet-300 bg-gradient-to-b from-violet-50 to-white p-4 text-sm dark:border-violet-800 dark:from-violet-950 dark:to-neutral-950";
