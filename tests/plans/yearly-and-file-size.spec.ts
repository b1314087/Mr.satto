import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { checkPlanPrice } from "@/lib/stripe/price-guard";
import { PAID_PLAN_YEARLY_PRICE_YEN, isBillingInterval, paidPlanPriceYen } from "@/lib/plans/types";
import { FILE_SIZE_MULTIPLIER, MAX_FILE_SIZE_MULTIPLIER, fileSizeMultiplier, rewriteSizeHint, scaleMaxSizeMB } from "@/lib/plans/file-size";
import { checkReceiptFile } from "@/lib/accounting/receipt-file-kind";
import { canReceiveFiles } from "@/lib/handoff/targets";

/**
 * 2026-11-15：年額プラン（スタンダード2,200円/年・プレミアム11,000円/年）と、プランごとのファイルサイズの上限（無料1倍・スタンダード2倍・プレミアム4倍）。
 * 期待値はこのファイルに直接書く（実装から作らない）。
 */

const YEARLY = (yen: number) => ({ active: true, currency: "jpy", unit_amount: yen, type: "recurring", recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } });

test.describe("年額プランの料金", () => {
  test("年額は月額の10か月分（2か月分お得）：スタンダード2,200円・プレミアム11,000円", () => {
    expect(PAID_PLAN_YEARLY_PRICE_YEN).toEqual({ standard: 2200, premium: 11000 });
    expect(paidPlanPriceYen("standard", "month")).toBe(220);
    expect(paidPlanPriceYen("premium", "month")).toBe(1100);
    expect(paidPlanPriceYen("standard", "year")).toBe(2200);
    expect(paidPlanPriceYen("premium", "year")).toBe(11000);
    expect(isBillingInterval("year")).toBe(true);
    expect(isBillingInterval("week")).toBe(false);
  });

  test("年額の価格の照合：円・1年ごと・金額が一致するときだけ通る（月額の価格や、金額違いは通らない）", () => {
    expect(checkPlanPrice(YEARLY(11000), 11000, "year")).toEqual({ ok: true });
    expect(checkPlanPrice(YEARLY(2200), 2200, "year")).toEqual({ ok: true });
    expect(checkPlanPrice(YEARLY(13200), 11000, "year")).toEqual({ ok: false, reason: "amount" });
    expect(checkPlanPrice({ ...YEARLY(11000), recurring: { interval: "month", interval_count: 1 } }, 11000, "year")).toEqual({ ok: false, reason: "not_yearly" });
    expect(checkPlanPrice({ ...YEARLY(11000), recurring: { interval: "year", interval_count: 2 } }, 11000, "year")).toEqual({ ok: false, reason: "not_yearly" });
    // 月額の確認（周期を省略）は、従来どおり年額の価格を通さない
    expect(checkPlanPrice(YEARLY(1100), 1100)).toEqual({ ok: false, reason: "not_monthly" });
  });

  test("AIの利用枠：年額の契約でも、1か月ごとに区切る（データベースの関数を置き換えるSQLがある）", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/0010_ai_period_monthly_for_yearly.sql"), "utf8");
    expect(sql).toContain("create or replace function public.ai_derive_period(p_user_id uuid)");
    expect(sql).toContain("v_end > v_start + interval '1 month' + interval '3 days'");
    // 「今の1か月」は、毎回「開始日＋kか月」で求める（月末の契約日がずれていかない）
    expect(sql).toContain("v_win_start := v_start + make_interval(months => i);");
    expect(sql).toContain("v_win_end := least(v_start + make_interval(months => i + 1), v_end);");
    // 権限は従来どおり（だれも直接呼べない。予約の関数の中からだけ使う）
    expect(sql).toContain("revoke all on function public.ai_derive_period(uuid) from public, anon, authenticated;");
  });
});

test.describe("プランごとのファイルサイズの上限", () => {
  test("倍率は 無料1・スタンダード2・プレミアム4。プランが分からないときは無料", () => {
    expect(FILE_SIZE_MULTIPLIER).toEqual({ free: 1, standard: 2, premium: 4 });
    expect(MAX_FILE_SIZE_MULTIPLIER).toBe(4);
    // テストの開発サーバーは課金オンなので、プランどおりの倍率になる
    expect(fileSizeMultiplier("free")).toBe(1);
    expect(fileSizeMultiplier("standard")).toBe(2);
    expect(fileSizeMultiplier("premium")).toBe(4);
    expect(fileSizeMultiplier(null)).toBe(1);
  });

  test("上限は無料の値に倍率をかける。上限なし（Infinity）はそのまま", () => {
    expect(scaleMaxSizeMB(50, "free")).toBe(50);
    expect(scaleMaxSizeMB(50, "standard")).toBe(100);
    expect(scaleMaxSizeMB(50, "premium")).toBe(200);
    expect(scaleMaxSizeMB(Number.POSITIVE_INFINITY, "premium")).toBe(Number.POSITIVE_INFINITY);
  });

  test("説明文の上限の数字だけを書き換える（ほかの数字は変えない）", () => {
    expect(rewriteSizeHint("またはタップして選択（上限50MB）", 50, 200)).toBe("またはタップして選択（上限200MB）");
    expect(rewriteSizeHint("複数ファイル可、上限50MB/ファイル", 50, 100)).toBe("複数ファイル可、上限100MB/ファイル");
    expect(rewriteSizeHint("150MBまで・50MB", 50, 200)).toBe("150MBまで・200MB");
    expect(rewriteSizeHint("上限1024MB", 1024, 4096)).toBe("上限4,096MB");
    expect(rewriteSizeHint("またはタップして選択", 50, 200)).toBe("またはタップして選択");
    expect(rewriteSizeHint("上限50MB", 50, 50)).toBe("上限50MB");
  });

  test("領収書の読み取り：プランの倍率で上限が変わる（画像15MB・PDF30MB が基準）", () => {
    const MB = 1024 * 1024;
    expect(checkReceiptFile("jpeg", 20 * MB)).toContain("15MB");
    expect(checkReceiptFile("jpeg", 20 * MB, 2)).toBeNull();
    expect(checkReceiptFile("pdf", 100 * MB, 4)).toBeNull();
    expect(checkReceiptFile("pdf", 130 * MB, 4)).toContain("120MB");
  });
});

// ───────────── 画面 ─────────────

test.describe("料金ページ：年額を月額のすぐ下に表示する・ファイルサイズの行", () => {
  test("切り替えボタンはなく、各有料プランの月額の下に「年額払いなら 〇円/年」と「2か月分お得」が出る。比較表に年額とファイルサイズの行がある", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByTestId("billing-toggle")).toHaveCount(0);
    await expect(page.getByTestId("pricing-price-standard")).toContainText("220円/月（税込）");
    await expect(page.getByTestId("pricing-yearly-standard")).toContainText("年額払いなら 2,200円/年");
    await expect(page.getByTestId("pricing-yearly-standard")).toContainText("2か月分お得");
    await expect(page.getByTestId("pricing-yearly-premium")).toContainText("年額払いなら 11,000円/年");
    await expect(page.getByTestId("pricing-yearly-free")).toHaveCount(0);
    await expect(page.getByTestId("pricing-filesize-standard")).toHaveText(/上限が2倍/);
    await expect(page.getByTestId("pricing-filesize-premium")).toHaveText(/上限が4倍/);

    // 以前の ?billing=year のURLで来ても、同じ表示になる（月額の価格の表示は変わらない）
    await page.goto("/pricing?billing=year");
    await expect(page.getByTestId("pricing-price-standard")).toContainText("220円/月（税込）");
    await expect(page.getByTestId("pricing-yearly-standard")).toContainText("2,200円/年");

    const table = page.getByTestId("plan-comparison");
    await expect(table.getByRole("row", { name: /年額（税込）/ })).toContainText("2,200円");
    await expect(table.getByRole("row", { name: /年額（税込）/ })).toContainText("11,000円");
    await expect(table.getByRole("row", { name: /ファイルサイズの上限/ })).toContainText("4倍");
  });

  test("申し込みのボタン：年額の価格が確認できたプランだけ「〇〇を年額で始める」を月額のボタンの下に出し、押すと年額で決済を作る", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/components/pricing/pricing-action-button.tsx", "utf8");
    expect(src).toContain("{yearlyAvailable && (");
    expect(src).toContain('onClick={() => handleClick("year")}');
    expect(src).toContain("を年額で始める");
    expect(src).toContain('JSON.stringify(interval === "year" ? { plan, interval } : { plan })');
    const page = fs.readFileSync("src/app/pricing/page.tsx", "utf8");
    expect(page).toContain("yearlyAvailable={yearlyReady[id]}");
    expect(page).toContain('verifyPlanPrice("standard", "year")');
  });
});

test.describe("ファイルの受け渡し（ほかのツールで使う）のサイズの上限", () => {
  test("受け取り側の上限にも、プランの倍率をかける（50MBまでのツールに、120MBのファイルは無料では渡せず、プレミアムでは渡せる）", () => {
    const receive = { kinds: ["pdf"], maxFiles: 1, maxFileSizeMB: 50 } as unknown as Parameters<typeof canReceiveFiles>[0];
    const file = [{ kind: "pdf", size: 120 * 1024 * 1024 }] as unknown as Parameters<typeof canReceiveFiles>[1];
    expect(canReceiveFiles(receive, file, "free")).toBe(false);
    expect(canReceiveFiles(receive, file, "standard")).toBe(false); // 100MBまで
    expect(canReceiveFiles(receive, file, "premium")).toBe(true); // 200MBまで
  });
});
