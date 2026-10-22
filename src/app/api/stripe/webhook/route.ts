import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe/client";
import { getPlanMapping, isStripeWebhookConfigured, stripeConfig } from "@/lib/stripe/config";
import { syncSubscription, type SubscriptionRow, type SubscriptionStore } from "@/lib/stripe/subscription-sync";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { featureFlags } from "@/lib/config/features";

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
 *
 * 機能スイッチ（src/lib/config/features.ts の featureFlags.billing）がオフの間は、何も処理しない。
 * 受け取った内容は読まず、データベースにも触れず、Stripeへは200だけ返す（失敗扱いで再送され続けるのを防ぐ）。
 * 課金を再開するときは billing を true に戻す。オフにする前に、実際に契約している方がいないことを確認しておくこと。
 */
export async function POST(request: Request) {
  if (!featureFlags.billing) {
    return NextResponse.json({ received: true, ignored: true });
  }

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
    // 処理に失敗したイベントは「処理済み」に残さない。残すと、Stripeが再送しても重複として無視され、
    // 契約状態が更新されないままになる。
    await supabase.from("stripe_webhook_events").delete().eq("event_id", event.id);
    return NextResponse.json({ error: "イベント処理に失敗しました。" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

/** subscriptions テーブルの読み書き（純粋な同期処理 src/lib/stripe/subscription-sync.ts に渡す） */
function createSubscriptionStore(supabase: NonNullable<ReturnType<typeof getSupabaseServiceClient>>): SubscriptionStore {
  return {
    async findByCustomer(customerId) {
      const { data } = await supabase.from("subscriptions").select("plan").eq("stripe_customer_id", customerId).maybeSingle();
      return data ? { plan: (data.plan as string | null) ?? null } : null;
    },
    async updateIfNotNewer(customerId, row: SubscriptionRow) {
      // 取得時刻がこの行より古い結果では上書きしない（古いイベントによる状態の巻き戻しを防ぐ）
      const { data, error } = await supabase
        .from("subscriptions")
        .update(row)
        .eq("stripe_customer_id", customerId)
        .or(`stripe_synced_at.is.null,stripe_synced_at.lte.${row.stripe_synced_at}`)
        .select("user_id");
      if (!error) return (data?.length ?? 0) > 0;
      // 0003_ai_usage_ledger.sql を適用する前（新しい列が無い）は、従来の列だけで更新する
      if (error.code === "42703" || error.code === "PGRST204") {
        const legacy = {
          stripe_subscription_id: row.stripe_subscription_id,
          plan: row.plan,
          status: row.status,
          current_period_end: row.current_period_end,
          cancel_at_period_end: row.cancel_at_period_end,
        };
        const { error: legacyError } = await supabase.from("subscriptions").update(legacy).eq("stripe_customer_id", customerId);
        if (legacyError) throw new Error(`subscriptions upsert failed: ${legacyError.message}`);
        console.warn("[stripe webhook] new subscriptions columns are missing; applied legacy columns only");
        return true;
      }
      throw new Error(`subscriptions upsert failed: ${error.message}`);
    },
  };
}

/**
 * Stripeの最新のSubscriptionを取得して、subscriptions テーブルへ反映する。
 * イベントの本文は使わない（順序が前後した古い本文で、新しい状態を上書きしないため）。
 * 取得に失敗したら例外を投げ、Stripeに再送させる。ただし、契約がすでに存在しない（resource_missing）ときだけは、
 * 削除イベントの本文（解約済みの状態）をそのまま使う。
 */
async function syncLatestSubscription(subscriptionId: string, stripe: Stripe, fallback?: Stripe.Subscription): Promise<void> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return;

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (fallback && (error as { code?: string }).code === "resource_missing") subscription = fallback;
    else throw error;
  }
  const retrievedAtIso = new Date().toISOString();

  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const outcome = await syncSubscription({
    store: createSubscriptionStore(supabase),
    customerId,
    subscription,
    mapping: getPlanMapping(),
    retrievedAtIso,
    onUnknownPrice: (priceId) => console.error(`[stripe webhook] unknown price ${priceId ?? "(none)"}; kept the existing plan`),
  });
  if (outcome === "no-row") {
    // 通常のCheckoutフロー（/api/stripe/checkout）では必ず先にCustomerが subscriptions に登録されているため、
    // ここに来るのは想定外（Stripeダッシュボードから直接作成されたCustomer等）。user_idが分からないため書き込めない。
    console.error(`[stripe webhook] no subscriptions row for stripe_customer_id=${customerId}; skipping sync`);
  }
}

async function syncFromInvoiceOrSession(subscriptionRef: string | Stripe.Subscription | null | undefined, stripe: Stripe): Promise<void> {
  if (!subscriptionRef) return;
  const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef.id;
  await syncLatestSubscription(subscriptionId, stripe);
}

async function handleEvent(event: Stripe.Event, stripe: Stripe): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      await syncLatestSubscription(subscription.id, stripe, subscription);
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
