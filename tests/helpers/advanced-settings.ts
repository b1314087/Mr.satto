import type { Locator, Page } from "@playwright/test";

/**
 * 「詳細設定」（UI・UX改善の折りたたみ。src/components/ui/advanced-settings.tsx）を開く。
 * 閉じている中の設定は画面に見えないため、操作・表示の確認の前に開いておく。すでに開いていれば何もしない。
 * testId を渡すとその折りたたみだけ、渡さないとページ内の閉じている折りたたみをすべて開く。
 */
export async function openAdvanced(page: Page, testId?: string): Promise<void> {
  const targets: Locator = testId ? page.getByTestId(testId) : page.locator("details.ms-adv");
  // 指定した折りたたみは、表示されるまで待つ（ファイルを読み込んだあとに出るものがあるため）
  if (testId) await targets.first().waitFor({ state: "visible", timeout: 30_000 });
  const count = await targets.count();
  for (let i = 0; i < count; i++) {
    const d = targets.nth(i);
    if (!(await d.isVisible())) continue;
    const open = await d.evaluate((el) => (el as HTMLDetailsElement).open);
    if (!open) await d.locator(":scope > summary").click();
  }
}
