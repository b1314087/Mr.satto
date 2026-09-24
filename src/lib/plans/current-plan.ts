import "server-only";

import { cookies } from "next/headers";
import type { Plan } from "./types";
import { getCurrentUser } from "@/lib/auth/user";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { checkTemporaryAccess } from "./temporary-access-actions";

/**
 * 現在のユーザーのプランを取得する唯一の窓口（Phase 3: サーバー側プラン判定）。
 *
 * 重要：「ユーザー状態」（Guest / ログイン済み。src/lib/auth/user.ts）と
 * 「料金プラン」（free / standard / premium）は別概念として扱う。
 * ただしGuestは仕様上必ずfreeプランとして扱うため、この関数の中で
 * その対応付けだけを行う（Guest = free、という関係をここに閉じ込め、
 * 他の場所で「ログインしていない ≒ free」という判定を重複させない）。
 *
 * Phase 3以降、このファイルは "server-only" になった。
 * ブラウザのlocalStorage等、クライアントが自由に書き換えられる値を
 * plan判定の根拠にすることは、Phase 3の最優先方針
 * （「課金状態をブラウザだけで偽装できないこと」）に反するため廃止した。
 *
 * 判定ルール（Phase 3 spec 12章）：
 *   Guest                              -> free
 *   Authenticated + Standard契約有効     -> standard
 *   Authenticated + Premium契約有効      -> premium
 *   Authenticated だが有効な契約なし      -> free
 *
 * 「契約有効」はStripe Subscription statusが active / trialing であることを指す
 * （解約手続き中でも期間終了までは active のままなので、そのまま契約を維持できる。
 * Phase 3 spec 13章「Stripeの実際の契約終了時期を尊重する」に対応）。
 *
 * このモジュールはServer Component / Route Handler / Server Actionからのみ
 * 呼び出せる。クライアントコンポーネントは、Server Componentが解決した結果を
 * props経由で受け取ること（例: src/app/tools/[tool]/page.tsx ->
 * src/components/tools/tool-access-gate.tsx）。
 */

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export interface SubscriptionSnapshot {
  plan: Exclude<Plan, "free">;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface ServerPlanContext {
  plan: Plan;
  userId: string | null;
  userEmail: string | null;
  /** DB上の契約行（未契約・未ログインの場合はnull） */
  subscription: SubscriptionSnapshot | null;
  /** Freeユーザーのリワード広告による一時利用権が現在有効か */
  temporaryAccessActive: boolean;
  temporaryAccessExpiresAtMs: number | null;
  /** development環境のプラン上書きが適用されているか（本番では常にfalse） */
  isDevOverride: boolean;
}

/**
 * development環境専用のプラン上書きに使うCookie名。
 *
 * 使い方（開発者のブラウザのコンソールで実行。開発サーバーでのみ有効）:
 *   document.cookie = "mrsatto-dev-plan-override=premium; path=/"
 *   document.cookie = "mrsatto-dev-plan-override=; path=/; max-age=0" // 解除
 *
 * 本番ビルド（NODE_ENV !== "development"）ではこのCookieの値を一切見ない。
 * 「developmentだから権限無制限」という分岐を本番へ持ち込まないための、
 * NODE_ENVチェックを最初に行うガード（Phase 3 spec 27章）。
 */
export const DEV_PLAN_OVERRIDE_COOKIE = "mrsatto-dev-plan-override";

function isPlan(value: string | undefined): value is Plan {
  return value === "free" || value === "standard" || value === "premium";
}

async function getDevPlanOverride(): Promise<Plan | null> {
  if (process.env.NODE_ENV !== "development") return null;
  const cookieStore = await cookies();
  const raw = cookieStore.get(DEV_PLAN_OVERRIDE_COOKIE)?.value;
  return isPlan(raw) ? raw : null;
}

export async function getServerPlan(): Promise<ServerPlanContext> {
  const devOverride = await getDevPlanOverride();
  if (devOverride) {
    return {
      plan: devOverride,
      userId: null,
      userEmail: null,
      subscription: null,
      temporaryAccessActive: false,
      temporaryAccessExpiresAtMs: null,
      isDevOverride: true,
    };
  }

  const user = await getCurrentUser();

  if (!user) {
    // Guest は仕様上必ず free。Standard対象ツールはTemporary Accessで判定する。
    const temp = await checkTemporaryAccess();
    return {
      plan: "free",
      userId: null,
      userEmail: null,
      subscription: null,
      temporaryAccessActive: temp.active,
      temporaryAccessExpiresAtMs: temp.expiresAtMs,
      isDevOverride: false,
    };
  }

  const subscription = await fetchSubscriptionSnapshot(user.id);
  const hasActiveSubscription =
    subscription !== null && ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status);
  const effectivePlan: Plan = hasActiveSubscription ? subscription.plan : "free";

  // 認証済みだが契約が無い(free相当の)ユーザーにも、Freeユーザーとして
  // Temporary Accessを適用する（Phase 3 spec 4章：「Standard会員/Premium会員には
  // 不要」なだけで、認証済みfreeユーザーを排除する仕様ではない）。
  const temp =
    effectivePlan === "free" ? await checkTemporaryAccess() : { active: false, expiresAtMs: null };

  return {
    plan: effectivePlan,
    userId: user.id,
    userEmail: user.email,
    subscription,
    temporaryAccessActive: temp.active,
    temporaryAccessExpiresAtMs: temp.expiresAtMs,
    isDevOverride: false,
  };
}

async function fetchSubscriptionSnapshot(userId: string): Promise<SubscriptionSnapshot | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan, status, current_period_end, cancel_at_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data || !data.plan || !data.status) return null;

  return {
    plan: data.plan as Exclude<Plan, "free">,
    status: data.status as string,
    currentPeriodEnd: data.current_period_end as string | null,
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
  };
}
