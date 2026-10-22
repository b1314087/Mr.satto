import { test, expect } from "@playwright/test";
import { checkPremiumPrice } from "@/lib/stripe/price-guard";
import { hasOpenSubscription, resolveEffectivePlan } from "@/lib/plans/effective-plan";
import { OFFERED_PLAN_IDS, PLAN_DEFINITIONS, PREMIUM_PRICE_YEN } from "@/lib/plans/types";

/** 料金の統一（Free / Premium 1,100円）と、課金の二重化・表示と請求の食い違いを防ぐ判定の単体テスト */

const GOOD = { active: true, currency: "jpy", unit_amount: 1100, type: "recurring", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };

test.describe("Premiumの価格の照合（表示と請求の食い違いを防ぐ）", () => {
  test("表示価格と一致する月額のPriceだけが通る", () => {
    expect(checkPremiumPrice(GOOD, PREMIUM_PRICE_YEN)).toEqual({ ok: true });
  });

  test("旧980円のPriceは通らない（表示は1,100円なので、課金しない）", () => {
    expect(checkPremiumPrice({ ...GOOD, unit_amount: 980 }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "amount" });
  });

  test("通貨・周期・無効・存在しないPriceは通らない", () => {
    expect(checkPremiumPrice({ ...GOOD, currency: "usd" }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "currency" });
    expect(checkPremiumPrice({ ...GOOD, recurring: { interval: "year", interval_count: 1 } }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "not_monthly" });
    expect(checkPremiumPrice({ ...GOOD, recurring: { interval: "month", interval_count: 3 } }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "not_monthly" });
    expect(checkPremiumPrice({ ...GOOD, type: "one_time", recurring: null }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "not_monthly" });
    expect(checkPremiumPrice({ ...GOOD, recurring: { interval: "month", interval_count: 1, usage_type: "metered" } }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "not_monthly" });
    expect(checkPremiumPrice({ ...GOOD, active: false }, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "inactive" });
    expect(checkPremiumPrice(null, PREMIUM_PRICE_YEN)).toEqual({ ok: false, reason: "not_found" });
  });
});

test.describe("契約の二重化を防ぐ判定", () => {
  const sub = (status: string) => ({ plan: "premium" as const, status, currentPeriodEnd: null, cancelAtPeriodEnd: false });

  test("続いている契約（支払いの遅れ・確認中を含む）があるあいだは、新しく申し込めない", () => {
    for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) expect(hasOpenSubscription(sub(status))).toBe(true);
  });

  test("終わった契約・契約なしなら、申し込める", () => {
    expect(hasOpenSubscription(sub("canceled"))).toBe(false);
    expect(hasOpenSubscription(sub("incomplete_expired"))).toBe(false);
    expect(hasOpenSubscription(null)).toBe(false);
  });

  test("権限は active / trialing のときだけ（支払いの遅れ・解約済みでは権限がない）", () => {
    expect(resolveEffectivePlan(sub("active"))).toBe("premium");
    expect(resolveEffectivePlan(sub("trialing"))).toBe("premium");
    for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]) expect(resolveEffectivePlan(sub(status))).toBe("free");
    // 旧Standardの契約も、有効なあいだは権限が続く
    expect(resolveEffectivePlan({ ...sub("active"), plan: "standard" })).toBe("standard");
  });
});

test("料金体系: 現行は Free / Premium(1,100円) の2つだけで、Standardは新規に出さない", () => {
  expect(OFFERED_PLAN_IDS).toEqual(["free", "premium"]);
  expect(PLAN_DEFINITIONS.free.priceYen).toBe(0);
  expect(PLAN_DEFINITIONS.premium.priceYen).toBe(1100);
  expect(PLAN_DEFINITIONS.standard.name).toContain("旧プラン");
});
