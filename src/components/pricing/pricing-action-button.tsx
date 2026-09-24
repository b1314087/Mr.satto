"use client";

import { useState } from "react";
import Link from "next/link";
import type { Plan } from "@/lib/plans/types";

/**
 * /pricing の各プランカードのアクションボタン。
 *
 * Guestがクリックした場合はまずログイン/会員登録を促し、ログイン後に
 * Checkoutへ進める（Phase 3 spec 8章）。Checkout自体はStripeへ
 * リダイレクトするだけで、カード情報はMr.Satto側で扱わない。
 */
export function PricingActionButton({
  plan,
  isAuthenticated,
  currentPlan,
  stripeConfigured,
}: {
  plan: Exclude<Plan, "free">;
  isAuthenticated: boolean;
  currentPlan: Plan;
  stripeConfigured: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (currentPlan === plan) {
    return (
      <div className="mt-auto flex flex-col gap-2">
        <span className="w-full rounded-lg border border-green-300 bg-green-50 px-4 py-2 text-center text-sm font-medium text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-400">
          現在ご利用中のプランです
        </span>
        <Link
          href="/account"
          className="text-center text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          契約状況を確認する
        </Link>
      </div>
    );
  }

  if (!stripeConfigured) {
    return (
      <button
        type="button"
        disabled
        title="現在準備中です"
        className="mt-auto w-full cursor-not-allowed rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
      >
        準備中
      </button>
    );
  }

  if (!isAuthenticated) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent("/pricing")}`}
        className="mt-auto w-full rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        ログインして始める
      </Link>
    );
  }

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "決済ページの作成に失敗しました。");
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("決済ページの作成に失敗しました。しばらくしてから再度お試しください。");
      setLoading(false);
    }
  }

  return (
    <div className="mt-auto flex flex-col gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "移動中..." : `${plan === "standard" ? "スタンダード" : "プレミアム"}を始める`}
      </button>
      {error && <p className="text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
