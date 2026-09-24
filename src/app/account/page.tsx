import type { Metadata } from "next";
import Link from "next/link";
import { getServerPlan } from "@/lib/plans/current-plan";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { signOutAction } from "@/lib/auth/actions";
import { PortalLinkButton } from "@/components/account/portal-link-button";
import { isStripeConfigured } from "@/lib/stripe/config";

// 個人の契約情報を含むページのため検索エンジンには公開しない（Phase 3 spec 25章）。
export const metadata: Metadata = {
  title: "アカウント",
  description: "現在のプラン・契約状況を確認できます。",
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<string, string> = {
  active: "有効",
  trialing: "トライアル中",
  past_due: "お支払いの確認中",
  canceled: "解約済み",
  unpaid: "未払い",
  incomplete: "手続き未完了",
  incomplete_expired: "手続き期限切れ",
  paused: "一時停止中",
};

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(iso));
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const serverPlan = await getServerPlan();

  if (!serverPlan.userId) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
        <h1 className="mb-3 text-2xl font-bold text-neutral-900 dark:text-white">アカウント</h1>
        <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-300">
          アカウント情報の確認にはログインが必要です。
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href="/login?next=/account"
            className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            ログイン
          </Link>
          <Link
            href="/signup"
            className="rounded-lg border border-neutral-300 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            会員登録
          </Link>
        </div>
      </div>
    );
  }

  const planDefinition = PLAN_DEFINITIONS[serverPlan.plan];

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold text-neutral-900 dark:text-white">アカウント</h1>

      {checkout === "success" && (
        <p className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
          お申し込みありがとうございます。契約状況への反映まで数秒ほどかかる場合があります。反映されない場合はページを再読み込みしてください。
        </p>
      )}

      <div className="flex flex-col gap-6 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">メールアドレス</p>
          <p className="text-sm text-neutral-800 dark:text-neutral-100">{serverPlan.userEmail}</p>
        </div>

        <div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">現在のプラン</p>
          <p className="text-lg font-semibold text-neutral-900 dark:text-white">
            {planDefinition.name}
            {planDefinition.priceYen > 0 && (
              <span className="ml-2 text-sm font-normal text-neutral-400">
                月額{planDefinition.priceYen.toLocaleString()}円
              </span>
            )}
          </p>
        </div>

        {serverPlan.subscription ? (
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-neutral-400 dark:text-neutral-500">契約状態</p>
              <p className="text-neutral-800 dark:text-neutral-100">
                {STATUS_LABEL[serverPlan.subscription.status] ?? serverPlan.subscription.status}
              </p>
            </div>
            <div>
              <p className="text-xs text-neutral-400 dark:text-neutral-500">
                {serverPlan.subscription.cancelAtPeriodEnd ? "利用可能期限" : "次回更新日"}
              </p>
              <p className="text-neutral-800 dark:text-neutral-100">
                {formatDate(serverPlan.subscription.currentPeriodEnd)}
              </p>
            </div>
            {serverPlan.subscription.cancelAtPeriodEnd && (
              <p className="sm:col-span-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                解約手続き済みです。上記の期限まではこのままご利用いただけます。
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            現在、有料プランのご契約はありません。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          {isStripeConfigured() && serverPlan.subscription && <PortalLinkButton />}
          {serverPlan.plan === "free" && (
            <Link
              href="/pricing"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            >
              プランを見る
            </Link>
          )}
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              ログアウト
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
