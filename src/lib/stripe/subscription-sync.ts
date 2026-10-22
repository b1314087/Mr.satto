/**
 * Stripeの契約（Subscription）を、subscriptions テーブルの1行に変換する純粋な処理。
 * 通信やデータベースは持たない（Webhookのルートが、取得した最新のSubscriptionをここへ渡す）。
 *
 * 方針（料金体系の統一: Free / Premium 1,100円）:
 * - プランは「旧価格か新価格か」ではなく、Premiumの商品（Product）または登録済みの価格（Price）に当たるかで決める。
 *   旧980円と新1,100円は、どちらもPremiumとして同じに扱う。
 * - 知らない価格を受け取っても、プランを null にして権限を外したりはしない。いまのプランをそのまま残し、
 *   契約の状態（status）・期間・解約予定は、Stripeの最新の状態で更新する。
 *   → 権限は status（active/trialing のときだけ有効）で決まるため、解約・支払い失敗・期限切れで権限が残り続けることはない。
 * - 契約の価格を替えても、請求期間（開始・終了）は変わらないので、AI利用枠の期間はリセットされない。
 */

/** SubscriptionItem のうち、使う部分だけ（Stripe.SubscriptionItem はこの形に当てはまる） */
export interface SubscriptionItemLike {
  price?: { id?: string | null; product?: string | { id?: string | null } | null } | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
}

export interface SubscriptionLike {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  items: { data: SubscriptionItemLike[] };
}

export interface PlanMapping {
  /** Premium専用であることを確認したProduct ID（任意）。設定すると、その商品の価格はすべてPremiumになる */
  premiumProductIds: string[];
  /** Premiumとして扱うPrice ID（現在の価格と、移行期間だけ残す旧価格） */
  premiumPriceIds: string[];
  /** Standard（新料金体系には含めない。既存契約の表示が壊れないよう、判定だけ残す） */
  standardPriceIds: string[];
}

export type PaidPlan = "standard" | "premium";

export function productIdOf(item: SubscriptionItemLike): string | null {
  const product = item.price?.product;
  if (!product) return null;
  return typeof product === "string" ? product : (product.id ?? null);
}

/** 契約のアイテムから有料プランを決める。どれにも当たらなければ null（知らない価格） */
export function resolvePlanFromItems(items: SubscriptionItemLike[], mapping: PlanMapping): PaidPlan | null {
  let standard = false;
  for (const item of items) {
    const priceId = item.price?.id ?? null;
    const productId = productIdOf(item);
    if ((priceId && mapping.premiumPriceIds.includes(priceId)) || (productId && mapping.premiumProductIds.includes(productId))) return "premium";
    if (priceId && mapping.standardPriceIds.includes(priceId)) standard = true;
  }
  return standard ? "standard" : null;
}

export interface SubscriptionRow {
  stripe_subscription_id: string;
  plan: PaidPlan | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_price_id: string | null;
  stripe_synced_at: string;
}

const toIso = (unix: number | null | undefined): string | null =>
  typeof unix === "number" && Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : null;

export function buildSubscriptionRow(
  subscription: SubscriptionLike,
  existingPlan: string | null,
  mapping: PlanMapping,
  retrievedAtIso: string,
): { row: SubscriptionRow; unknownPrice: boolean } {
  const items = subscription.items.data;
  const item = items[0];
  const resolved = resolvePlanFromItems(items, mapping);
  const unknownPrice = resolved === null && items.length > 0;
  // 知らない価格のときは、いまのプランをそのまま残す（権限は status で決まる）
  const plan: PaidPlan | null = resolved ?? (existingPlan === "premium" || existingPlan === "standard" ? existingPlan : null);
  return {
    unknownPrice,
    row: {
      stripe_subscription_id: subscription.id,
      plan,
      status: subscription.status,
      current_period_start: toIso(item?.current_period_start),
      current_period_end: toIso(item?.current_period_end),
      cancel_at_period_end: subscription.cancel_at_period_end,
      stripe_price_id: item?.price?.id ?? null,
      stripe_synced_at: retrievedAtIso,
    },
  };
}

/** 環境変数の値（カンマ区切り）をIDの配列にする */
export function parseIdList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** subscriptions テーブルの読み書き（Webhookのルートが実装を渡す。テストでは差し替える） */
export interface SubscriptionStore {
  findByCustomer(customerId: string): Promise<{ plan: string | null } | null>;
  /** stripe_synced_at が、渡した時刻より古い（または未設定の）ときだけ更新する。更新したら true */
  updateIfNotNewer(customerId: string, row: SubscriptionRow): Promise<boolean>;
}

export type SyncOutcome = "updated" | "stale" | "no-row";

/**
 * 最新の契約状態を保存する。古い取得結果で、新しい状態を上書きしない（古いWebhookイベントの巻き戻し防止）。
 * 取得時刻 retrievedAtIso は、Stripeから契約を取得し終えた直後の時刻を渡す。
 */
export async function syncSubscription(args: {
  store: SubscriptionStore;
  customerId: string;
  subscription: SubscriptionLike;
  mapping: PlanMapping;
  retrievedAtIso: string;
  onUnknownPrice?: (priceId: string | null) => void;
}): Promise<SyncOutcome> {
  const existing = await args.store.findByCustomer(args.customerId);
  if (!existing) return "no-row";
  const { row, unknownPrice } = buildSubscriptionRow(args.subscription, existing.plan, args.mapping, args.retrievedAtIso);
  if (unknownPrice) args.onUnknownPrice?.(row.stripe_price_id);
  const updated = await args.store.updateIfNotNewer(args.customerId, row);
  return updated ? "updated" : "stale";
}
