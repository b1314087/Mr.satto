/**
 * Checkoutの作成の流れ（工程39）。サブスクリプションの二重作成を防ぐ。通信は依存（deps）として受け取るので、
 * Stripeに接続せずに単体テストできる。実際の依存の実装は src/app/api/stripe/checkout/route.ts にある。
 *
 * 二重作成が起きる経路と、それぞれの対策:
 *  1. 連続クリック・複数タブ・同時リクエスト → 同じユーザー・同じ価格・同じ時間枠のリクエストは、同じ冪等性キーで作成する
 *     （Stripeが、同じキーのリクエストに同じCheckout Sessionを返す）。さらに、すでに開いているCheckout Sessionがあれば、
 *     新しく作らずにそのURLを返す。
 *  2. 契約が成立した直後で、データベースへの反映（Webhook）が遅れている → Stripe上の最新の契約を確認し、続いている契約があれば作らない。
 *  3. 契約の確認に失敗したとき → 作らない（二重請求のおそれがあるので、安全側）。開いているCheckoutを探すのに失敗したときは、再利用せず、冪等性キーつきで作成に進む。
 * ブラウザ側のボタン無効化には依存しない。
 */

/** 同じリクエストを1つにまとめる時間枠（ミリ秒）。同時・連続の操作は、この間に起きる */
export const CHECKOUT_IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * 冪等性キー。ユーザー・価格・時間枠が同じなら同じ値になる（リクエストごとに無関係な値を作らない）。
 * 価格を含めるのは、同じキーで内容の違うリクエストをするとStripeがエラーにするため。
 */
export function checkoutIdempotencyKey(userId: string, priceId: string, nowMs: number): string {
  return `checkout-sub:${userId}:${priceId}:${Math.floor(nowMs / CHECKOUT_IDEMPOTENCY_WINDOW_MS)}`;
}

export interface CheckoutFlowDeps {
  /** Stripe上で、続いている（または支払い確認中の）契約があるか。通信の失敗は例外 */
  hasOpenStripeSubscription(customerId: string): Promise<boolean>;
  /** すでに開いている、同じユーザー・同じ価格のCheckout Session。無ければ null。通信の失敗は例外 */
  findReusableSession(customerId: string, userId: string, priceId: string): Promise<{ url: string } | null>;
  /** Checkout Sessionを作る（冪等性キーつき）。通信の失敗は例外 */
  createSession(idempotencyKey: string): Promise<{ url: string | null }>;
}

export type CheckoutFlowResult =
  | { status: "ok"; url: string; reused: boolean }
  | { status: "already-subscribed" }
  | { status: "error"; kind: "stripe-check" | "create" | "no-url" };

export async function runCheckoutFlow(
  input: { customerId: string; userId: string; priceId: string; nowMs: number },
  deps: CheckoutFlowDeps,
): Promise<CheckoutFlowResult> {
  // 契約の有無の確認は、二重請求を防ぐ中心の対策。確認できなければ、作らない（安全側）。
  try {
    if (await deps.hasOpenStripeSubscription(input.customerId)) return { status: "already-subscribed" };
  } catch {
    return { status: "error", kind: "stripe-check" };
  }

  // 開いているCheckoutの再利用は、重複を減らすための補助。探せなかったときは、再利用せずに、冪等性キーつきで作成に進む
  // （補助の失敗で、申し込み全体を止めない。同じ時間枠の重複は、冪等性キーが防ぐ）。
  try {
    const reusable = await deps.findReusableSession(input.customerId, input.userId, input.priceId);
    if (reusable) return { status: "ok", url: reusable.url, reused: true };
  } catch {
    /* 再利用できなかっただけ。作成に進む */
  }

  try {
    const session = await deps.createSession(checkoutIdempotencyKey(input.userId, input.priceId, input.nowMs));
    if (!session.url) return { status: "error", kind: "no-url" };
    return { status: "ok", url: session.url, reused: false };
  } catch {
    return { status: "error", kind: "create" };
  }
}
