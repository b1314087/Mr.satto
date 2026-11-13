import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { setDevPlanOverride } from "../helpers/dev-plan";
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
