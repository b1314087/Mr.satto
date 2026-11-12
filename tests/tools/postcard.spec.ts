import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload } from "../helpers/tool-runner";
import { layoutPostcardImage, postcardSizePt, validatePostcard } from "@/lib/print/postcard-layout";

/**
 * ハガキ作成（次期機能追加 1）。
 * - はがきの大きさ（100×148mm）・縦向き／横向き
 * - 文字（大きさ・色・位置）と画像（縦横比を保った大きさ・位置）を置き、プレビューとPDFが一致する
 * - 宛名・住所録・郵便番号の機能は無い
 */

function py(script: string, args: string[] = []): string {
  return execFileSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const READ_PDF = `
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
p = r.pages[0]
imgs = []
for im in p.images:
    imgs.append(list(im.image.size))
print(json.dumps({
  "pages": len(r.pages),
  "w": round(float(p.mediabox.width), 2),
  "h": round(float(p.mediabox.height), 2),
  "text": p.extract_text(),
  "images": imgs,
}, ensure_ascii=False))
`;

plainTest.describe("配置の計算（プレビューとPDFで共通）", () => {
  plainTest("はがきの大きさ：縦向き 100×148mm、横向きはその縦横を入れ替える", () => {
    const p = postcardSizePt("portrait");
    plainExpect(p.width).toBeCloseTo(283.46, 1);
    plainExpect(p.height).toBeCloseTo(419.53, 1);
    const l = postcardSizePt("landscape");
    plainExpect(l.width).toBeCloseTo(419.53, 1);
    plainExpect(l.height).toBeCloseTo(283.46, 1);
  });

  plainTest("画像は縦横比を保ったまま、はがきの幅に対する割合で大きさを決める（中心を位置に合わせる）", () => {
    const page = postcardSizePt("portrait");
    const box = layoutPostcardImage({ id: "i", naturalWidth: 200, naturalHeight: 300, x: 50, y: 50, widthPct: 50 }, page);
    plainExpect(box.width).toBeCloseTo(page.width / 2, 3);
    plainExpect(box.height / box.width).toBeCloseTo(1.5, 3);
    plainExpect(box.x + box.width / 2).toBeCloseTo(page.width / 2, 3);
    plainExpect(box.y + box.height / 2).toBeCloseTo(page.height / 2, 3);
  });

  plainTest("何も置いていない・範囲外の値は、理由つきで止める", () => {
    plainExpect(validatePostcard([], [])).toMatch(/1つ以上/);
    plainExpect(validatePostcard([{ id: "t", text: "a", size: 200, color: "#000000", x: 50, y: 50 }], [])).toMatch(/大きさ/);
    plainExpect(validatePostcard([{ id: "t", text: "a", size: 18, color: "#000000", x: 120, y: 50 }], [])).toMatch(/位置/);
    plainExpect(validatePostcard([{ id: "t", text: "a", size: 18, color: "#000000", x: 50, y: 50 }], [])).toBeNull();
  });
});

test.describe("ハガキ作成の画面", () => {
  test("文字と画像を置いて、はがきサイズのPDFにする（縦向き）。色・位置がプレビューに出て、画像は縦横比を保つ", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tools/postcard");
    const preview = page.getByTestId("postcard-preview");
    await expect(preview).toHaveAttribute("data-orientation", "portrait");
    await expect(preview).toHaveAttribute("viewBox", /^0 0 283\.4\d* 419\.5\d*$/);
    await expect(page.getByTestId("postcard-run")).toBeDisabled(); // 何も置いていないうちは作れない

    // 文字
    await page.getByTestId("postcard-add-text").click();
    await page.getByTestId("postcard-text-input").fill("あけましておめでとう\nございます");
    await expect(page.getByTestId("postcard-preview-text")).toHaveCount(2); // 改行は2行に
    await page.getByTestId("postcard-text-color-赤").click();
    await expect(page.getByTestId("postcard-text-color-value")).toContainText("#E53935");
    await expect(page.getByTestId("postcard-preview-text").first()).toHaveAttribute("fill", "#e53935");
    await page.getByLabel("縦の位置（Y）の数値").fill("20");
    await page.getByLabel("縦の位置（Y）の数値").blur();
    const y1 = Number(await page.getByTestId("postcard-preview-text").first().getAttribute("y"));
    expect(y1).toBeLessThan(419.53 * 0.3); // 上の方に移った

    // 画像（縦長 → 縦横比を保つ）
    await page.getByTestId("postcard-image-input").setInputFiles(fixtures.portraitPng);
    await expect(page.getByTestId("postcard-image-settings")).toBeVisible();
    const img = page.getByTestId("postcard-preview-image").locator("image");
    const w = Number(await img.getAttribute("width"));
    const h = Number(await img.getAttribute("height"));
    expect(w).toBeCloseTo(283.46 * 0.6, 0); // 既定は幅の60%
    expect(h / w).toBeCloseTo(200 / 120, 1);
    await page.getByLabel("画像の大きさ（はがきの幅に対する割合）の数値").fill("40");
    await page.getByLabel("画像の大きさ（はがきの幅に対する割合）の数値").blur();
    await expect(img).toHaveAttribute("width", /^113\.3/);

    await page.getByTestId("postcard-run").click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    const out = test.info().outputPath("hagaki.pdf");
    const dl = await clickAndDownload(page, "PDFをダウンロード");
    expect(dl.suggestedFilename()).toBe("はがき.pdf");
    await dl.saveAs(out);
    const r = JSON.parse(py(READ_PDF, [out]));
    expect(r.pages).toBe(1);
    expect(r.w).toBeCloseTo(283.46, 1);
    expect(r.h).toBeCloseTo(419.53, 1);
    expect(r.text.replace(/\s/g, "")).toContain("あけましておめでとうございます");
    expect(r.images).toHaveLength(1);
    const [iw, ih] = r.images[0];
    expect(ih / iw).toBeCloseTo(200 / 120, 1); // 画像は伸び縮みしない
  });

  test("横向きにすると、プレビューもPDFも横長になる。宛名・住所録・郵便番号の入力欄は無い", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tools/postcard");
    await page.getByTestId("postcard-orientation").getByRole("radio", { name: "横向き" }).click();
    const preview = page.getByTestId("postcard-preview");
    await expect(preview).toHaveAttribute("data-orientation", "landscape");
    await expect(preview).toHaveAttribute("viewBox", /^0 0 419\.5\d* 283\.4\d*$/);
    await page.getByTestId("postcard-add-text").click();
    await page.getByTestId("postcard-text-input").fill("暑中お見舞い申し上げます");
    await page.getByTestId("postcard-run").click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    const out = test.info().outputPath("hagaki-yoko.pdf");
    await (await clickAndDownload(page, "PDFをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ_PDF, [out]));
    expect(r.w).toBeCloseTo(419.53, 1);
    expect(r.h).toBeCloseTo(283.46, 1);
    const main = page.locator("main");
    await expect(main.getByLabel(/郵便番号|宛名|住所/)).toHaveCount(0);
  });
});
