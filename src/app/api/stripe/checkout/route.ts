import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/user";
import { getStripeClient } from "@/lib/stripe/client";
import { isStripeConfigured, hasPriceIdFor, stripeConfig } from "@/lib/stripe/config";
import { getOrCreateStripeCustomerId } from "@/lib/stripe/customer";
import { siteConfig } from "@/lib/config/site";
import type { Plan } from "@/lib/plans/types";
import { checkRateLimit } from "@/lib/utils/rate-limit";

// Checkout Session作成はStripe APIコストが発生する操作のため、
// 認証済みユーザー単位で乱打を抑制する（Phase 6.5 セキュリティ監査で追加）。
const RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Standard / Premium のStripe Checkout Sessionを作成し、そのURLを返す。
 * /pricing の「Standardを始める」「Premiumを始める」ボタンから呼ばれる。
 *
 * - 決済情報（カード番号等）はMr.Satto側では一切扱わない。Stripe Checkoutへ
 *   リダイレクトし、入力・処理はStripe側で完結させる（Phase 3 spec 7章）。
 * - Checkoutセッションを見ただけで契約確定とはしない。正式な契約状態の反映は
 *   Stripe Webhook（/api/stripe/webhook）経由でのみ行う（Phase 3 spec 9章）。
 */
function isValidPlan(value: unknown): value is Exclude<Plan, "free"> {
  return value === "standard" || value === "premium";
}

export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "現在、決済機能は準備中です（Stripeが設定されていません）。" },
      { status: 503 }
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "この操作にはログインが必要です。" },
      { status: 401 }
    );
  }

  const rateLimit = checkRateLimit(`stripe-checkout:${user.id}`, RATE_LIMIT);
  if (rateLimit.limited) {
    return NextResponse.json(
      { error: "リクエストが多すぎます。しばらくしてから再度お試しください。" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const plan = (body as { plan?: unknown })?.plan;
  if (!isValidPlan(plan)) {
    return NextResponse.json(
      { error: "プランはstandardまたはpremiumを指定してください。" },
      { status: 400 }
    );
  }

  if (!hasPriceIdFor(plan)) {
    return NextResponse.json(
      { error: `${plan}プランのPrice IDが設定されていません。管理者に環境変数の設定を確認してください。` },
      { status: 503 }
    );
  }

  try {
    const customerId = await getOrCreateStripeCustomerId(user.id, user.email);
    const stripe = getStripeClient();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: stripeConfig.priceIds[plan], quantity: 1 }],
      success_url: `${siteConfig.url}/account?checkout=success`,
      cancel_url: `${siteConfig.url}/pricing?checkout=cancelled`,
      subscription_data: {
        metadata: { supabase_user_id: user.id, plan },
      },
      allow_promotion_codes: true,
    });

    if (!session.url) {
      return NextResponse.json({ error: "Checkoutセッションの作成に失敗しました。" }, { status: 502 });
    }

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("[stripe/checkout]", error);
    return NextResponse.json(
      { error: "決済ページの作成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
