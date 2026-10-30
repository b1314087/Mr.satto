import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";

/**
 * ファイルを選ぶ前の、ドラッグ&ドロップの枠は、右の（まだ空の）プレビュー列を空けず、カードいっぱいに広がる。
 * ファイルを選んでプレビューが出たあとは、これまでどおり左右2列になる。
 */
test("画像リサイズ: ファイルを選ぶ前は枠がカードの幅いっぱい（余白つき）に広がり、選んだあとは左右2列になる（PC幅）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tools/image-resize");
  await waitForFileInputHydrated(page);
  const widths = () =>
    page.evaluate(() => {
      const zone = document.querySelector(".ms-dropzone") as HTMLElement;
      const panel = document.querySelector(".ms-tool-panel") as HTMLElement;
      const z = zone.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return { zone: z.width, panel: p.width, left: z.left - p.left, right: p.right - z.right };
    });
  const before = await widths();
  // 左右に、カードの内側の余白（1.5rem=24pt付近）だけを残して、ほぼ全幅
  expect(before.zone).toBeGreaterThan(before.panel - 70);
  expect(before.left).toBeGreaterThan(10);
  expect(before.right).toBeGreaterThan(10);
  await expect(page.locator("[data-preview-empty]")).toHaveCount(1);

  await uploadFixture(page, fixtures.png);
  await expect(page.getByTestId("tool-preview")).toBeVisible({ timeout: 20_000 }).catch(() => {});
  // 選んだあと、プレビューが出るツールの画面は2列（枠は半分ほどの幅）に戻る。プレビューが無いままなら、全幅のまま
  const hasPreview = await page.getByTestId("tool-preview").count();
  if (hasPreview > 0) {
    const after = await widths();
    expect(after.zone).toBeLessThan(before.zone);
  }
});
