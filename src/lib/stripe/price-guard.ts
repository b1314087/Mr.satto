/**
 * 「画面に出している料金」と「Stripeで実際に請求される料金」が食い違ったまま、決済を受け付けないための確認。
 *
 * 表示する料金は PREMIUM_PRICE_YEN（src/lib/plans/types.ts）の1か所で決まる。
 * 決済に使うPrice IDの中身（金額・通貨・請求の周期）が、それと一致している場合だけ、Checkoutを作る。
 * 一致しない場合（例: Price IDがまだ旧980円のまま）は、課金せず「準備中」にする。
 *
 * このファイルは純粋な判定だけを持つ（通信は src/lib/stripe/price-guard-server.ts）。
 */

/** Stripeの Price のうち、確認に使う部分だけ */
export interface PriceLike {
  active?: boolean | null;
  currency?: string | null;
  unit_amount?: number | null;
  type?: string | null;
  recurring?: { interval?: string | null; interval_count?: number | null; usage_type?: string | null } | null;
}

export type PriceCheck = { ok: true } | { ok: false; reason: "inactive" | "currency" | "amount" | "not_monthly" | "not_found" };

/** 円は小数を持たない通貨なので、Stripeの unit_amount はそのまま円の金額になる */
export function checkPremiumPrice(price: PriceLike | null | undefined, expectedYen: number): PriceCheck {
  if (!price) return { ok: false, reason: "not_found" };
  if (price.active === false) return { ok: false, reason: "inactive" };
  if ((price.currency ?? "").toLowerCase() !== "jpy") return { ok: false, reason: "currency" };
  if (price.unit_amount !== expectedYen) return { ok: false, reason: "amount" };
  const r = price.recurring;
  if (price.type !== "recurring" || !r || r.interval !== "month" || (r.interval_count ?? 1) !== 1 || (r.usage_type ?? "licensed") !== "licensed") {
    return { ok: false, reason: "not_monthly" };
  }
  return { ok: true };
}
