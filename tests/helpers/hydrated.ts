import { expect, type Locator } from "@playwright/test";

/**
 * 部品の準備（hydration）が終わるまで待つ。準備の前に押した・入力した操作は、画面に届かないことがあるため。
 * React が部品につける目印（__reactProps$...）が付いたら、準備ができている。
 */
export async function waitHydrated(locator: Locator, timeout = 30_000): Promise<void> {
  await expect(locator).toBeVisible({ timeout });
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), { timeout })
    .toBe(true);
}
