import type { Metadata } from "next";
import Link from "next/link";
import { siteConfig } from "@/lib/config/site";
import { featureFlags } from "@/lib/config/features";
import { FeatureUnavailable } from "@/components/layout/feature-unavailable";
import { OFFERED_PLAN_IDS, PLAN_DEFINITIONS } from "@/lib/plans/types";
import { getServerPlan } from "@/lib/plans/current-plan";
import { hasOpenSubscription, resolveEffectivePlan } from "@/lib/plans/effective-plan";
import { trialOfferState } from "@/lib/plans/grants";
import { hasUsedTrial } from "@/lib/plans/grant-store";
import { TrialCard } from "@/components/pricing/trial-card";
import { isPlanChangeReady, isStripeConfigured } from "@/lib/stripe/config";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { verifyPlanPrice } from "@/lib/stripe/price-guard-server";
import { planChangeFor } from "@/lib/plans/plan-change";
import { AD_EVERY_DOWNLOAD } from "@/lib/plans/temporary-access-cookie";
import { isRewardedAdGateActive } from "@/lib/ads/gam-config";
import { PricingActionButton } from "@/components/pricing/pricing-action-button";
import { PlanComparison } from "@/components/pricing/plan-comparison";
import { tools } from "@/lib/tools/data";
import { PremiumTag } from "@/components/ui/premium-badge";
import type React from "react";

export const metadata: Metadata = {
  title: "料金プラン",
  description: `${siteConfig.name}の料金プラン（無料・スタンダード・プレミアム）のご案内です。無料プラン、スタンダードプラン（月額${PLAN_DEFINITIONS.standard.priceYen.toLocaleString()}円・税込）、プレミアムプラン（月額${PLAN_DEFINITIONS.premium.priceYen.toLocaleString()}円・税込）でできること、AIの補助の利用枠、解約の方法を説明します。`,
  alternates: {
    canonical: "/pricing",
  },
  ...(featureFlags.billing ? {} : { robots: { index: false, follow: false } }),
};

/**
 * プレミアムのプラン限定として提供しているツールが、実際にあるか。
 * ツールの一覧データ（src/lib/tools/data.ts）の実際の設定から判定する。
 * 全ツールを標準扱いにしている間は false になり、「プレミアム対象ツール」の説明を出さない。
 */
const hasPremiumOnlyTools = tools.some((t) => t.status === "available" && t.requiredPlan === "premium");

/** プランカードの「ツールの利用範囲」の行。実際にプレミアム限定のツールがない間は、どのプランも同じ表示にする */
function getToolAccessLabel(toolAccess: string): string {
  if (!hasPremiumOnlyTools) return "すべてのツールを利用可能";
  return toolAccess === "all" ? "すべてのツールを利用可能" : "通常ツールを利用可能";
}

/** プランカードの「件数の上限」の行（src/lib/plans/tool-limits.ts の PLAN_LIMITS の傾向を1行で書く） */
const LIMIT_LABEL: Record<(typeof OFFERED_PLAN_IDS)[number], string> = {
  free: "件数の上限は少なめ",
  standard: "一部ツールで上限アップ",
  premium: "件数の上限が最大",
};


/** プランカードの「広告」の行。広告の仕組みが有効でない間は、実際の状態（広告を見る必要がない）を書く */
function getAdsLabel(adsRequired: boolean, adGateActive: boolean): string | null {
  // 広告そのものを提供していない間は、「広告なし」を有料プランの特典として書かない（書くと、特典があるように見えてしまう）
  if (!adsRequired) return featureFlags.ads ? "広告なし" : null;
  if (adGateActive) return AD_EVERY_DOWNLOAD ? "ダウンロードのたびに広告を視聴" : "広告視聴あり";
  return featureFlags.ads ? "広告が表示されます" : "現在、広告は表示されません";
}

/** プランの特典の1行（✓ 付き） */
function PlanItem({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <li className="flex items-start gap-2" data-testid={testId}>
      <span aria-hidden="true" className="mt-0.5 font-bold text-ms-accent dark:text-ms-focus">
        ✓
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  // 課金システムがオフの間は準備中の案内だけを表示する（src/lib/config/features.ts）
  if (!featureFlags.billing) return <FeatureUnavailable title="料金プラン" />;

  const { checkout } = await searchParams;
  // プランの判定と、Stripeの価格の確認は、互いの結果を使わないので、同時に行う（順番に待たない）。
  // 画面の料金とStripeの実際の価格が一致しているときだけ、お申し込みを受け付ける
  const [serverPlan, premiumReady, standardReady] = await Promise.all([
    getServerPlan(),
    isStripeConfigured() ? verifyPlanPrice("premium").then((check) => check.ok) : Promise.resolve(false),
    isStripeConfigured() ? verifyPlanPrice("standard").then((check) => check.ok) : Promise.resolve(false),
  ]);
  // プランごとに、画面の料金とStripeの価格が一致しているか（一致していないプランは「準備中」）
  const planReady = { standard: standardReady, premium: premiumReady };
  // スタンダード ↔ プレミアムの変更は、両プランの価格がStripeと一致し、ポータルでプラン変更を有効にしているときだけ
  const planChangeReady = isPlanChangeReady() && standardReady && premiumReady;
  const adGateActive = isRewardedAdGateActive();
  // Stripeの契約でのプラン（無料付与・お試しによるプレミアムとは分ける。付与中の人も、通常どおり申し込める）
  const subscriptionPlan = resolveEffectivePlan(serverPlan.subscription);
  const trialState = trialOfferState({
    // 会員登録が準備中の環境（Supabaseの設定がない）では、無料お試しを案内しない
    signupAvailable: isSupabaseConfigured(),
    signedIn: serverPlan.userId !== null,
    subscriptionPremium: subscriptionPlan === "premium",
    grantActive: serverPlan.grantActive,
    trialUsed: serverPlan.userId !== null && !serverPlan.grantActive && subscriptionPlan !== "premium" ? await hasUsedTrial(serverPlan.userId) : false,
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-bold text-ms-text">料金プラン</h1>

      {checkout === "cancelled" && (
        <p className="ms-glass mb-6 px-4 py-3 text-sm text-ms-muted">
          お申し込みは完了していません。もう一度お試しいただけます。
        </p>
      )}

      <TrialCard state={trialState} grant={serverPlan.grantActive ? serverPlan.grant : null} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {OFFERED_PLAN_IDS.map((id) => {
          const plan = PLAN_DEFINITIONS[id];
          return (
            <div
              key={plan.id}
              className="ms-glass flex flex-col gap-4 p-6"
            >
              <div>
                <h2 className="text-lg font-semibold text-ms-text">
                  {plan.name}
                </h2>
                <p className="mt-1 text-2xl font-bold text-ms-text">
                  {plan.priceYen === 0 ? "0円" : `${plan.priceYen.toLocaleString()}円`}
                  {plan.priceYen > 0 && (
                    <span className="ml-1 text-sm font-normal text-ms-muted">/月（税込）</span>
                  )}
                </p>
              </div>

              {/* 特典の一覧（✓ 付き）。1行ずつ短く書き、細かい条件は利用規約・各ツールの画面に任せる */}
              <ul className="flex flex-col gap-2 text-sm text-ms-text">
                <PlanItem>{getToolAccessLabel(plan.toolAccess)}</PlanItem>
                <PlanItem testId={`pricing-batch-${id}`}>
                  {id === "premium" ? "複数ファイルの一括処理" : "ファイルは1つずつ処理"}
                </PlanItem>
                <PlanItem testId={`pricing-limit-${id}`}>{LIMIT_LABEL[id]}</PlanItem>
                {getAdsLabel(plan.adsRequired, adGateActive) && <PlanItem>{getAdsLabel(plan.adsRequired, adGateActive)}</PlanItem>}
                <PlanItem>{id === "premium" ? "記入済みPDF→Excel：制限なし" : "記入済みPDF→Excel：1回1ページ"}</PlanItem>
                {id === "premium" && (
                  <PlanItem testId="pricing-ai-premium">
                    <span className="inline-flex items-center gap-2">AIの補助 <PremiumTag kind="ai" /></span>
                  </PlanItem>
                )}
              </ul>

              {id === "free" ? (
                <span className="mt-auto w-full rounded-lg border border-dashed border-ms-border-strong px-4 py-2 text-center text-sm text-ms-muted">
                  {subscriptionPlan === "free" && !serverPlan.grantActive ? "現在ご利用中のプランです" : "ログイン不要"}
                </span>
              ) : (
                <PricingActionButton
                  plan={id}
                  isAuthenticated={serverPlan.userId !== null}
                  currentPlan={subscriptionPlan}
                  stripeConfigured={planReady[id]}
                  hasOpenSubscription={hasOpenSubscription(serverPlan.subscription)}
                  planChange={planChangeReady ? planChangeFor(serverPlan.subscription, id) : null}
                />
              )}
            </div>
          );
        })}
      </div>

      <PlanComparison adGateActive={adGateActive} />

      <section className="ms-glass mt-10 p-6">
        <h2 className="mb-3 text-base font-semibold text-ms-text">
          お支払い・解約について
        </h2>
        <ul className="flex flex-col gap-2 text-sm text-ms-muted">
          <li>・有料プランは毎月自動で更新されます。</li>
          <li>・解約はアカウント画面からいつでもできます（契約期間の終了まで利用可）。</li>
          <li>・法令に定める場合を除き、返金や、日割り計算は行いません。</li>
        </ul>
        <p className="mt-4 text-xs text-ms-muted">
          お申し込みの前に、
          <Link href="/terms" className="mx-1 text-ms-accent hover:underline dark:text-ms-focus">
            利用規約
          </Link>
          と
          <Link href="/tokushoho" className="mx-1 text-ms-accent hover:underline dark:text-ms-focus">
            特定商取引法に基づく表記
          </Link>
          をご確認ください。
        </p>
      </section>

      <p className="mt-8 text-xs text-ms-muted">
        ※ お支払い・契約状況の確認は Stripe を利用しています。カード情報はMr.Satto側では保存しません。
        {!premiumReady && " 現在、プレミアムへのお申し込み機能は準備中です。"}
        {!standardReady && " 現在、スタンダードへのお申し込み機能は準備中です。"}
      </p>
    </div>
  );
}
