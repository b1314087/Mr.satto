import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { decideFallbackGrant, FALLBACK_GRANT_POLICY } from "@/lib/plans/fallback-grant-policy";
import { fallbackClaimantHash, isFallbackMarkForToday, msUntilNextJstMidnight, signFallbackMark } from "@/lib/plans/fallback-claim-core";
import { isFallbackGrantReason } from "@/lib/plans/temporary-access-kinds";
import { planChangeFor } from "@/lib/plans/plan-change";
import { resolveEffectivePlan, type SubscriptionSnapshot } from "@/lib/plans/effective-plan";
import { scheduledPlanFromPhases } from "@/lib/stripe/scheduled-change";
import { resolvePlanFromItems, type PlanMapping } from "@/lib/stripe/subscription-sync";

/** 2026-11 総合改修：広告が出ないときの救済（1日1回）と、スタンダード ↔ プレミアムのプラン変更（画面・通信を使わない判定のテスト） */

const SECRET = "test-secret-0123456789";
// 日本時間 2026-11-14 23:59:30 と、30秒後の 2026-11-15 00:00:00
const BEFORE_MIDNIGHT = new Date("2026-11-14T14:59:30Z");
const AFTER_MIDNIGHT = new Date("2026-11-14T15:00:00Z");

test.describe("救済の判定（1日1回）", () => {
  test("1日1回：今日まだ使っていなければ許可、使っていれば断る", () => {
    expect(FALLBACK_GRANT_POLICY.perDay).toBe(1);
    expect(decideFallbackGrant({ reason: "sdk-load-failed", usedToday: 0 })).toEqual({ allowed: true });
    expect(decideFallbackGrant({ reason: "ad-timeout", usedToday: 1 })).toEqual({ allowed: false, denial: "daily-limit" });
  });

  test("救済の対象は、広告が出ない理由だけ（広告を途中で閉じた・広告ユニット未設定は対象外）", () => {
    for (const reason of ["sdk-load-failed", "slot-unavailable", "ad-timeout", "display-failed"]) expect(isFallbackGrantReason(reason)).toBe(true);
    for (const reason of ["denied", "closed", "not-configured", "", "SDK-LOAD-FAILED"]) expect(isFallbackGrantReason(reason)).toBe(false);
  });

  test("今日使った印（Cookie）は、日本時間の0時で切り替わる・署名を変えると無効", () => {
    const mark = signFallbackMark(SECRET, BEFORE_MIDNIGHT);
    expect(isFallbackMarkForToday(SECRET, mark, BEFORE_MIDNIGHT)).toBe(true);
    expect(isFallbackMarkForToday(SECRET, mark, AFTER_MIDNIGHT)).toBe(false);
    expect(isFallbackMarkForToday("other-secret-000000", mark, BEFORE_MIDNIGHT)).toBe(false);
    const [v, date] = mark.split(".");
    expect(isFallbackMarkForToday(SECRET, `${v}.${date}.forged`, BEFORE_MIDNIGHT)).toBe(false);
    expect(isFallbackMarkForToday(SECRET, `v1.2026-11-15.${mark.split(".")[2]}`, AFTER_MIDNIGHT)).toBe(false);
    expect(isFallbackMarkForToday(SECRET, undefined, BEFORE_MIDNIGHT)).toBe(false);
  });

  test("印の有効期限は、日本時間の次の0時まで", () => {
    expect(msUntilNextJstMidnight(BEFORE_MIDNIGHT)).toBe(60_000); // 残り30秒でも、最低1分
    expect(msUntilNextJstMidnight(new Date("2026-11-14T03:00:00Z"))).toBe(12 * 60 * 60 * 1000); // 日本時間12:00 → 残り12時間
  });

  test("データベースに保存する識別値：日ごとに変わり、元の値（ユーザーID・接続元）を含まない", () => {
    const user = { kind: "user", userId: "11111111-2222-3333-4444-555555555555" } as const;
    const anon = { kind: "anonymous", ip: "203.0.113.5", userAgent: "Mozilla/5.0" } as const;
    const a = fallbackClaimantHash(SECRET, user, BEFORE_MIDNIGHT);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fallbackClaimantHash(SECRET, user, BEFORE_MIDNIGHT)).toBe(a);
    expect(fallbackClaimantHash(SECRET, user, AFTER_MIDNIGHT)).not.toBe(a);
    expect(fallbackClaimantHash(SECRET, anon, BEFORE_MIDNIGHT)).not.toBe(a);
    expect(a).not.toContain("11111111");
  });

  test("データベースの関数：1日1行・Service Roleだけ・識別値の形式を確かめる・ファイルの情報を持たない", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/0009_ad_fallback_daily.sql"), "utf8");
    expect(sql).toContain("primary key (claim_date, claimant_hash)");
    expect(sql).toContain("on conflict do nothing");
    expect(sql).toContain("at time zone 'Asia/Tokyo'");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on function public.claim_ad_fallback(text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.claim_ad_fallback(text) to service_role;");
    expect(sql).toMatch(/\^\[0-9a-f\]\{64\}\$/);
    expect(sql).not.toMatch(/file_name|filename|content|ip_address|user_agent/);
  });
});

const NOW = Date.parse("2026-11-14T00:00:00Z");
const sub = (plan: "standard" | "premium" | null, status = "active", cancelAtPeriodEnd = false): SubscriptionSnapshot => ({
  plan,
  status,
  currentPeriodEnd: new Date(NOW + 20 * 86_400_000).toISOString(),
  cancelAtPeriodEnd,
});

test.describe("プラン変更のボタン", () => {
  test("スタンダード → プレミアムはアップグレード、プレミアム → スタンダードはダウングレード", () => {
    expect(planChangeFor(sub("standard"), "premium")).toBe("upgrade");
    expect(planChangeFor(sub("premium"), "standard")).toBe("downgrade");
    expect(planChangeFor(sub("premium", "trialing"), "standard")).toBe("downgrade");
  });

  test("同じプラン・契約なし・支払い失敗・解約予約中・知らない価格では出さない", () => {
    expect(planChangeFor(sub("standard"), "standard")).toBeNull();
    expect(planChangeFor(null, "premium")).toBeNull();
    expect(planChangeFor(sub("standard", "past_due"), "premium")).toBeNull();
    expect(planChangeFor(sub("standard", "canceled"), "premium")).toBeNull();
    expect(planChangeFor(sub("premium", "active", true), "standard")).toBeNull();
    expect(planChangeFor(sub(null), "premium")).toBeNull();
  });
});

const MAPPING: PlanMapping = {
  premiumProductIds: ["prod_shared"],
  premiumPriceIds: ["price_p1100", "price_p980"],
  standardPriceIds: ["price_s220"],
};
const item = (id: string, product = "prod_shared") => ({ price: { id, product } });

test.describe("契約の価格 → プラン（Webhookの判定）", () => {
  test("スタンダードの価格をプレミアムと同じ商品の下に作っても、スタンダードと判定する（価格IDの指定が優先）", () => {
    expect(resolvePlanFromItems([item("price_s220")], MAPPING)).toBe("standard");
    expect(resolvePlanFromItems([item("price_other_in_premium_product")], MAPPING)).toBe("premium");
    expect(resolvePlanFromItems([item("price_p980")], MAPPING)).toBe("premium");
  });

  test("アップグレード後（価格がプレミアムに変わった通知）はプレミアム、通知が届くまでは変更前のまま", () => {
    const before = { plan: resolvePlanFromItems([item("price_s220")], MAPPING), status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false };
    const after = { ...before, plan: resolvePlanFromItems([item("price_p1100")], MAPPING) };
    expect(resolveEffectivePlan(before)).toBe("standard");
    expect(resolveEffectivePlan(after)).toBe("premium");
  });
});

test.describe("予約中のプラン変更（スケジュールの読み取り）", () => {
  const nowSec = Math.floor(NOW / 1000);
  test("次回の更新日からスタンダードに変わる予約を読み取る（それまではプレミアムのまま）", () => {
    const phases = [
      { start_date: nowSec - 86_400 * 10, items: [{ price: "price_p1100" }] },
      { start_date: nowSec + 86_400 * 20, items: [{ price: { id: "price_s220" } }] },
    ];
    expect(scheduledPlanFromPhases(phases, "premium", MAPPING, nowSec)).toEqual({
      plan: "standard",
      startsAt: new Date((nowSec + 86_400 * 20) * 1000).toISOString(),
    });
  });

  test("先の段階がない・同じプランのまま・知らない価格なら、予約なし", () => {
    expect(scheduledPlanFromPhases([{ start_date: nowSec - 10, items: [{ price: "price_p1100" }] }], "premium", MAPPING, nowSec)).toBeNull();
    expect(scheduledPlanFromPhases([{ start_date: nowSec + 10, items: [{ price: "price_p980" }] }], "premium", MAPPING, nowSec)).toBeNull();
    expect(scheduledPlanFromPhases([{ start_date: nowSec + 10, items: [{ price: "price_unknown" }] }], "standard", { ...MAPPING, premiumProductIds: [] }, nowSec)).toBeNull();
  });
});
