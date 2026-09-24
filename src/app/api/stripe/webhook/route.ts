import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe/client";
import { isStripeWebhookConfigured, stripeConfig } from "@/lib/stripe/config";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import type { Plan } from "@/lib/plans/types";

/**
 * Stripe Webhook ハンドラ。
 *
 * 正式な契約状態の情報源はここ（Webhook）であり、Checkout成功ページを
 * 見ただけではPremium/Standard扱いにしない（Phase 3 spec 9章）。
 *
 * 冪等性：event.id を stripe_webhook_events テーブルへ先にinsertし、
 * 一意制約違反（＝処理済みイベントの再送）ならそのまま200を返して
 * 二重処理をスキップする（Phase 3 spec 10章）。
 *
 * 署名検証：stripe-signatureヘッダーとSTRIPE_WEBHOOK_SECRETで必ず検証する。
 * 検証に失敗したリクエストは400で拒否し、Supabaseへの書き込みは一切行わない。
 */
export async function POST(request: Request) {
  if (!isStripeWebhookConfigured()) {
    // Webhook Secret未設定の環境で誤って署名検証をスキップして処理することは
    // しない（なりすましリクエストを無条件で信用することになるため）。
    return NextResponse.json(
      { error: "Webhookが設定されていません（STRIPE_WEBHOOK_SECRET未設定）。" },
      { status: 503 }
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "署名ヘッダーがありません。" }, { status: 400 });
  }

  const rawBody = await request.text();
  const stripe = getStripeClient();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, stripeConfig.webhookSecret);
  } catch (error) {
    console.error("[stripe webhook] signature verification failed", error);
    return NextResponse.json({ error: "署名の検証に失敗しました。" }, { status: 400 });
  }

  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    console.error("[stripe webhook] Supabase service role client is not configured");
    return NextResponse.json({ error: "サーバー側の設定が不足しています。" }, { status: 503 });
  }

  // 冪等性の確保: 既に処理済みのevent.idなら何もせず200を返す。
  const { error: insertError } = await supabase
    .from("stripe_webhook_events")
    .insert({ event_id: event.id, event_type: event.type });

  if (insertError) {
    // 一意制約違反 = 処理済みイベントの再送。二重処理を避けてそのまま200。
    if (insertError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[stripe webhook] failed to record event", insertError);
    return NextResponse.json({ error: "イベント記録に失敗しました。" }, { status: 500 });
  }

  try {
    await handleEvent(event, stripe);
  } catch (error) {
    console.error(`[stripe webhook] failed to handle ${event.type}`, error);
    return NextResponse.json({ error: "イベント処理に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

function resolvePlanFromPriceId(priceId: string | null | undefined): Exclude<Plan, "free"> | null {
  if (!priceId) return null;
  if (priceId === stripeConfig.priceIds.standard) return "standard";
  if (priceId === stripeConfig.priceIds.premium) return "premium";
  return null;
}

/**
 * Stripeの現在のSubscription状態をそのままsubscriptionsテーブルへ反映する。
 * customer.subscription.created/updated/deleted はいずれも
 * event.data.object が「その時点の最新Subscription」であるため、
 * このひとつの関数で全て同じロジックで同期できる
 * （deletedの場合はstatusが既にcanceledになった状態で届く）。
 */
async function upsertSubscriptionFromStripe(subscription: Stripe.Subscription): Promise<void> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return;

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  const { data: existing } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (!existing) {
    // 通常のCheckoutフロー（/api/stripe/checkout）では必ず先にCustomerが
    // subscriptionsテーブルへ登録されているため、ここに来るのは想定外
    // （Stripeダッシュボードから直接作成されたCustomer等）。
    // user_idが分からないため書き込めない旨をログに残すに留める。
    console.error(
      `[stripe webhook] no subscriptions row for stripe_customer_id=${customerId}; skipping sync`
    );
    return;
  }

  const item = subscription.items.data[0];
  const priceId = item?.price?.id ?? null;
  const plan = resolvePlanFromPriceId(priceId);
  const periodEndUnix = item?.current_period_end ?? null;

  const { error } = await supabase
    .from("subscriptions")
    .update({
      stripe_subscription_id: subscription.id,
      plan,
      status: subscription.status,
      current_period_end: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    })
    .eq("stripe_customer_id", customerId);

  if (error) {
    throw new Error(`subscriptions upsert failed: ${error.message}`);
  }
}

async function syncFromInvoiceOrSession(subscriptionRef: string | Stripe.Subscription | null | undefined, stripe: Stripe): Promise<void> {
  if (!subscriptionRef) return;
  const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef.id;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await upsertSubscriptionFromStripe(subscription);
}

async function handleEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await upsertSubscriptionFromStripe(subscription);
      break;
    }

    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await syncFromInvoiceOrSession(session.subscription, stripe);
      break;
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? null;
      await syncFromInvoiceOrSession(subscriptionRef, stripe);
      break;
    }

    default:
      // 未対応のイベントは無視する（stripe_webhook_eventsへの記録は既に完了している）。
      break;
  }
}
