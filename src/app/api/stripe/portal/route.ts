import { siteUrlIssue } from "@/lib/config/site-url";
import { NextResponse } from "next/server";
import { featureFlags } from "@/lib/config/features";
import { getCurrentUser } from "@/lib/auth/user";
import { getStripeClient } from "@/lib/stripe/client";
import { isStripeConfigured, stripeConfig } from "@/lib/stripe/config";
import { resolvePortalConfiguration } from "@/lib/stripe/portal-config";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { siteConfig } from "@/lib/config/site";
import { checkRateLimit } from "@/lib/utils/rate-limit";

// Customer Portal Session作成もStripe APIコストが発生する操作のため、
// 認証済みユーザー単位で乱打を抑制する（Phase 6.5 セキュリティ監査で追加）。
const RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Stripe Customer Portal のセッションを作成し、そのURLを返す。
 * /account の「お支払い方法の変更・解約」導線から呼ばれる。
 *
 * 自前で複雑なカード管理・プラン変更画面を作らず、Stripeが提供する
 * Customer Portal（解約・プラン変更・支払い方法変更・請求履歴）に一任する
 * （Phase 3 spec 13章・14章）。
 */
export async function POST() {
  // 課金システムがオフの間は、決済を受け付けない（src/lib/config/features.ts）
  if (!featureFlags.billing) {
    return NextResponse.json({ error: "現在、決済管理機能は提供していません。" }, { status: 404 });
  }

  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "現在、決済管理機能は準備中です（Stripeが設定されていません）。" },
      { status: 503 }
    );
  }

  // Mr.Satto専用のポータル設定ID。指定があるのに形式が違う（設定ミス）場合は、他サービスの既定設定へ黙って切り替えず、開かない。
  const portalConfiguration = resolvePortalConfiguration(stripeConfig.portalConfigurationId);
  if (!portalConfiguration.ok) {
    console.error("[stripe/portal] STRIPE_PORTAL_CONFIGURATION_ID の形式が正しくありません（bpc_… を設定してください）");
    return NextResponse.json({ error: "現在、決済管理機能は準備中です。" }, { status: 503 });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "この操作にはログインが必要です。" }, { status: 401 });
  }

  const rateLimit = checkRateLimit(`stripe-portal:${user.id}`, RATE_LIMIT);
  if (rateLimit.limited) {
    return NextResponse.json(
      { error: "リクエストが多すぎます。しばらくしてから再度お試しください。" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) } }
    );
  }

  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "契約情報の取得に失敗しました。しばらくしてから再度お試しください。" },
      { status: 503 }
    );
  }

  const { data } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data?.stripe_customer_id) {
    return NextResponse.json(
      { error: "契約情報が見つかりません。まずプランへの登録を行ってください。" },
      { status: 404 }
    );
  }

  const siteIssue = siteUrlIssue(siteConfig.url, process.env.NODE_ENV);
  if (siteIssue) {
    console.error("[stripe/portal] site url is not ready:", siteIssue);
    return NextResponse.json({ error: "契約管理ページを準備中です。しばらくしてから再度お試しください。" }, { status: 503 });
  }

  try {
    const stripe = getStripeClient();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${siteConfig.url}/account`,
      // Mr.Satto専用のポータル設定（未設定の間は、アカウントの既定の設定が使われる）
      ...(portalConfiguration.id ? { configuration: portalConfiguration.id } : {}),
    });
    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("[stripe/portal]", error);
    return NextResponse.json(
      { error: "契約管理ページの作成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
