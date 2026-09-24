import type { Metadata } from "next";
import { siteConfig } from "@/lib/config/site";
import { PLAN_DEFINITIONS, PLAN_IDS } from "@/lib/plans/types";
import { getServerPlan } from "@/lib/plans/current-plan";
import { isStripeConfigured } from "@/lib/stripe/config";
import { PricingActionButton } from "@/components/pricing/pricing-action-button";

export const metadata: Metadata = {
  title: "料金プラン",
  description: `${siteConfig.name}の料金プラン（無料・スタンダード・プレミアム）のご案内です。`,
  alternates: {
    canonical: "/pricing",
  },
};

const PLAN_TOOL_ACCESS_LABEL: Record<string, string> = {
  standard: "スタンダード対象ツールを利用可能",
  all: "すべてのツールを利用可能",
};

/** 料金ページ限定の、プランごとの利用条件の補足（誇張表現は入れない） */
const PLAN_USAGE_NOTE: Record<string, string> = {
  free: "広告を見ると15分間スタンダード対象ツールを利用できます（複数のツールをまとめて利用可能）",
  standard: "月額550円・広告なし",
  premium: "月額980円・広告なし・プレミアム対象ツールも利用可能",
};

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const serverPlan = await getServerPlan();
  const stripeConfigured = isStripeConfigured();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-neutral-900 dark:text-white">料金プラン</h1>
      <p className="mb-10 text-sm text-neutral-600 dark:text-neutral-300">
        {siteConfig.name}は3つのプランでご利用いただけます。
      </p>

      {checkout === "cancelled" && (
        <p className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          お申し込みは完了していません。もう一度お試しいただけます。
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {PLAN_IDS.map((id) => {
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
                    <span className="ml-1 text-sm font-normal text-neutral-400">/月</span>
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
                  {plan.adsRequired ? "広告視聴あり" : "広告なし"}
                </li>
              </ul>

              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {PLAN_USAGE_NOTE[plan.id]}
              </p>

              {plan.id === "free" ? (
                <span className="mt-auto w-full rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-center text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
                  {serverPlan.plan === "free" ? "現在ご利用中のプランです" : "ログイン不要"}
                </span>
              ) : (
                <PricingActionButton
                  plan={plan.id}
                  isAuthenticated={serverPlan.userId !== null}
                  currentPlan={serverPlan.plan}
                  stripeConfigured={stripeConfigured}
                />
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-8 text-xs text-neutral-400 dark:text-neutral-500">
        ※ お支払い・契約状況の確認は Stripe を利用しています。カード情報はMr.Satto側では保存しません。
        {!stripeConfigured &&
          " 現在、Standard・Premiumへのお申し込み機能は準備中です。"}
      </p>
    </div>
  );
}
