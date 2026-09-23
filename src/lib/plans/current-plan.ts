import type { Plan } from "./types";

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
 * ログイン・決済（Stripe / Supabase）は未実装のため、現時点では常に "free" を返す
 * （development環境でのみ、開発者本人のブラウザに限りローカル上書きが可能）。
 *
 * 将来、この関数の中身だけを
 *   - ログインユーザー情報
 *   - Stripe subscription
 *   - Supabase DB のサブスクリプション状態
 * などへ差し替えれば、呼び出し側（ToolAccessGate 等）を一切変更せずに
 * 実際のプラン判定へ移行できる。呼び出し側は必ずこの関数経由でプランを取得し、
 * プラン文字列を直接ハードコードしないこと。
 */
export function getCurrentPlan(): Plan {
  return getDevPlanOverride() ?? "free";
}
