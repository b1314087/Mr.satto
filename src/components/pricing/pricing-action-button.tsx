"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Plan } from "@/lib/plans/types";
import { siteConfig } from "@/lib/config/site";
import { wrongAddressMessage } from "@/lib/stripe/wrong-address";
import { PortalLinkButton } from "@/components/account/portal-link-button";
import { PLAN_CHANGE_LABEL, type PlanChange } from "@/lib/plans/plan-change";

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
  hasOpenSubscription = false,
  planChange = null,
}: {
  plan: Exclude<Plan, "free">;
  isAuthenticated: boolean;
  currentPlan: Plan;
  stripeConfigured: boolean;
  /** まだ続いている契約がある（契約が二重にならないよう、新しく申し込ませない） */
  hasOpenSubscription?: boolean;
  /** 契約中のプランから、このプランへ変更できるとき（ポータルのプラン変更の画面を開く。src/lib/plans/plan-change.ts） */
  planChange?: PlanChange | null;
}) {
  const router = useRouter();
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
          className="text-center text-xs text-ms-accent hover:underline dark:text-ms-focus"
        >
          契約状況を確認する
        </Link>
      </div>
    );
  }

  if (hasOpenSubscription && planChange) {
    return (
      <div className="mt-auto flex flex-col gap-2">
        <PortalLinkButton flow="plan_change" label={PLAN_CHANGE_LABEL[planChange]} variant="primary" testId={`plan-change-${plan}`} />
        <p className="text-center text-xs text-ms-muted">
          {planChange === "upgrade"
            ? "差額は日割りで計算され、変更時に請求されます。"
            : "次回の更新日まではプレミアムのままご利用いただけます。"}
        </p>
      </div>
    );
  }

  if (hasOpenSubscription) {
    return (
      <div className="mt-auto flex flex-col gap-2">
        <span className="w-full rounded-lg border border-dashed border-ms-border-strong px-4 py-2 text-center text-sm text-ms-muted">
          すでにご契約があります
        </span>
        <Link href="/account" className="text-center text-xs text-ms-accent hover:underline dark:text-ms-focus">
          契約状況・お支払い方法の変更・解約
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
        className="mt-auto w-full cursor-not-allowed rounded-lg border border-dashed border-ms-border-strong px-4 py-2 text-sm text-ms-muted"
      >
        準備中
      </button>
    );
  }

  if (!isAuthenticated) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent("/pricing")}`}
        className="ms-btn ms-btn-primary mt-auto w-full"
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
      const data = (await res.json()) as { url?: string; error?: string; code?: string };
      if (data.code === "consent_required") {
        // 現在の利用規約等への同意が未記録: アカウント画面で同意してもらう
        router.push("/account?consent=required");
        return;
      }
      if (!res.ok || !data.url) {
        setError(wrongAddressMessage(res.status, "/pricing", window.location.origin, siteConfig.url) ?? data.error ?? "決済ページの作成に失敗しました。");
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
        aria-busy={loading || undefined}
        className="w-full ms-btn ms-btn-primary"
      >
        {loading ? "移動中..." : plan === "standard" ? "スタンダードを始める" : "プレミアムを始める"}
      </button>
      {error && <p className="text-center text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
