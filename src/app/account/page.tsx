import type { Metadata } from "next";
import Link from "next/link";
import { getServerPlan } from "@/lib/plans/current-plan";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { signOutAction } from "@/lib/auth/actions";
import { PortalLinkButton } from "@/components/account/portal-link-button";
import { isStripeConfigured } from "@/lib/stripe/config";
import { SUBSCRIPTION_STATUS_LABEL as STATUS_LABEL } from "@/lib/plans/status-labels";
import { featureFlags } from "@/lib/config/features";
import { FeatureUnavailable } from "@/components/layout/feature-unavailable";
import { getConsentState } from "@/lib/legal/consent-store";
import { acceptCurrentTermsAction } from "@/lib/legal/consent-actions";
import { formatLegalVersion, LEGAL_VERSIONS } from "@/lib/legal/versions";

// 個人の契約情報を含むページのため検索エンジンには公開しない（Phase 3 spec 25章）。
export const metadata: Metadata = {
  title: "アカウント",
  description: "現在のプラン・契約状況を確認できます。",
  robots: { index: false, follow: false },
};

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(iso));
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; consent?: string }>;
}) {
  // 課金システムがオフの間は準備中の案内だけを表示する（src/lib/config/features.ts）
  if (!featureFlags.billing) return <FeatureUnavailable title="アカウント" />;

  const { checkout, consent: consentParam } = await searchParams;
  const serverPlan = await getServerPlan();

  if (!serverPlan.userId) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
        <h1 className="mb-3 text-2xl font-bold text-ms-text">アカウント</h1>
        <p className="mb-6 text-sm text-ms-muted">
          アカウント情報の確認にはログインが必要です。
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href="/login?next=/account"
            className="ms-btn ms-btn-primary"
          >
            ログイン
          </Link>
          <Link
            href="/signup"
            className="ms-btn ms-btn-secondary"
          >
            会員登録
          </Link>
        </div>
      </div>
    );
  }

  const planDefinition = PLAN_DEFINITIONS[serverPlan.plan];
  // 現在の利用規約・プライバシーポリシーへの同意の記録（読み取れないときは、案内を出さない）
  const consentState = await getConsentState(serverPlan.userId);
  const consentMissing = consentState.ok && consentState.missing.length > 0;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold text-ms-text">アカウント</h1>

      {checkout === "success" && (
        <p className="ms-glass mb-6 px-4 py-3 text-sm text-ms-text">
          お申し込みありがとうございます。契約状況への反映まで数秒ほどかかる場合があります。反映されない場合はページを再読み込みしてください。
        </p>
      )}

      {consentParam === "done" && (
        <p className="ms-glass mb-6 px-4 py-3 text-sm text-ms-text">同意を記録しました。</p>
      )}
      {consentParam === "failed" && (
        <p className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          同意を記録できませんでした。しばらくしてから、もう一度お試しください。
        </p>
      )}

      {consentMissing && (
        <form action={acceptCurrentTermsAction} className="ms-glass mb-6 flex flex-col gap-3 p-6" id="consent">
          <p className="text-sm font-medium text-ms-text">利用規約・プライバシーポリシーへの同意</p>
          <p className="text-xs leading-relaxed text-ms-muted">
            {consentParam === "required"
              ? "有料プランのお申し込みには、現在の利用規約とプライバシーポリシーへの同意が必要です。"
              : "現在の利用規約とプライバシーポリシーへの同意が、まだ記録されていません。有料プランのお申し込み前に、ご確認ください。"}
          </p>
          <label className="flex items-start gap-2 text-xs leading-relaxed text-ms-muted">
            <input type="checkbox" name="consent" required className="mt-0.5 h-4 w-4 shrink-0 rounded accent-[var(--ms-accent)]" />
            <span>
              <Link href="/terms" target="_blank" rel="noopener noreferrer" className="text-ms-accent hover:underline dark:text-ms-focus">
                利用規約
              </Link>
              （{formatLegalVersion(LEGAL_VERSIONS.terms)}版）と
              <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="text-ms-accent hover:underline dark:text-ms-focus">
                プライバシーポリシー
              </Link>
              （{formatLegalVersion(LEGAL_VERSIONS.privacy)}版）（どちらも新しいタブで開きます）を確認し、同意します。
            </span>
          </label>
          <button type="submit" className="ms-btn ms-btn-primary self-start">
            同意する
          </button>
        </form>
      )}

      <div className="flex flex-col gap-6 ms-glass p-6">
        <div>
          <p className="text-xs text-ms-muted">メールアドレス</p>
          <p className="text-sm text-ms-text">{serverPlan.userEmail}</p>
        </div>

        <div>
          <p className="text-xs text-ms-muted">現在のプラン</p>
          <p className="text-lg font-semibold text-ms-text">
            {planDefinition.name}
          </p>
        </div>

        {serverPlan.plan === "standard" && (
          <p className="ms-glass px-3 py-2 text-xs text-ms-muted">
            スタンダードプランは、新規のお申し込みを終了しています。現在のご契約は、これまでどおりご利用いただけます。
          </p>
        )}

        {serverPlan.subscription && serverPlan.subscription.plan === null && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            ご契約の内容を確認できないため、有料プランの機能をご利用いただけません。お手数ですが、お問い合わせください。
          </p>
        )}

        {serverPlan.subscription ? (
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-ms-muted">契約状態</p>
              <p className="text-ms-text">
                {STATUS_LABEL[serverPlan.subscription.status] ?? serverPlan.subscription.status}
              </p>
            </div>
            <div>
              <p className="text-xs text-ms-muted">
                {serverPlan.subscription.cancelAtPeriodEnd ? "利用可能期限" : "次回更新日"}
              </p>
              <p className="text-ms-text">
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
          <p className="text-sm text-ms-muted">
            現在、有料プランのご契約はありません。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t border-ms-border pt-6">
          {isStripeConfigured() && serverPlan.subscription && <PortalLinkButton />}
          {serverPlan.plan === "free" && (
            <Link
              href="/pricing"
              className="ms-btn ms-btn-primary"
            >
              プランを見る
            </Link>
          )}
          <form action={signOutAction}>
            <button
              type="submit"
              className="ms-btn ms-btn-secondary"
            >
              ログアウト
            </button>
          </form>
        </div>

        <p className="text-xs text-ms-muted">
          アカウントと関連するデータの削除は、
          <Link href="/account/delete" className="text-ms-accent hover:underline dark:text-ms-focus">
            アカウントの削除
          </Link>
          から行えます。
        </p>
      </div>
    </div>
  );
}
