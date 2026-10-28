import { NextResponse } from "next/server";
import { featureFlags } from "@/lib/config/features";
import { getCurrentUser } from "@/lib/auth/user";
import { getServerPlan } from "@/lib/plans/current-plan";
import { siteUrlIssue } from "@/lib/config/site-url";
import { hasOpenSubscription, isOpenSubscriptionStatus } from "@/lib/plans/effective-plan";
import { runCheckoutFlow } from "@/lib/stripe/checkout-flow";
import { rejectUntrustedOrigin } from "@/lib/security/request-origin";
import { getStripeClient } from "@/lib/stripe/client";
import { isStripeConfigured, hasPriceIdFor, stripeConfig } from "@/lib/stripe/config";
import { verifyPremiumPrice } from "@/lib/stripe/price-guard-server";
import { getOrCreateStripeCustomerId } from "@/lib/stripe/customer";
import { siteConfig } from "@/lib/config/site";
import type { Plan } from "@/lib/plans/types";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { getConsentState } from "@/lib/legal/consent-store";
import { CONSENT_REQUIRED_MESSAGE, CONSENT_UNAVAILABLE_MESSAGE } from "@/lib/legal/consent";

// Checkout Session作成はStripe APIコストが発生する操作のため、
// 認証済みユーザー単位で乱打を抑制する（Phase 6.5 セキュリティ監査で追加）。
const RATE_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * Premium のStripe Checkout Sessionを作成し、そのURLを返す。
 * /pricing の「プレミアムを始める」ボタンから呼ばれる。
 *
 * 現行の料金体系は Free / Premium（月額1,100円・税込）だけ。旧Standardは新規に申し込めない。
 * 画面に出している料金とStripeの実際の価格が食い違ったまま課金しないよう、Checkoutを作る前にPriceの中身を確認する。
 *
 * - 決済情報（カード番号等）はMr.Satto側では一切扱わない。Stripe Checkoutへ
 *   リダイレクトし、入力・処理はStripe側で完結させる（Phase 3 spec 7章）。
 * - Checkoutセッションを見ただけで契約確定とはしない。正式な契約状態の反映は
 *   Stripe Webhook（/api/stripe/webhook）経由でのみ行う（Phase 3 spec 9章）。
 */
function isValidPlan(value: unknown): value is Extract<Plan, "premium"> {
  return value === "premium";
}

export async function POST(request: Request) {
  // 課金システムがオフの間は、決済を受け付けない（src/lib/config/features.ts）
  if (!featureFlags.billing) {
    return NextResponse.json({ error: "現在、決済機能は提供していません。" }, { status: 404 });
  }

  // 他のサイトからのリクエスト（ログイン中のブラウザを使った不正な送信）を断る（工程39）
  const untrusted = rejectUntrustedOrigin(request, "stripe/checkout");
  if (untrusted) return untrusted;

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
      { error: "お申し込みできるのはプレミアムプランです。" },
      { status: 400 }
    );
  }

  if (!hasPriceIdFor(plan)) {
    return NextResponse.json(
      { error: `${plan}プランのPrice IDが設定されていません。管理者に環境変数の設定を確認してください。` },
      { status: 503 }
    );
  }

  // 支払い後の戻り先が仮の値・不正なら、決済を始めさせない（別のサイトへ戻されるのを防ぐ）
  const siteIssue = siteUrlIssue(siteConfig.url, process.env.NODE_ENV);
  if (siteIssue) {
    console.error("[stripe/checkout] site url is not ready:", siteIssue);
    return NextResponse.json(
      { error: "現在、お申し込みの受け付けを準備中です。しばらくしてから、もう一度お試しください。" },
      { status: 503 }
    );
  }

  // すでに契約がある人は、新しく申し込めない（契約が二重になり、二重に請求されるのを防ぐ）。
  // プランの変更・お支払い方法の変更は、アカウント画面の管理画面（Stripe）で行う。
  const current = await getServerPlan();
  if (hasOpenSubscription(current.subscription)) {
    return NextResponse.json(
      { error: "すでにご契約があります。お支払い方法の変更・解約は、アカウント画面から行ってください。" },
      { status: 409 }
    );
  }

  // 現在の利用規約・プライバシーポリシーへの同意が、サーバーに記録されているときだけ、決済に進める（工程38）。
  // 記録が読めないとき（準備が整っていないとき）は、同意を確認できないまま決済に進ませない。
  const consent = await getConsentState(user.id);
  if (!consent.ok) {
    return NextResponse.json({ error: CONSENT_UNAVAILABLE_MESSAGE }, { status: 503 });
  }
  if (consent.missing.length > 0) {
    return NextResponse.json({ error: CONSENT_REQUIRED_MESSAGE, code: "consent_required" }, { status: 403 });
  }

  // 表示している料金と、Stripeの実際の価格が一致しているときだけ、決済に進める
  const priceCheck = await verifyPremiumPrice();
  if (!priceCheck.ok) {
    console.error("[stripe/checkout] premium price check failed:", priceCheck.reason);
    return NextResponse.json(
      { error: "現在、お申し込みの受け付けを準備中です。しばらくしてから、もう一度お試しください。" },
      { status: 503 }
    );
  }

  try {
    const customerId = await getOrCreateStripeCustomerId(user.id, user.email);
    const stripe = getStripeClient();
    const priceId = stripeConfig.priceIds[plan];

    // 二重作成の防止（工程39）: Stripe上の最新の契約の確認、開いているCheckoutの再利用、冪等性キーつきの作成
    const result = await runCheckoutFlow(
      { customerId, userId: user.id, priceId, nowMs: Date.now() },
      {
        async hasOpenStripeSubscription(id) {
          const list = await stripe.subscriptions.list({ customer: id, status: "all", limit: 100 });
          return list.data.some((s) => isOpenSubscriptionStatus(s.status));
        },
        async findReusableSession(id, uid, price) {
          const list = await stripe.checkout.sessions.list({ customer: id, status: "open", limit: 10 });
          for (const candidate of list.data) {
            if (candidate.mode !== "subscription" || candidate.client_reference_id !== uid || !candidate.url) continue;
            // 価格が同じCheckoutだけを再利用する（価格の移行中に、古い価格のCheckoutを返さないため）
            const items = await stripe.checkout.sessions.listLineItems(candidate.id, { limit: 5 });
            if (items.data.some((li) => li.price?.id === price)) return { url: candidate.url };
          }
          return null;
        },
        createSession: (idempotencyKey) =>
          stripe.checkout.sessions.create(
            {
              mode: "subscription",
              customer: customerId,
              client_reference_id: user.id,
              line_items: [{ price: priceId, quantity: 1 }],
              success_url: `${siteConfig.url}/account?checkout=success`,
              cancel_url: `${siteConfig.url}/pricing?checkout=cancelled`,
              subscription_data: {
                metadata: { supabase_user_id: user.id, plan },
              },
              allow_promotion_codes: true,
            },
            { idempotencyKey },
          ),
      },
    );

    if (result.status === "already-subscribed") {
      return NextResponse.json(
        { error: "すでにご契約があります。お支払い方法の変更・解約は、アカウント画面から行ってください。" },
        { status: 409 }
      );
    }
    if (result.status === "error") {
      console.error("[stripe/checkout] checkout flow failed:", result.kind);
      return NextResponse.json(
        { error: result.kind === "no-url" ? "Checkoutセッションの作成に失敗しました。" : "決済ページの作成に失敗しました。しばらくしてから再度お試しください。" },
        { status: 502 }
      );
    }

    return NextResponse.json({ url: result.url });
  } catch (error) {
    console.error("[stripe/checkout]", error);
    return NextResponse.json(
      { error: "決済ページの作成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
