import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { encodePng, makeImage } from "../helpers/pptx-builder";
import { getListedTools, getToolById } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { toolSeoContent } from "@/lib/seo/tool-content";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 「画像圧縮」と「指定KBまで圧縮」の統合のテスト。
 * 画像圧縮の画面で、「画質を指定」と「目標サイズ(KB)を指定」を切り替えられる。旧アドレスは統合先へ転送する。
 */

plainTest.describe("画像圧縮の統合: 登録・検索・SEO", () => {
  plainTest("「指定KBまで圧縮」は別のツールとしては無くなり、画像圧縮の検索・説明に統合されている", () => {
    plainExpect(getToolById("image-compress-to-size")).toBeUndefined();
    plainExpect(getListedTools().some((t) => t.id === "image-compress-to-size")).toBe(false);
    for (const q of ["指定KB", "指定KBまで圧縮", "kb", "容量指定", "目標サイズ", "画像圧縮"]) {
      plainExpect(searchTools(getListedTools(), q).some((t) => t.id === "image-compress"), q).toBe(true);
    }
    plainExpect(toolSeoContent["image-compress-to-size"]).toBeUndefined();
    const seo = toolSeoContent["image-compress"];
    plainExpect(seo.metaDescription).toContain("KB");
    plainExpect(seo.faq.some((f) => f.question.includes("300KB"))).toBe(true);
  });
});

test.describe("画像圧縮の統合: 画面", () => {
  test("旧アドレスは、画像圧縮の「目標サイズを指定」へ転送される", async ({ page }) => {
    await page.goto("/tools/image-compress-to-size");
    await expect(page).toHaveURL(/\/tools\/image-compress\?mode=size$/);
    await expect(page.getByTestId("compress-kind-size")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("compress-kind-quality")).toHaveAttribute("aria-checked", "false");
  });

  test("画質の指定と目標サイズの指定を切り替えられる（既定は画質の指定）", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await expect(page.getByTestId("compress-kind-quality")).toHaveAttribute("aria-checked", "true");
    await uploadFixtureWhenReady(page);
    await expect(page.getByText(/画質: \d+%/)).toBeVisible();
    await expect(page.getByLabel("目標サイズ (KB)")).toHaveCount(0);
    await page.getByTestId("compress-kind-size").click();
    await expect(page.getByLabel("目標サイズ (KB)")).toBeVisible();
    await expect(page.getByText(/画質: \d+%/)).toHaveCount(0);
    await page.getByTestId("compress-kind-quality").click();
    await expect(page.getByText(/画質: \d+%/)).toBeVisible();
  });

  test("目標サイズに届かないときは、画像リサイズを案内するメッセージが出る", async ({ page }) => {
    // 細かい模様の大きめの画像（1KBまでは小さくできない）
    const noisy = makeImage(400, 400, (x, y) => {
      const v = (x * 7919 + y * 104729 + ((x * y) % 251) * 31) % 256;
      return [v, (v * 3) % 256, (v * 5) % 256, 255];
    });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "noisy-")), "noisy.png");
    fs.writeFileSync(file, encodePng(noisy));
    await page.goto("/tools/image-compress");
    await uploadFixture(page, file);
    await page.getByTestId("compress-kind-size").click();
    await page.getByLabel("目標サイズ (KB)").fill("1");
    await expect(page.getByTestId("compress-target-missed")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("compress-target-missed")).toContainText("画像リサイズ");
    await page.getByRole("button", { name: "圧縮する" }).click();
    await waitForSuccess(page, "完了");
    await expect(page.getByTestId("compress-result-missed")).toContainText("1KB");
  });

  test("目標サイズに届いたときは、案内メッセージは出ない", async ({ page }) => {
    const smooth = makeImage(200, 200, (x, y) => [x, y, 128, 255]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smooth-")), "smooth.png");
    fs.writeFileSync(file, encodePng(smooth));
    await page.goto("/tools/image-compress");
    await uploadFixture(page, file);
    await page.getByTestId("compress-kind-size").click();
    await page.getByLabel("目標サイズ (KB)").fill("300");
    await page.getByRole("button", { name: "圧縮する" }).click();
    await waitForSuccess(page, "完了");
    await expect(page.getByTestId("compress-result-missed")).toHaveCount(0);
    await expect(page.getByTestId("compress-target-missed")).toHaveCount(0);
  });
});

async function uploadFixtureWhenReady(page: import("@playwright/test").Page) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fx-")), "a.png");
  fs.writeFileSync(file, encodePng(makeImage(60, 40, (x, y) => [x * 4, y * 6, 100, 255])));
  await uploadFixture(page, file);
}
