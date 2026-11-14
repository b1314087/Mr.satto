import { test, expect } from "@playwright/test";
import { canUseTool, shouldShowAds } from "@/lib/plans/access";
import { resolveEffectivePlan, resolveAiPlan, type SubscriptionSnapshot } from "@/lib/plans/effective-plan";
import { applyGrantToPlan, AI_TRIAL_LIMIT_MICRO_USD, TRIAL_DAYS, type PremiumGrant } from "@/lib/plans/grants";
import { PLAN_DEFINITIONS, PREMIUM_PRICE_YEN, STANDARD_PRICE_YEN, OFFERED_PLAN_IDS, type Plan } from "@/lib/plans/types";
import { PLAN_LIMITS, getPlanLimit, isAllowedCount, isPlanLimitKey } from "@/lib/plans/tool-limits";
import { BATCH_LIMITS, canUseBatch } from "@/lib/batch/batch-config";
import { canUsePremiumFeature } from "@/lib/plans/premium-feature";
import { resolvePlanFromItems, type PlanMapping } from "@/lib/stripe/subscription-sync";
import { AD_EVERY_DOWNLOAD, TEMP_ACCESS_DURATION_MS } from "@/lib/plans/temporary-access-cookie";
import { AI_PERIOD_LIMIT_MICRO_USD, JPY_PER_USD } from "@/lib/ai/pricing";
import { getOriginalRequiredPlan, resolveRequiredPlan } from "@/lib/tools/data";
import { featureFlags } from "@/lib/config/features";

/**
 * 2026-11-14 に確定した料金プラン・利用制限の表を、そのままテストにしたもの（総合点検の指示書 9章の組み合わせ）。
 * 表の値を変えるときは、src/lib/plans/tool-limits.ts・src/lib/batch/batch-config.ts と一緒に、ここも直す。
 * 本番のスイッチ（billing・ads・ALL_TOOLS_STANDARD）は変えず、判定の関数に値を渡して確かめる。
 */

const NOW = Date.parse("2026-11-14T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const sub = (plan: "standard" | "premium" | null, status: string, endOffsetDays = 20, cancelAtPeriodEnd = false): SubscriptionSnapshot => ({
  plan,
  status,
  currentPeriodEnd: new Date(NOW + endOffsetDays * DAY).toISOString(),
  cancelAtPeriodEnd,
});
const grant = (source: PremiumGrant["source"], startOffsetDays: number, endOffsetDays: number): PremiumGrant => ({
  source,
  startsAt: new Date(NOW + startOffsetDays * DAY).toISOString(),
  endsAt: new Date(NOW + endOffsetDays * DAY).toISOString(),
});
/** サーバーの判定（getServerPlan）と同じ順番：契約 → 有効な付与でプレミアムに引き上げ */
const planOf = (s: SubscriptionSnapshot | null, g: PremiumGrant | null = null): Plan => applyGrantToPlan(resolveEffectivePlan(s), g, NOW);

test.describe("確定した料金", () => {
  test("無料0円・スタンダード月220円・プレミアム月1,100円（税込）。3つとも申し込める", () => {
    expect(PLAN_DEFINITIONS.free.priceYen).toBe(0);
    expect(STANDARD_PRICE_YEN).toBe(220);
    expect(PLAN_DEFINITIONS.standard.priceYen).toBe(220);
    expect(PREMIUM_PRICE_YEN).toBe(1100);
    expect(PLAN_DEFINITIONS.premium.priceYen).toBe(1100);
    expect([...OFFERED_PLAN_IDS]).toEqual(["free", "standard", "premium"]);
  });

  test("広告：無料だけ必要。スタンダード・プレミアムは広告なし", () => {
    expect(shouldShowAds("free")).toBe(true);
    expect(shouldShowAds("standard")).toBe(false);
    expect(shouldShowAds("premium")).toBe(false);
  });

  test("広告を見たあとに使える時間は0（ダウンロードのたびに広告）", () => {
    expect(TEMP_ACCESS_DURATION_MS).toBe(0);
    expect(AD_EVERY_DOWNLOAD).toBe(true);
  });
});

test.describe("プランの判定", () => {
  test("未ログイン・契約なし・判定に失敗（契約の行を読めない）→ 無料", () => {
    expect(planOf(null)).toBe("free");
  });

  test("スタンダード・プレミアムの契約が有効（active・trialing）ならそのプラン", () => {
    expect(planOf(sub("standard", "active"))).toBe("standard");
    expect(planOf(sub("premium", "active"))).toBe("premium");
    expect(planOf(sub("premium", "trialing"))).toBe("premium");
  });

  test("解約済み・支払い失敗・未完了 → 無料", () => {
    for (const status of ["canceled", "past_due", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(planOf(sub("premium", status)), status).toBe("free");
      expect(planOf(sub("standard", status)), status).toBe("free");
    }
  });

  test("解約の予約中は、期間の終わりまでそのプラン", () => {
    expect(planOf(sub("premium", "active", 5, true))).toBe("premium");
  });

  test("登録していない価格の契約（plan が null）は無料", () => {
    expect(planOf(sub(null, "active"))).toBe("free");
  });

  test("無料お試し（3日間）の間はプレミアム、終われば無料に戻る", () => {
    expect(TRIAL_DAYS).toBe(3);
    expect(planOf(null, grant("trial", -1, 2))).toBe("premium");
    expect(planOf(null, grant("trial", -4, -1))).toBe("free");
  });

  test("管理者の無料付与の期間中はプレミアム、終われば元のプランに戻る", () => {
    expect(planOf(null, grant("admin", -10, 10))).toBe("premium");
    expect(planOf(null, grant("admin", -10, -1))).toBe("free");
    expect(planOf(sub("standard", "active"), grant("admin", -10, -1))).toBe("standard");
    expect(planOf(sub("standard", "active"), grant("admin", -10, 10))).toBe("premium");
  });
});

test.describe("旧プレミアム（月980円）", () => {
  const mapping: PlanMapping = { premiumProductIds: [], premiumPriceIds: ["price_premium_1100", "price_premium_980"], standardPriceIds: ["price_standard_220"] };
  const item = (id: string) => ({ price: { id, product: "prod_x" } });

  test("旧980円も新1,100円もプレミアム、220円はスタンダード、知らない価格は有料扱いしない", () => {
    expect(resolvePlanFromItems([item("price_premium_980")], mapping)).toBe("premium");
    expect(resolvePlanFromItems([item("price_premium_1100")], mapping)).toBe("premium");
    expect(resolvePlanFromItems([item("price_standard_220")], mapping)).toBe("standard");
    expect(resolvePlanFromItems([item("price_unknown")], mapping)).toBeNull();
  });

  test("スタンダードの価格IDが未設定のときは、スタンダードとして扱わない（準備中）", () => {
    const noStandard: PlanMapping = { ...mapping, standardPriceIds: [] };
    expect(resolvePlanFromItems([item("price_standard_220")], noStandard)).toBeNull();
  });
});

test.describe("ツールの利用可否（ALL_TOOLS_STANDARD のオン・オフ）", () => {
  test("オン（今の本番）：元プレミアム限定のツールも、無料・スタンダードで使える", () => {
    const required = resolveRequiredPlan(getOriginalRequiredPlan("pdf-to-excel")!, true);
    expect(canUseTool("free", required)).toEqual({ allowed: true, adRequired: true });
    expect(canUseTool("standard", required)).toEqual({ allowed: true, adRequired: false });
  });

  test("オフ：元プレミアム限定のツールは、プレミアムだけが使える", () => {
    for (const id of ["pdf-to-excel", "pdf-to-word", "word-to-pdf", "excel-to-pdf", "video-compress", "invoice-generator"]) {
      expect(getOriginalRequiredPlan(id), id).toBe("premium");
      const required = resolveRequiredPlan(getOriginalRequiredPlan(id)!, false);
      expect(canUseTool("free", required).allowed, id).toBe(false);
      expect(canUseTool("standard", required).allowed, id).toBe(false);
      expect(canUseTool("premium", required), id).toEqual({ allowed: true, adRequired: false });
    }
  });

  test("通常ツール：無料は広告あり、スタンダード・プレミアムは広告なし", () => {
    expect(canUseTool("free", "standard")).toEqual({ allowed: true, adRequired: true });
    expect(canUseTool("standard", "standard")).toEqual({ allowed: true, adRequired: false });
    expect(canUseTool("premium", "standard")).toEqual({ allowed: true, adRequired: false });
  });
});

test.describe("確定した表：ツールごとの上限（無料／スタンダード／プレミアム）", () => {
  const TABLE: Record<string, [number, number, number]> = {
    "image-layout": [10, 20, 100],
    "image-merge": [2, 5, 50],
    "pdf-merge": [2, 2, 50],
    "image-to-pdf": [1, 1, 200],
    "pdf-ocr": [1, 1, 200],
    "pdf-to-excel": [1, 1, 200],
    "pdf-to-word": [1, 1, 200],
    "file-bulk-rename": [3, 3, 500],
    "file-sequential-rename": [3, 3, 500],
    "file-zip": [3, 3, 500],
    "excel-merge": [2, 2, 50],
    "audio-merge": [5, 50, 50],
    "envelope-address": [1, 1, 1000],
    "ticket-voucher": [10, 2000, 2000],
    "roster-template": [50, 3000, 3000],
    "postal-bulk": [1, 10, 10000],
    postcard: [1, 10, 500],
    "receipt-accounting-csv": [3, 50, 200],
    "filled-pdf-to-excel": [1, 1, 50],
    "form-to-individual-pdfs": [10, 10, 1000],
    "excel-label": [5, 5, Number.POSITIVE_INFINITY],
    "fiscal-calendar-import": [5, 5, 20000],
  };

  test("表とコードの数がすべて一致する（過不足もない）", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(Object.keys(TABLE).sort());
    for (const [key, [free, standard, premium]] of Object.entries(TABLE)) {
      if (!isPlanLimitKey(key)) throw new Error(key);
      expect(getPlanLimit(key, "free"), `${key} free`).toBe(free);
      expect(getPlanLimit(key, "standard"), `${key} standard`).toBe(standard);
      expect(getPlanLimit(key, "premium"), `${key} premium`).toBe(premium);
    }
  });

  test("プランが分からないときは無料の上限", () => {
    expect(getPlanLimit("postcard", null)).toBe(1);
    expect(getPlanLimit("postal-bulk", null)).toBe(1);
  });

  test("はがき：無料1件・スタンダード10件・プレミアム500件／郵便番号の一括検索：1件・10件・10,000件", () => {
    expect(isAllowedCount("postcard", 1, "free")).toBe(true);
    expect(isAllowedCount("postcard", 2, "free")).toBe(false);
    expect(isAllowedCount("postcard", 10, "standard")).toBe(true);
    expect(isAllowedCount("postcard", 11, "standard")).toBe(false);
    expect(isAllowedCount("postcard", 500, "premium")).toBe(true);
    expect(isAllowedCount("postcard", 501, "premium")).toBe(false);
    expect(isAllowedCount("postal-bulk", 10, "standard")).toBe(true);
    expect(isAllowedCount("postal-bulk", 11, "standard")).toBe(false);
    expect(isAllowedCount("postal-bulk", 10000, "premium")).toBe(true);
    expect(isAllowedCount("postal-bulk", 10001, "premium")).toBe(false);
  });

  test("サーバーでの件数の確認は、知らないツール名・数でない値を通さない", () => {
    expect(isAllowedCount("no-such-tool", 1, "premium")).toBe(false);
    expect(isAllowedCount("__proto__", 1, "premium")).toBe(false);
    expect(isAllowedCount("postcard", -1, "premium")).toBe(false);
    expect(isAllowedCount("postcard", 1.5, "premium")).toBe(false);
    expect(isAllowedCount("postcard", "3", "premium")).toBe(false);
    expect(isAllowedCount("postcard", Number.NaN, "premium")).toBe(false);
    expect(isAllowedCount("excel-label", 100000, "premium")).toBe(true);
  });
});

test.describe("確定した表：一括処理（プレミアムのみ）", () => {
  const BATCH_TABLE: Record<string, number> = {
    "image-compress": 50,
    "image-format-convert": 50,
    "image-adjust": 50,
    "image-padding-text": 50,
    "image-padding": 50,
    "background-remover": 20,
    "pdf-compress": 20,
    "pdf-to-image": 50,
    "image-crop": 50,
    "image-rotate-flip": 50,
    "image-metadata-remove": 50,
    "image-watermark": 50,
    "image-tile-split": 30,
    "image-mosaic": 30,
    "pdf-fix": 20,
    "word-to-pdf": 10,
    "excel-to-pdf": 10,
    "pdf-password-protect": 10,
    "pdf-resize-pages": 10,
    "pdf-metadata-remove": 10,
    "pdf-crop-pages": 10,
    "file-unzip": 10,
  };

  test("一括処理の上限が表と一致する", () => {
    expect({ ...BATCH_LIMITS }).toEqual(BATCH_TABLE);
  });

  test("一括処理はプレミアムだけ。無料・スタンダード・プラン不明は1ファイルずつ", () => {
    expect(featureFlags.billing).toBe(true);
    expect(canUseBatch("premium")).toBe(true);
    expect(canUseBatch("standard")).toBe(false);
    expect(canUseBatch("free")).toBe(false);
    expect(canUseBatch(null)).toBe(false);
  });

  test("ツールの中のプレミアム限定機能（電子印鑑の複数ページ押印など）はプレミアムだけ", () => {
    expect(canUsePremiumFeature("premium")).toBe(true);
    expect(canUsePremiumFeature("standard")).toBe(false);
    expect(canUsePremiumFeature("free")).toBe(false);
    expect(canUsePremiumFeature(null)).toBe(false);
  });
});

test.describe("AIの確定仕様", () => {
  test("1請求期間3.00ドル・1ドル165円（約495円）・1回0.75ドル・お試し0.60ドル", () => {
    expect(AI_PERIOD_LIMIT_MICRO_USD).toBe(3_000_000);
    expect(JPY_PER_USD).toBe(165);
    expect((AI_PERIOD_LIMIT_MICRO_USD / 1_000_000) * JPY_PER_USD).toBe(495);
    expect(AI_PERIOD_LIMIT_MICRO_USD / 4).toBe(750_000);
    expect(AI_TRIAL_LIMIT_MICRO_USD).toBe(600_000);
  });

  test("AIはプレミアムだけ。期間が過ぎても更新が確認できない契約は、AIだけ使えない", () => {
    expect(resolveAiPlan("standard", sub("standard", "active"), NOW)).toBe("standard");
    expect(resolveAiPlan("premium", sub("premium", "active", 20), NOW)).toBe("premium");
    expect(resolveAiPlan("premium", sub("premium", "active", -10), NOW)).toBe("free");
    expect(resolveAiPlan("premium", sub("premium", "active", -1, true), NOW)).toBe("free");
  });
});
