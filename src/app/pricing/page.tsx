import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/config/site";
import { featureFlags } from "@/lib/config/features";
import { FeatureUnavailable } from "@/components/layout/feature-unavailable";
import { OFFERED_PLAN_IDS, PLAN_DEFINITIONS } from "@/lib/plans/types";
import { getServerPlan } from "@/lib/plans/current-plan";
import { hasOpenSubscription } from "@/lib/plans/effective-plan";
import { isStripeConfigured } from "@/lib/stripe/config";
import { verifyPremiumPrice } from "@/lib/stripe/price-guard-server";
import { isRewardedAdGateActive } from "@/lib/ads/gam-config";
import { PricingActionButton } from "@/components/pricing/pricing-action-button";

export const metadata: Metadata = {
  title: "料金プラン",
  description: `${siteConfig.name}の料金プラン（無料・プレミアム）のご案内です。`,
  alternates: {
    canonical: "/pricing",
  },
  ...(featureFlags.billing ? {} : { robots: { index: false, follow: false } }),
};

const PLAN_TOOL_ACCESS_LABEL: Record<string, string> = {
  standard: "通常ツールを利用可能",
  all: "すべてのツールを利用可能",
};

/**
 * 料金ページ限定の、プランごとの利用条件の補足（誇張表現は入れない）。
 *
 * 無料プランの説明は、広告視聴の仕組みが実際に有効かどうか（isRewardedAdGateActive）で
 * 書き分ける。設計上の想定（広告を見ると1時間利用できる）と、現在の実際の挙動
 * （広告視聴の仕組みが無効の間は、広告を見なくても使える）を混同しないため。
 */
/** プランカードの「広告」の行。広告の仕組みが有効でない間は、実際の状態（広告を見る必要がない）を書く */
function getAdsLabel(adsRequired: boolean, adGateActive: boolean): string {
  if (!adsRequired) return "広告なし";
  if (adGateActive) return "広告視聴あり";
  return featureFlags.ads ? "広告が表示されます" : "現在、広告は表示されません";
}

function getPlanUsageNote(planId: string, adGateActive: boolean): string {
  switch (planId) {
    case "free":
      return adGateActive
        ? "広告を見ると1時間、通常ツールを利用できます（複数のツールをまとめて利用可能）"
        : "現在は、広告を見なくても通常ツールをご利用いただけます。広告視聴の仕組みが有効になった後は、広告を見ると1時間、通常ツールを利用できる形になります。";
    case "premium":
      return `月額${PLAN_DEFINITIONS.premium.priceYen.toLocaleString("ja-JP")}円（税込）・広告なし・プレミアム対象ツールも利用可能`;
    default:
      return "";
  }
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  // 課金システムがオフの間は準備中の案内だけを表示する（src/lib/config/features.ts）
  if (!featureFlags.billing) return <FeatureUnavailable title="料金プラン" />;

  const { checkout } = await searchParams;
  const serverPlan = await getServerPlan();
  // 画面の料金とStripeの実際の価格が一致しているときだけ、お申し込みを受け付ける
  const stripeConfigured = isStripeConfigured() && (await verifyPremiumPrice()).ok;
  const adGateActive = isRewardedAdGateActive();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-neutral-900 dark:text-white">料金プラン</h1>
      <p className="mb-10 text-sm text-neutral-600 dark:text-neutral-300">
        {siteConfig.name}は、無料プランとプレミアムプランでご利用いただけます。
      </p>

      {checkout === "cancelled" && (
        <p className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          お申し込みは完了していません。もう一度お試しいただけます。
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {OFFERED_PLAN_IDS.map((id) => {
          const plan = PLAN_DEFINITIONS[id];
          return (
            <div
              key={plan.id}
              className="flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div>
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">
                  {plan.name}
                </h2>
                <p className="mt-1 text-2xl font-bold text-neutral-900 dark:text-white">
                  {plan.priceYen === 0 ? "0円" : `${plan.priceYen.toLocaleString()}円`}
                  {plan.priceYen > 0 && (
                    <span className="ml-1 text-sm font-normal text-neutral-400">/月（税込）</span>
                  )}
                </p>
              </div>

              <ul className="flex flex-col gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {PLAN_TOOL_ACCESS_LABEL[plan.toolAccess]}
                </li>
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {getAdsLabel(plan.adsRequired, adGateActive)}
                </li>
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {id === "premium" ? "年度カレンダー作成の「AIで読み取る」補助（利用枠あり）" : "通常の年度カレンダー作成は無料（AIは使いません）"}
                </li>
              </ul>

              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {getPlanUsageNote(plan.id, adGateActive)}
              </p>

              {id === "free" ? (
                <span className="mt-auto w-full rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-center text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                  {serverPlan.plan === "free" ? "現在ご利用中のプランです" : "ログイン不要"}
                </span>
              ) : (
                <PricingActionButton
                  plan={id}
                  isAuthenticated={serverPlan.userId !== null}
                  currentPlan={serverPlan.plan}
                  stripeConfigured={stripeConfigured}
                  hasOpenSubscription={hasOpenSubscription(serverPlan.subscription)}
                />
              )}
            </div>
          );
        })}
      </div>

      <section className="mt-10 rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="mb-3 text-base font-semibold text-neutral-900 dark:text-white">
          お支払い・解約について
        </h2>
        <ul className="flex flex-col gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <li className="flex items-start gap-2">
            <span aria-hidden="true">・</span>
            有料プランは月額（税込）です。お申し込みの完了時から課金が始まり、毎月自動で更新されます。
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden="true">・</span>
            解約は、アカウント画面の「お支払い方法の変更・解約」からいつでもできます。解約後も、現在の契約期間の終了まではご利用いただけます。
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden="true">・</span>
            法令に定める場合を除き、お支払い済みの料金の返金や、日割り計算は行いません。
          </li>
          <li className="flex items-start gap-2">
            <span aria-hidden="true">・</span>
            お支払いの確認が取れない間は、無料プランと同じ扱いになります。
          </li>
        </ul>
        <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
          お申し込みの前に、
          <Link href="/terms" className="mx-1 text-blue-600 hover:underline dark:text-blue-400">
            利用規約
          </Link>
          と
          <Link href="/tokushoho" className="mx-1 text-blue-600 hover:underline dark:text-blue-400">
            特定商取引法に基づく表記
          </Link>
          をご確認ください。
        </p>
      </section>

      <p className="mt-8 text-xs text-neutral-400 dark:text-neutral-500">
        ※ お支払い・契約状況の確認は Stripe を利用しています。カード情報はMr.Satto側では保存しません。
        {!stripeConfigured &&
          " 現在、プレミアムへのお申し込み機能は準備中です。"}
      </p>
    </div>
  );
}
