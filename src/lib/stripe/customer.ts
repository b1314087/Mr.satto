import "server-only";

import { getStripeClient } from "./client";
import { getSupabaseServiceClient } from "@/lib/supabase/service";

/**
 * 指定ユーザーのStripe Customer IDを取得する。無ければ新規作成し、
 * subscriptionsテーブルへ（user_id, stripe_customer_id）を保存してから返す。
 *
 * Phase 3 spec 8章「Stripe Customerを毎回無条件で新規作成するような実装は
 * 避けてください」に対応: 既存行があればそれをそのまま使う。
 *
 * subscriptionsテーブルへの書き込みはService Role Key経由でのみ許可している
 * （RLSにinsert/updateポリシーを設けていない。src/lib/supabase/service.tsの
 * コメント参照）。このため、呼び出し元（/api/stripe/checkout）で既にセッション
 * 検証済みのuserIdを渡してもらう前提で、ここではService Roleクライアントを使う。
 * userIdの出どころが必ず getCurrentUser() による検証済みセッションであることは
 * 呼び出し元が保証する。
 */
export async function getOrCreateStripeCustomerId(userId: string, email: string | null): Promise<string> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    throw new Error("Supabaseのservice role keyが設定されていないため、Stripe連携を利用できません。");
  }

  const { data: existing } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id as string;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { supabase_user_id: userId },
  });

  // upsert: 初回チェックアウトの場合はsubscriptions行がまだ存在しないため作成する。
  // plan/statusはまだ未確定（Checkout未完了）なのでnullのまま。
  const { error } = await supabase
    .from("subscriptions")
    .upsert({ user_id: userId, stripe_customer_id: customer.id }, { onConflict: "user_id" });

  if (error) {
    throw new Error(`Stripe Customer情報の保存に失敗しました: ${error.message}`);
  }

  return customer.id;
}
