import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { PAGE_SIZE_GROUPS, customSizeError, resizeContentRect, resizeTargetSize } from "@/lib/pdf/overlay-layout";

/**
 * PDFページサイズ変更（総合改修 20）：選べる用紙を増やし、カスタムの大きさにも対応。
 * 書き出したPDFの全ページの大きさを pypdf で読み直して確かめる。
 */

const MM = 72 / 25.4;

function pageSizes(file: string): [number, number][] {
  return JSON.parse(
    execFileSync("python3", ["-c", "import sys,json\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nprint(json.dumps([[round(float(p.mediabox.width),1),round(float(p.mediabox.height),1)] for p in r.pages]))", file], { encoding: "utf8" })
  );
}

plainTest.describe("用紙の大きさの計算", () => {
  plainTest("A判・B判（JIS）・北米・はがき・カスタムが選べ、縦横の向きで幅と高さが入れ替わる", () => {
    const all = PAGE_SIZE_GROUPS.flatMap((g) => g.options.map((o) => o.value));
    for (const v of ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "b0", "b1", "b2", "b3", "b4", "b5", "b6", "letter", "legal", "ledger", "executive", "postcard", "custom"]) plainExpect(all).toContain(v);
    const b5 = resizeTargetSize("b5", "portrait")!;
    plainExpect(b5.width / MM).toBeCloseTo(182, 0);
    plainExpect(b5.height / MM).toBeCloseTo(257, 0);
    const ledger = resizeTargetSize("ledger", "landscape")!;
    plainExpect([ledger.width, ledger.height]).toEqual([1224, 792]);
    const custom = resizeTargetSize("custom", "portrait", { widthMm: 150, heightMm: 100 })!;
    plainExpect(custom.width / MM).toBeCloseTo(150, 1);
    plainExpect(custom.height / MM).toBeCloseTo(100, 1);
    plainExpect(resizeTargetSize("custom", "landscape", { widthMm: 150, heightMm: 100 })!.width / MM).toBeCloseTo(100, 1);
  });

  plainTest("カスタムの大きさが範囲外・空のときは理由を返し、書き出さない", () => {
    plainExpect(customSizeError({ widthMm: 5, heightMm: 100 })).toMatch(/10〜2000mm/);
    plainExpect(customSizeError({ widthMm: NaN, heightMm: 100 })).toMatch(/数字/);
    plainExpect(resizeTargetSize("custom", "portrait", { widthMm: 5, heightMm: 100 })).toBeNull();
    plainExpect(customSizeError({ widthMm: 150, heightMm: 100 })).toBeNull();
  });

  plainTest("内容は縦横比を保って拡大縮小し、中央に置く（切れない）", () => {
    const r = resizeContentRect(595.28, 841.89, 1224, 792, "fit");
    plainExpect(r.width).toBeLessThanOrEqual(1224 + 0.01);
    plainExpect(r.height).toBeLessThanOrEqual(792 + 0.01);
    plainExpect(r.width / r.height).toBeCloseTo(595.28 / 841.89, 3);
    plainExpect(r.x).toBeCloseTo((1224 - r.width) / 2, 3);
  });
});

test.describe("PDFページサイズ変更の画面", () => {
  test("B5（JIS）・横向きに変更：複数ページのPDFの全ページが同じ大きさになる。プレビューでページを送れる", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/tools/pdf-resize-pages");
    await uploadFixture(page, fixtures.multiPagePdf);
    await page.getByTestId("resize-size-b5").click();
    await page.getByRole("button", { name: "横向き" }).click();
    await expect(page.getByTestId("tool-preview")).toContainText("変更後: B5・横(257×182mm)");
    await expect(page.getByTestId("resize-preview-pager")).toBeVisible();
    await page.getByRole("button", { name: "次のページ" }).click();
    await expect(page.getByTestId("tool-preview")).toContainText("2ページ目");
    await page.getByRole("button", { name: "変更する" }).click();
    await waitForSuccess(page, "完了");
    const out = test.info().outputPath("b5.pdf");
    await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
    const sizes = pageSizes(out);
    expect(sizes.length).toBeGreaterThan(1);
    for (const [w, h] of sizes) {
      expect(w / MM).toBeCloseTo(257, 0);
      expect(h / MM).toBeCloseTo(182, 0);
    }
  });

  test("カスタム（150×100mm）に変更できる。範囲外の値は理由が出て、変更できない", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/tools/pdf-resize-pages");
    await uploadFixture(page, fixtures.singlePagePdf);
    await page.getByTestId("resize-size-custom").click();
    await page.getByTestId("resize-custom-width").fill("5");
    await expect(page.getByTestId("resize-custom-error")).toContainText("10〜2000mm");
    await expect(page.getByRole("button", { name: "変更する" })).toBeDisabled();
    await page.getByTestId("resize-custom-width").fill("150");
    await page.getByTestId("resize-custom-height").fill("100");
    await expect(page.getByTestId("resize-custom-error")).toHaveCount(0);
    await expect(page.getByTestId("tool-preview")).toContainText("(150×100mm)");
    await page.getByRole("button", { name: "変更する" }).click();
    await waitForSuccess(page, "完了");
    const out = test.info().outputPath("custom.pdf");
    await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
    const [[w, h]] = pageSizes(out);
    expect(w / MM).toBeCloseTo(150, 0);
    expect(h / MM).toBeCloseTo(100, 0);
  });

  test("Ledger（Tabloid）・Letter・はがきなども選べる", async ({ page }) => {
    await page.goto("/tools/pdf-resize-pages");
    await uploadFixture(page, fixtures.singlePagePdf);
    for (const id of ["a0", "a6", "b0", "b6", "letter", "legal", "ledger", "executive", "postcard"]) {
      await page.getByTestId(`resize-size-${id}`).click();
      await expect(page.getByTestId(`resize-size-${id}`)).toHaveAttribute("aria-checked", "true");
    }
    await expect(page.getByTestId("tool-preview")).toContainText("はがき");
  });
});
