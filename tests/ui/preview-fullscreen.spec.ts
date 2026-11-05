import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * プレビューの「大きく表示」（全ツール共通の PreviewFullscreenFrame）。
 * 画面いっぱいに広がり、中身が小さいときは画面に合わせて拡大される。倍率を変えられ、Esc・閉じるで戻る。
 * （各ツールで開けることは、preview-all.spec.ts で全ツールを確かめている）
 */

test("大きく表示：画面いっぱいに広がり、小さいプレビューは自動で拡大。－・＋・画面に合わせるで倍率を変えられ、閉じると元に戻る", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tools/pdf-watermark");
  await uploadFixture(page, fixtures.multiPagePdf);
  const preview = page.getByTestId("tool-preview").first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const before = (await preview.boundingBox())!;
  const thumb = preview.locator("img, canvas").first();
  await expect(thumb).toBeVisible({ timeout: 30_000 });
  const thumbBefore = (await thumb.boundingBox())!;

  await page.getByTestId("preview-fullscreen").click();
  const frame = page.locator('[data-preview-fullscreen="true"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("role", "dialog");
  const fb = (await frame.boundingBox())!;
  expect(fb.width).toBeGreaterThan(1380);
  expect(fb.height).toBeGreaterThan(880);
  // 後ろのページはスクロールしない
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  const zoomText = page.getByTestId("preview-zoom");
  await expect(zoomText).not.toHaveText("100%");
  const z0 = parseInt((await zoomText.textContent()) ?? "100", 10);
  expect(z0).toBeGreaterThan(100);
  const thumbAfter = (await thumb.boundingBox())!;
  expect(thumbAfter.width).toBeGreaterThan(thumbBefore.width * 1.05);

  await page.getByTestId("preview-zoom-out").click();
  await expect(zoomText).toHaveText(`${z0 - 25}%`);
  await page.getByTestId("preview-zoom-in").click();
  await page.getByTestId("preview-zoom-in").click();
  await expect(zoomText).toHaveText(`${z0 + 25}%`);
  await page.getByTestId("preview-zoom-fit").click();
  await expect(zoomText).toHaveText(`${z0}%`);

  await page.getByTestId("preview-fullscreen-close").click();
  await expect(frame).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  const back = (await preview.boundingBox())!;
  expect(Math.abs(back.width - before.width)).toBeLessThan(2);

  await page.getByTestId("preview-fullscreen").click();
  await page.keyboard.press("Escape");
  await expect(frame).toHaveCount(0);
});

test("大きく表示：動画のプレビューでも使え、再生位置は大きくしても変わらない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/tools/video-metadata-remove");
  await uploadFixture(page, fixtures.webm);
  const video = page.getByTestId("tool-preview").locator("video").first();
  await expect(video).toBeVisible({ timeout: 30_000 });
  await video.evaluate(async (v: HTMLVideoElement) => {
    await new Promise<void>((r) => (v.readyState >= 1 ? r() : v.addEventListener("loadedmetadata", () => r(), { once: true })));
    v.currentTime = 0.5;
  });
  await page.getByTestId("preview-fullscreen").click();
  await expect(page.locator('[data-preview-fullscreen="true"]')).toBeVisible();
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
  const vb = (await video.boundingBox())!;
  expect(vb.height).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
});
