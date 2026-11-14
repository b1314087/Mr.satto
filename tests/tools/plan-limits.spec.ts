import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { setDevPlanOverride } from "../helpers/dev-plan";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { fixtures } from "../fixtures/paths";
import { PLAN_LIMITS, getPlanLimit, clampToLimit } from "@/lib/plans/tool-limits";

/**
 * 2026-11 料金プランの見直し：ツールごとの「一度に扱える数」のプラン別の上限（src/lib/plans/tool-limits.ts）。
 */

plainTest("上限はプランごとに決まり、プランが分からないときは無料の上限になる", () => {
  plainExpect(getPlanLimit("file-zip", "free")).toBe(PLAN_LIMITS["file-zip"].free);
  plainExpect(getPlanLimit("file-zip", "standard")).toBe(PLAN_LIMITS["file-zip"].standard);
  plainExpect(getPlanLimit("file-zip", "premium")).toBe(PLAN_LIMITS["file-zip"].premium);
  plainExpect(getPlanLimit("file-zip", null)).toBe(PLAN_LIMITS["file-zip"].free);
  plainExpect(clampToLimit([1, 2, 3, 4], 3)).toEqual({ kept: [1, 2, 3], dropped: 1 });
  plainExpect(clampToLimit([1, 2], 3)).toEqual({ kept: [1, 2], dropped: 0 });
  for (const def of Object.values(PLAN_LIMITS)) {
    plainExpect(def.free).toBeLessThanOrEqual(def.standard);
    plainExpect(def.standard).toBeLessThanOrEqual(def.premium);
  }
});

function textFiles(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `memo-${i + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`memo ${i + 1}`) }));
}

test("無料：ZIP作成で上限を超えて選ぶと、上限の数だけ読み込み、プレミアムの上限を案内する", async ({ page, context, baseURL }) => {
  await setDevPlanOverride(context, "free", baseURL!);
  const limit = PLAN_LIMITS["file-zip"].free;
  await page.goto("/tools/file-zip");
  await expect(page.getByTestId("plan-limit-hint")).toContainText(`${limit}ファイルまで`);
  await page.locator('input[type="file"]').first().setInputFiles(textFiles(limit + 1));
  const notice = page.getByTestId("plan-limit-notice");
  await expect(notice).toContainText(`${limit}ファイルまで`);
  await expect(notice).toContainText("超えた1ファイル");
  await expect(notice).toContainText(`${PLAN_LIMITS["file-zip"].premium}ファイルまで`);
});

test("プレミアム：ZIP作成では上限の案内を出さず、たくさん選べる", async ({ page }) => {
  await page.goto("/tools/file-zip");
  await page.locator('input[type="file"]').first().setInputFiles(textFiles(5));
  await expect(page.getByTestId("plan-limit-hint")).toHaveCount(0);
  await expect(page.getByTestId("plan-limit-notice")).toHaveCount(0);
  await expect(page.getByText("memo-5.txt").first()).toBeVisible();
});

plainTest("無料：画像結合・PDF結合は2つまで（2つで結合を試せる）", () => {
  plainExpect(PLAN_LIMITS["image-merge"].free).toBe(2);
  plainExpect(PLAN_LIMITS["pdf-merge"].free).toBe(2);
  plainExpect(PLAN_LIMITS["pdf-merge"].standard).toBeGreaterThanOrEqual(2);
});

test("無料：PDF結合で3つ選ぶと2つだけ読み込み、2つをそのまま結合できる", async ({ page, context, baseURL }) => {
  await setDevPlanOverride(context, "free", baseURL!);
  await page.goto("/tools/pdf-merge");
  await expect(page.getByTestId("plan-limit-hint")).toContainText("2ファイルまで");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles([fixtures.singlePagePdf, fixtures.multiPagePdf, fixtures.singlePagePdf]);
  await expect(page.getByTestId("plan-limit-notice")).toContainText("超えた1ファイル");
  const run = page.getByRole("button", { name: "2件のPDFを結合する" });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 30_000 });
});

test("無料：画像結合で2枚を選ぶと、案内を出さずに結合できる", async ({ page, context, baseURL }) => {
  await setDevPlanOverride(context, "free", baseURL!);
  await page.goto("/tools/image-merge");
  await expect(page.getByTestId("plan-limit-hint")).toContainText("2枚まで");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles([fixtures.png, fixtures.landscapeJpg]);
  await expect(page.getByTestId("plan-limit-notice")).toHaveCount(0);
  await expect(page.getByText("landscape.jpg").first()).toBeVisible();
});

test("開いたあとにプランが無料に変わったら、処理の直前のサーバーの確認で、多い件数の処理を止める", async ({ page, context, baseURL }) => {
  // プレミアムでページを開き、たくさん選ぶ
  await page.goto("/tools/file-zip");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(textFiles(5));
  await expect(page.getByText("memo-5.txt").first()).toBeVisible();
  // ログアウト・契約の終了などで、サーバー上のプランが無料になった
  await setDevPlanOverride(context, "free", baseURL!);
  await page.getByRole("button", { name: "5件をZIP化する" }).click();
  const notice = page.getByTestId("plan-limit-notice");
  await expect(notice).toContainText(`${PLAN_LIMITS["file-zip"].free}ファイルまで`);
  await expect(notice).toContainText("今は5ファイル");
  await expect(page.getByText("ZIPの作成が完了しました")).toHaveCount(0);
});

test("プレミアムのままなら、処理の直前の確認を通って、そのまま処理できる", async ({ page }) => {
  await page.goto("/tools/file-zip");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(textFiles(5));
  await page.getByRole("button", { name: "5件をZIP化する" }).click();
  await expect(page.getByText("ZIPの作成が完了しました")).toBeVisible();
  await expect(page.getByTestId("plan-limit-notice")).toHaveCount(0);
});
