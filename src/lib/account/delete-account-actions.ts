"use server";

import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUser } from "@/lib/auth/user";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { supabaseConfig } from "@/lib/supabase/config";
import { getStripeClient } from "@/lib/stripe/client";
import { isStripeConfigured } from "@/lib/stripe/config";
import { isOpenSubscriptionStatus } from "@/lib/plans/effective-plan";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { runDeleteAccount, DELETE_ACCOUNT_MESSAGES, type DeleteAccountDeps } from "./delete-account";

/**
 * アカウント削除（Server Action）。本人だけが、自分のアカウントを削除できる。
 * 対象のユーザーIDは、フォームから受け取らず、検証済みのセッション（getCurrentUser）から得る。
 * 判断の流れは delete-account.ts（単体テスト済み）。ここは、その通信の部分（Supabase・Stripe）の実装。
 *
 * Stripe側のCustomer・支払い記録は、この処理では削除しない（税務・会計上の保存や、不正対策のために
 * 保存が必要な場合があるため。運営者の方針が確定するまで触らない）。
 */
export interface DeleteAccountActionState {
  error?: string;
}

const DELETE_RATE_LIMIT = { limit: 5, windowMs: 10 * 60_000 };

function buildDeps(): DeleteAccountDeps {
  return {
    getCurrentUser,
    isRateLimited: (userId) => checkRateLimit(`delete-account:${userId}`, DELETE_RATE_LIMIT).limited,

    // 再認証: ログイン状態（Cookie）を変えないよう、保存しない一時的なクライアントでパスワードを確認する。
    async verifyPassword(email, password) {
      const client = createClient(supabaseConfig.url, supabaseConfig.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (!error) return true;
      // 認証情報の誤り（400台）は「パスワード違い」。それ以外（通信・サーバーの障害）は例外にして「確認できない」とする。
      if (error.status !== undefined && error.status >= 400 && error.status < 500) return false;
      throw new Error("password-check-unavailable");
    },

    async getStoredSubscription(userId) {
      const service = getSupabaseServiceClient();
      if (!service) throw new Error("service-client-unavailable");
      const { data, error } = await service
        .from("subscriptions")
        .select("status, stripe_customer_id, stripe_subscription_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error("subscription-read-failed");
      if (!data) return null;
      return {
        status: (data.status as string | null) ?? null,
        stripeCustomerId: (data.stripe_customer_id as string | null) ?? null,
        stripeSubscriptionId: (data.stripe_subscription_id as string | null) ?? null,
      };
    },

    async checkStripeOpenSubscriptions(customerId) {
      if (!isStripeConfigured()) return "unverifiable";
      const stripe = getStripeClient();
      const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      return list.data.some((s) => isOpenSubscriptionStatus(s.status)) ? "open" : "none";
    },

    async expireOpenCheckoutSessions(customerId) {
      const stripe = getStripeClient();
      const sessions = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 100 });
      for (const s of sessions.data) await stripe.checkout.sessions.expire(s.id);
    },

    async deleteUser(userId) {
      const service = getSupabaseServiceClient();
      if (!service) throw new Error("service-client-unavailable");
      const { error } = await service.auth.admin.deleteUser(userId);
      if (!error) return "deleted";
      if (error.status === 404 || (error as { code?: string }).code === "user_not_found") return "not-found";
      throw new Error("delete-user-failed");
    },

    async signOut() {
      const supabase = await getSupabaseServerClient();
      if (supabase) await supabase.auth.signOut({ scope: "local" });
    },

    log(event, detail) {
      // 識別子と種類だけを記録する。メールアドレス・パスワード・トークンは含めない。
      console.info("[account-delete]", event, detail);
    },
  };
}

export async function deleteAccountAction(
  _prev: DeleteAccountActionState,
  formData: FormData,
): Promise<DeleteAccountActionState> {
  const result = await runDeleteAccount(
    {
      confirmation: String(formData.get("confirmation") ?? ""),
      password: String(formData.get("password") ?? ""),
    },
    buildDeps(),
  );

  if (result.status === "deleted") redirect("/account/deleted");
  if (result.code === "unauthenticated") redirect("/login?next=/account/delete");
  return { error: result.message ?? DELETE_ACCOUNT_MESSAGES.failed };
}
