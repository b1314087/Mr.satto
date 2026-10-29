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
import { isStripeConfigured } from "@/lib/stripe/config";
import { verifyPremiumPrice } from "@/lib/stripe/price-guard-server";
import { isRewardedAdGateActive } from "@/lib/ads/gam-config";
import { PricingActionButton } from "@/components/pricing/pricing-action-button";
import { tools } from "@/lib/tools/data";

export const metadata: Metadata = {
  title: "料金プラン",
  description: `${siteConfig.name}の料金プラン（無料・プレミアム）のご案内です。`,
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

/**
 * 料金ページ限定の、プランごとの利用条件の補足（誇張表現は入れない）。
 *
 * 無料プランの説明は、広告視聴の仕組みが実際に有効かどうか（isRewardedAdGateActive）で
 * 書き分ける。設計上の想定（広告を見ると1時間利用できる）と、現在の実際の挙動
 * （広告視聴の仕組みが無効の間は、広告を見なくても使える）を混同しないため。
 */
/** プランカードの「広告」の行。広告の仕組みが有効でない間は、実際の状態（広告を見る必要がない）を書く */
function getAdsLabel(adsRequired: boolean, adGateActive: boolean): string | null {
  // 広告そのものを提供していない間は、「広告なし」をプレミアムの特典として書かない（書くと、特典があるように見えてしまう）
  if (!adsRequired) return featureFlags.ads ? "広告なし" : null;
  if (adGateActive) return "広告視聴あり";
  return featureFlags.ads ? "広告が表示されます" : "現在、広告は表示されません";
}

function getPlanUsageNote(planId: string, adGateActive: boolean): string {
  switch (planId) {
    case "free":
      return adGateActive
        ? "広告を見ると1時間、通常ツールを利用できます（複数のツールをまとめて利用可能）"
        : "広告を見なくても、通常ツールをご利用いただけます。";
    case "premium":
      return `月額${PLAN_DEFINITIONS.premium.priceYen.toLocaleString("ja-JP")}円（税込）${featureFlags.ads ? "・広告なし" : ""}${hasPremiumOnlyTools ? "・プレミアム対象ツールも利用可能" : ""}`;
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
  // Stripeの契約でのプラン（無料付与・お試しによるプレミアムとは分ける。付与中の人も、通常どおり申し込める）
  const subscriptionPlan = resolveEffectivePlan(serverPlan.subscription);
  const trialState = trialOfferState({
    signedIn: serverPlan.userId !== null,
    subscriptionPremium: subscriptionPlan === "premium",
    grantActive: serverPlan.grantActive,
    trialUsed: serverPlan.userId !== null && !serverPlan.grantActive && subscriptionPlan !== "premium" ? await hasUsedTrial(serverPlan.userId) : false,
  });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="mb-2 text-2xl font-bold text-ms-text">料金プラン</h1>
      <p className="mb-10 text-sm text-ms-muted">
        {siteConfig.name}は、無料プランとプレミアムプランでご利用いただけます。
      </p>

      {checkout === "cancelled" && (
        <p className="ms-glass mb-6 px-4 py-3 text-sm text-ms-muted">
          お申し込みは完了していません。もう一度お試しいただけます。
        </p>
      )}

      <TrialCard state={trialState} grant={serverPlan.grantActive ? serverPlan.grant : null} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

              <ul className="flex flex-col gap-2 text-sm text-ms-muted">
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {getToolAccessLabel(plan.toolAccess)}
                </li>
                {getAdsLabel(plan.adsRequired, adGateActive) && (
                  <li className="flex items-start gap-2">
                    <span aria-hidden="true">・</span>
                    {getAdsLabel(plan.adsRequired, adGateActive)}
                  </li>
                )}
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {id === "premium" ? "年度カレンダー作成の「AIで読み取る」補助（Excel・CSV・画像・スキャンPDF／利用枠あり）" : "通常の年度カレンダー作成は無料（AIは使いません）"}
                </li>
                <li className="flex items-start gap-2">
                  <span aria-hidden="true">・</span>
                  {id === "premium" ? "「記入済みPDF→Excel」は、ページ数・回数の制限なし" : "「記入済みPDF→Excel」は、1回1ページまで"}
                </li>
                {id === "premium" && (
                  <li className="flex items-start gap-2">
                    <span aria-hidden="true">・</span>
                    「記入済みPDF→Excel」の「AIで項目を読み取る」補助（文字のPDF／5ページまで・利用枠あり）
                  </li>
                )}
                {id === "premium" && (
                  <li className="flex items-start gap-2">
                    <span aria-hidden="true">・</span>
                    「PDF→Excel」の「AIで表を読み取る」補助（文字のPDF／5ページまで・利用枠あり）
                  </li>
                )}
              </ul>

              <p className="text-xs text-ms-muted">
                {getPlanUsageNote(plan.id, adGateActive)}
              </p>
              {id === "premium" && (
                <p data-testid="pricing-ai-note" className="text-xs text-ms-muted">
                  AIの利用枠は、請求期間ごとに上限があり、AIトークンという単位で残量を表示します。上限に達すると、次の請求期間までAIによる読み取りは利用できません。AIの読み取り結果は提案であり、内容は必ずご自身で確認してください。AIを使う場合は、同意のうえで、選んだ内容が外部のAIサービス（OpenAI）へ送信されます（詳しくは
                  <Link href="/privacy" className="mx-1 text-ms-accent hover:underline dark:text-ms-focus">
                    プライバシーポリシー
                  </Link>
                  をご覧ください）。
                </p>
              )}

              {id === "free" ? (
                <span className="mt-auto w-full rounded-lg border border-dashed border-ms-border-strong px-4 py-2 text-center text-sm text-ms-muted">
                  {subscriptionPlan === "free" && !serverPlan.grantActive ? "現在ご利用中のプランです" : "ログイン不要"}
                </span>
              ) : (
                <PricingActionButton
                  plan={id}
                  isAuthenticated={serverPlan.userId !== null}
                  currentPlan={subscriptionPlan}
                  stripeConfigured={stripeConfigured}
                  hasOpenSubscription={hasOpenSubscription(serverPlan.subscription)}
                />
              )}
            </div>
          );
        })}
      </div>

      <section className="ms-glass mt-10 p-6">
        <h2 className="mb-3 text-base font-semibold text-ms-text">
          お支払い・解約について
        </h2>
        <ul className="flex flex-col gap-2 text-sm text-ms-muted">
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
        {!stripeConfigured &&
          " 現在、プレミアムへのお申し込み機能は準備中です。"}
      </p>
    </div>
  );
}
