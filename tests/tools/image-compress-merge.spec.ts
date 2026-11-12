import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";
import { execFileSync } from "node:child_process";
import { encodePng, makeImage } from "../helpers/pptx-builder";
import { getListedTools, getToolById } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { toolSeoContent } from "@/lib/seo/tool-content";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseCompressOnly } from "../helpers/image-ops";

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
    await chooseCompressOnly(page);
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
    await chooseCompressOnly(page);
    await uploadFixture(page, file);
    await page.getByTestId("compress-kind-size").click();
    await page.getByLabel("目標サイズ (KB)").fill("1");
    await expect(page.getByTestId("compress-target-missed")).toBeVisible({ timeout: 30_000 });
    // 工程3：画像リサイズを統合したため、同じ画面の「サイズを変更」を案内する（ボタン名と同じ）
    await expect(page.getByTestId("compress-target-missed")).toContainText("「サイズを変更」で");
    await page.getByRole("button", { name: "圧縮する" }).click();
    await waitForSuccess(page, "完了");
    await expect(page.getByTestId("compress-result-missed")).toContainText("1KB");
  });

  test("目標サイズに届いたときは、案内メッセージは出ない", async ({ page }) => {
    const smooth = makeImage(200, 200, (x, y) => [x, y, 128, 255]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "smooth-")), "smooth.png");
    fs.writeFileSync(file, encodePng(smooth));
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
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

// ---------------------------------------------------------------------------
// 圧縮しても元より大きくしない（PNGは画質の設定が効かず、書き出し直すと大きくなることがあるため）
// ---------------------------------------------------------------------------
test.describe("画像リサイズ・圧縮: 元の画像より大きくしない", () => {
  /** 色数を減らして小さく保存したPNGのイラスト（ブラウザで書き出し直すと、元より大きくなる） */
  function makeSmallIllustrationPng(): string {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "small-png-")), "イラスト.png");
    execFileSync("python3", [
      "-c",
      `
import sys
from PIL import Image, ImageDraw
im = Image.new("RGB", (900, 650), (250, 248, 240))
d = ImageDraw.Draw(im)
d.ellipse([370, 220, 530, 380], fill=(222, 184, 135), outline=(90, 60, 40), width=5)
d.polygon([(380, 250), (400, 170), (450, 230)], fill=(222, 184, 135))
d.polygon([(520, 250), (500, 170), (450, 230)], fill=(222, 184, 135))
im.quantize(colors=8).save(sys.argv[1], optimize=True)
`,
      out,
    ]);
    return out;
  }

  test("PNGのイラストを圧縮しても大きくならず、元の画像のままにして、そのことを知らせる", async ({ page }) => {
    const src = makeSmallIllustrationPng();
    const originalSize = fs.statSync(src).size;
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    await uploadFixture(page, src);
    await page.locator('input[type="range"]').fill("55");
    await expect(page.getByTestId("image-size-note")).toContainText("元の画像のままにしました", { timeout: 20_000 });
    await expect(page.getByTestId("tool-preview")).toContainText("（元の100%）");
    await page.getByRole("button", { name: "圧縮する", exact: true }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByTestId("image-size-note-result")).toContainText("元の画像のままにしました");
    const download = await clickAndDownload(page, "ダウンロード");
    const saved = test.info().outputPath("out.png");
    await download.saveAs(saved);
    plainExpect(fs.statSync(saved).size).toBe(originalSize);
    plainExpect(fs.readFileSync(saved).equals(fs.readFileSync(src))).toBe(true);
  });

  test("サイズを変えるだけ（幅・高さがそのまま）でも、元より大きくしない。小さくしたときは、案内を出さない", async ({ page }) => {
    const src = makeSmallIllustrationPng();
    await page.goto("/tools/image-compress");
    await uploadFixture(page, src);
    await expect(page.getByTestId("image-op-resize")).toBeChecked();
    await expect(page.getByTestId("image-size-note")).toContainText("元の画像のままにしました", { timeout: 20_000 });
    // 写真（JPEG）を小さくしたときは、案内は出ない
    await page.goto("/tools/image-compress");
    await uploadFixture(page, fixtures.landscapeJpg);
    const widthInput = page.locator("label", { hasText: "幅 (px)" }).locator("input");
    await widthInput.fill("100");
    await expect(page.getByTestId("tool-preview")).toContainText("処理後 ・ 100 ×", { timeout: 20_000 });
    await expect(page.getByTestId("image-size-note")).toHaveCount(0);
  });
});
