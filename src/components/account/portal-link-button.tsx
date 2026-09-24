"use client";

import { useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";

/**
 * Stripe Customer Portal（お支払い方法の変更・プラン変更・解約）への導線。
 * 自前で複雑な決済管理画面は作らず、Stripeが提供するPortalへ委譲する
 * （Phase 3 spec 13章・16章）。
 */
export function PortalLinkButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "契約管理ページの作成に失敗しました。");
        setLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("契約管理ページの作成に失敗しました。しばらくしてから再度お試しください。");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="w-fit rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        {loading ? "移動中..." : "お支払い方法の変更・解約はこちら"}
      </button>
      {error && <ErrorMessage message={error} />}
    </div>
  );
}
