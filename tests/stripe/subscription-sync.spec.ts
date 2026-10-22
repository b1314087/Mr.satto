import { test, expect } from "@playwright/test";
import {
  buildSubscriptionRow,
  parseIdList,
  resolvePlanFromItems,
  syncSubscription,
  type PlanMapping,
  type SubscriptionLike,
  type SubscriptionRow,
  type SubscriptionStore,
} from "@/lib/stripe/subscription-sync";
import { hasOpenSubscription, resolveEffectivePlan } from "@/lib/plans/effective-plan";

const OLD_PRICE = "price_old980";
const NEW_PRICE = "price_new1100";
const PRODUCT = "prod_premium";
const MAPPING: PlanMapping = { premiumProductIds: [PRODUCT], premiumPriceIds: [NEW_PRICE, OLD_PRICE], standardPriceIds: ["price_std550"] };
const MAPPING_PRICES_ONLY: PlanMapping = { premiumProductIds: [], premiumPriceIds: [NEW_PRICE, OLD_PRICE], standardPriceIds: [] };

const PERIOD = { start: 1_790_000_000, end: 1_792_592_000 };

function sub(priceId: string, over: Partial<SubscriptionLike> = {}, productId: string | { id: string } = "prod_other"): SubscriptionLike {
  return {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: priceId, product: productId }, current_period_start: PERIOD.start, current_period_end: PERIOD.end }] },
    ...over,
  };
}

class FakeStore implements SubscriptionStore {
  row: (SubscriptionRow & { user_id: string }) | null = null;
  plan: string | null = "premium";
  writes = 0;
  constructor(public existingPlan: string | null = "premium") {
    this.plan = existingPlan;
  }
  async findByCustomer() {
    return { plan: this.plan };
  }
  async updateIfNotNewer(_c: string, row: SubscriptionRow) {
    if (this.row && this.row.stripe_synced_at > row.stripe_synced_at) return false;
    this.row = { ...row, user_id: "u" };
    this.plan = row.plan;
    this.writes++;
    return true;
  }
}

test.describe("契約の価格 → プランの判定", () => {
  test("旧980円・新1,100円のどちらも、同じPremiumになる", () => {
    expect(resolvePlanFromItems(sub(OLD_PRICE).items.data, MAPPING_PRICES_ONLY)).toBe("premium");
    expect(resolvePlanFromItems(sub(NEW_PRICE).items.data, MAPPING_PRICES_ONLY)).toBe("premium");
  });

  test("Product IDで判定する: 同じ商品の下の価格はすべてPremium（価格IDを登録しなくてよい）", () => {
    expect(resolvePlanFromItems(sub("price_any_future", {}, PRODUCT).items.data, MAPPING)).toBe("premium");
    expect(resolvePlanFromItems(sub("price_any_future", {}, { id: PRODUCT }).items.data, MAPPING)).toBe("premium");
  });

  test("他の用途の商品は、Premiumにしない（Product ID・Price IDのどちらにも当たらない）", () => {
    expect(resolvePlanFromItems(sub("price_donation", {}, "prod_donation").items.data, MAPPING)).toBeNull();
  });

  test("Standardの価格は standard（新料金体系には含めないが、既存契約の判定は壊さない）", () => {
    expect(resolvePlanFromItems(sub("price_std550").items.data, MAPPING)).toBe("standard");
  });

  test("複数アイテムでPremiumがあれば premium", () => {
    const items = [...sub("price_std550").items.data, ...sub(NEW_PRICE).items.data];
    expect(resolvePlanFromItems(items, MAPPING)).toBe("premium");
  });

  test("環境変数のIDリストを読む（空・空白・カンマ区切り）", () => {
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList(" a , b,,c ")).toEqual(["a", "b", "c"]);
  });
});

test.describe("価格の移行・知らない価格・契約状態", () => {
  test("価格を旧→新に替えても、請求期間(開始・終了)は変わらない = AI利用期間がリセットされない", () => {
    const before = buildSubscriptionRow(sub(OLD_PRICE), "premium", MAPPING_PRICES_ONLY, "2026-10-22T00:00:00.000Z").row;
    const after = buildSubscriptionRow(sub(NEW_PRICE), "premium", MAPPING_PRICES_ONLY, "2026-10-23T00:00:00.000Z").row;
    expect(after.current_period_start).toBe(before.current_period_start);
    expect(after.current_period_end).toBe(before.current_period_end);
    expect(after.plan).toBe("premium");
    expect(after.stripe_price_id).toBe(NEW_PRICE);
  });

  test("知らない価格は、有料プランにしない（plan = null）。もともとPremiumでも引き継がず、unknownPriceを知らせる", () => {
    for (const existing of ["premium", "standard", null]) {
      const { row, unknownPrice } = buildSubscriptionRow(sub("price_unregistered_1100"), existing, MAPPING_PRICES_ONLY, "2026-10-22T00:00:00.000Z");
      expect(unknownPrice).toBe(true);
      expect(row.plan, String(existing)).toBeNull();
      expect(row.status).toBe("active"); // 契約が続いていること自体は記録する（二重の申し込みを防ぐため）
    }
  });

  test("知らない価格の有効な契約は、権限なし(Free)だが、続いている契約としては扱う（二重のCheckoutを作らせない）", () => {
    const snapshot = { plan: null, status: "active", currentPeriodEnd: "2026-11-22T00:00:00.000Z", cancelAtPeriodEnd: false } as const;
    expect(resolveEffectivePlan(snapshot)).toBe("free");
    expect(hasOpenSubscription(snapshot)).toBe(true);
  });

  test("知らない価格で、もともとプランが無い契約は、プランなしのまま（勝手にPremiumにしない）", () => {
    const { row } = buildSubscriptionRow(sub("price_unregistered"), null, MAPPING_PRICES_ONLY, "2026-10-22T00:00:00.000Z");
    expect(row.plan).toBeNull();
  });

  test("知らない価格でも、契約の状態は最新に更新する: 解約・支払い失敗ならプランが残っていても権限は無い", () => {
    for (const status of ["canceled", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      const { row } = buildSubscriptionRow(sub("price_unregistered", { status }), "premium", MAPPING_PRICES_ONLY, "2026-10-22T00:00:00.000Z");
      expect(row.status).toBe(status);
      const effective = resolveEffectivePlan({ plan: "premium", status: row.status, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end });
      expect(effective, status).toBe("free");
    }
  });

  test("有効な契約(active/trialing)だけがPremiumの権限を持つ。解約予定でも期間終了までは有効", () => {
    for (const status of ["active", "trialing"]) {
      expect(resolveEffectivePlan({ plan: "premium", status, currentPeriodEnd: null, cancelAtPeriodEnd: false })).toBe("premium");
    }
    const { row } = buildSubscriptionRow(sub(NEW_PRICE, { cancel_at_period_end: true }), "premium", MAPPING, "2026-10-22T00:00:00.000Z");
    expect(row.cancel_at_period_end).toBe(true);
    expect(resolveEffectivePlan({ plan: "premium", status: row.status, currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: true })).toBe("premium");
  });

  test("契約が無い・アイテムが無い場合の行", () => {
    const { row, unknownPrice } = buildSubscriptionRow(sub(NEW_PRICE, { items: { data: [] } }), null, MAPPING, "2026-10-22T00:00:00.000Z");
    expect(unknownPrice).toBe(false);
    expect(row.current_period_end).toBeNull();
    expect(row.stripe_price_id).toBeNull();
  });
});

test.describe("同期: 古いイベントの巻き戻し・重複", () => {
  const T1 = "2026-10-22T10:00:00.000Z";
  const T2 = "2026-10-22T10:00:05.000Z";

  test("新しい取得結果のあとに、古い取得結果が届いても上書きしない", async () => {
    const store = new FakeStore();
    const newer = await syncSubscription({ store, customerId: "cus", subscription: sub(NEW_PRICE, { status: "canceled" }), mapping: MAPPING, retrievedAtIso: T2 });
    const older = await syncSubscription({ store, customerId: "cus", subscription: sub(NEW_PRICE, { status: "active" }), mapping: MAPPING, retrievedAtIso: T1 });
    expect(newer).toBe("updated");
    expect(older).toBe("stale");
    expect(store.row!.status).toBe("canceled");
  });

  test("同じ内容を何度同期しても、結果は同じ（重複イベントで二重に壊れない）", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 3; i++) await syncSubscription({ store, customerId: "cus", subscription: sub(NEW_PRICE), mapping: MAPPING, retrievedAtIso: T1 });
    expect(store.row).toMatchObject({ status: "active", plan: "premium", stripe_price_id: NEW_PRICE });
  });

  test("順序どおりなら更新される", async () => {
    const store = new FakeStore();
    await syncSubscription({ store, customerId: "cus", subscription: sub(OLD_PRICE), mapping: MAPPING, retrievedAtIso: T1 });
    const r = await syncSubscription({ store, customerId: "cus", subscription: sub(NEW_PRICE), mapping: MAPPING, retrievedAtIso: T2 });
    expect(r).toBe("updated");
    expect(store.row!.stripe_price_id).toBe(NEW_PRICE);
  });

  test("契約の行が無い顧客は書き込まない(no-row)", async () => {
    const store: SubscriptionStore = { findByCustomer: async () => null, updateIfNotNewer: async () => { throw new Error("should not write"); } };
    expect(await syncSubscription({ store, customerId: "cus", subscription: sub(NEW_PRICE), mapping: MAPPING, retrievedAtIso: T1 })).toBe("no-row");
  });

  test("知らない価格のときは通知コールバックを呼ぶ", async () => {
    const store = new FakeStore();
    const seen: (string | null)[] = [];
    await syncSubscription({ store, customerId: "cus", subscription: sub("price_zzz"), mapping: MAPPING_PRICES_ONLY, retrievedAtIso: T1, onUnknownPrice: (p) => seen.push(p) });
    expect(seen).toEqual(["price_zzz"]);
    expect(store.row!.plan).toBeNull();
  });
});
