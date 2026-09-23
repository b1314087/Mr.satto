import type { Plan } from "./types";
import { getCurrentUser } from "@/lib/auth/user";

/**
 * localStorage に保存する開発用プラン上書きのキー。
 * development ビルドでのみ参照される（本番ビルドでは一切見ない）。
 *
 * 使い方（開発者のブラウザのコンソールで実行）:
 *   localStorage.setItem("mrsatto:dev-plan-override", "premium")
 *   localStorage.removeItem("mrsatto:dev-plan-override") // 解除
 */
export const DEV_PLAN_OVERRIDE_KEY = "mrsatto:dev-plan-override";

function isPlan(value: string | null): value is Plan {
  return value === "free" || value === "standard" || value === "premium";
}

/**
 * development 環境かつブラウザ実行時のみ、localStorage の上書き値を返す。
 *
 * - NEXT_PUBLIC_ 等の公開環境変数は使わない
 *   （クライアントバンドルに焼き込まれ、誰でも書き換えられるため使わない）。
 * - 本番ビルド（NODE_ENV !== "development"）では常に null を返し、
 *   一般ユーザーが自分でpremiumへ昇格できるような入口を作らない。
 */
function getDevPlanOverride(): Plan | null {
  if (process.env.NODE_ENV !== "development") return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEV_PLAN_OVERRIDE_KEY);
    return isPlan(raw) ? raw : null;
  } catch {
    // localStorageが利用できない環境（プライベートブラウズ等）では無視する
    return null;
  }
}

/**
 * 現在のユーザーのプランを取得する唯一の窓口。
 *
 * 重要：「ユーザー状態」（Guest / ログイン済み。src/lib/auth/user.ts）と
 * 「料金プラン」（free / standard / premium）は別概念として扱う。
 * ただしGuestは仕様上必ずfreeプランとして扱うため、この関数の中で
 * その対応付けだけを行う（Guest = free、という関係をここに閉じ込め、
 * 他の場所で「ログインしていない ≒ free」という判定を重複させない）。
 *
 * - Guest（未ログイン）        -> 常に "free"
 * - 認証済みユーザー           -> 本来は契約プランを返すべきだが、
 *                                Stripe/Supabase等の決済・認証基盤が
 *                                未実装のため、現時点では便宜上 "free" を返す。
 *                                将来この分岐に、ログイン済みだが無料・
 *                                契約期限切れ・解約後の猶予期間なども含めた
 *                                実際のプラン判定を実装する。
 *
 * development環境でのみ、開発者本人のブラウザに限りローカル上書きが可能。
 * 将来、認証済みユーザーのプラン取得部分だけを
 *   - Stripe subscription
 *   - Supabase DB のサブスクリプション状態
 * などへ差し替えれば、呼び出し側（ToolAccessGate 等）を一切変更せずに
 * 実際のプラン判定へ移行できる。呼び出し側は必ずこの関数経由でプランを取得し、
 * プラン文字列を直接ハードコードしないこと。
 */
export function getCurrentPlan(): Plan {
  const devOverride = getDevPlanOverride();
  if (devOverride) return devOverride;

  const user = getCurrentUser();
  if (user === null) {
    // Guestは仕様上必ずfree
    return "free";
  }

  // TODO(将来): 認証済みユーザーの実際の契約プランを
  // Stripe subscription / Supabase DB 等から取得して返す。
  // 現時点では認証自体が存在しないため、この分岐には到達しない。
  return "free";
}
