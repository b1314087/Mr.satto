import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload } from "../helpers/tool-runner";
import { layoutPostcardImage, postcardSizePt, validatePostcard } from "@/lib/print/postcard-layout";
import {
  RECIPIENT_ZIP_BOX_LEFTS_MM,
  defaultPostcardAddress,
  layoutPostcardAddress,
  toVerticalText,
  validatePostcardAddress,
  zipDigits,
} from "@/lib/print/postcard-address-layout";
import { mmToPt } from "@/lib/print/paper-sizes";

/**
 * ハガキ作成（次期機能追加 1）。
 * - はがきの大きさ（100×148mm）・縦向き／横向き
 * - 文字（大きさ・色・位置）と画像（縦横比を保った大きさ・位置）を置き、プレビューとPDFが一致する
 * - 文字・画像の面には、宛名・住所・郵便番号の入力欄は無い（それらは宛名面：総合改修 28）
 * - 宛名面：郵便番号枠（日本郵便の様式の位置）・宛先住所・宛先氏名・差出人を縦書きで置き、プレビューとPDFが一致する
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

  test("横向きにすると、プレビューもPDFも横長になる。文字・画像の面には宛名・住所・郵便番号の入力欄は無い", async ({ page }) => {
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
    await expect(page.getByTestId("postcard-side").getByRole("radio", { name: "文字・画像の面" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("postcard-back-settings").getByLabel(/郵便番号|宛名|住所/)).toHaveCount(0);
    await expect(page.getByTestId("postcard-address-settings")).toHaveCount(0);
  });
});

plainTest.describe("宛名面の配置の計算（総合改修 28）", () => {
  plainTest("宛先の郵便番号枠：上端から12mm・右端から8mm（枠線の内側）、5.7×8mm、上3けた7.0mm間隔・下4けた6.8mm間隔", () => {
    plainExpect(RECIPIENT_ZIP_BOX_LEFTS_MM).toEqual([44.2, 51.2, 58.2, 65.9, 72.7, 79.5, 86.3]);
    plainExpect(RECIPIENT_ZIP_BOX_LEFTS_MM[6] + 5.7).toBeCloseTo(100 - 8, 5);
  });

  plainTest("郵便番号の数字は、枠の中央に1けたずつ入る。微調整すると、文字も枠も同じだけ動く", () => {
    const a = { ...defaultPostcardAddress(), recipientZip: "〒１００－０００１", recipientName: "山田太郎", printZipFrames: true };
    const ops = layoutPostcardAddress(a);
    const digits = ops.filter((o) => o.kind === "text" && o.role === "zip");
    plainExpect(digits.map((o) => (o.kind === "text" ? o.text : ""))).toEqual(["1", "0", "0", "0", "0", "0", "1"]);
    digits.forEach((o, i) => plainExpect(o.kind === "text" && o.x).toBeCloseTo(mmToPt(RECIPIENT_ZIP_BOX_LEFTS_MM[i] + 2.85), 3));
    plainExpect(ops.filter((o) => o.kind === "rect")).toHaveLength(7);
    const moved = layoutPostcardAddress({ ...a, offsetXmm: 1.5, offsetYmm: -1 });
    const d0 = digits[0];
    const m0 = moved.find((o) => o.kind === "text" && o.role === "zip")!;
    if (d0.kind === "text" && m0.kind === "text") {
      plainExpect(m0.x - d0.x).toBeCloseTo(mmToPt(1.5), 3);
      plainExpect(m0.y - d0.y).toBeCloseTo(mmToPt(-1), 3);
    }
    const r0 = ops.find((o) => o.kind === "rect")!;
    const rm = moved.find((o) => o.kind === "rect")!;
    if (r0.kind === "rect" && rm.kind === "rect") plainExpect(rm.x - r0.x).toBeCloseTo(mmToPt(1.5), 3);
  });

  plainTest("縦書き：数字は全角、番地の「-」は縦線。氏名に敬称、連名はそれぞれに敬称。枠を印刷しないときは線を描かない", () => {
    plainExpect(toVerticalText("千代田1-2-3")).toBe("千代田１｜２｜３");
    const ops = layoutPostcardAddress({ ...defaultPostcardAddress(), recipientName: "山田太郎\n花子", honorific: "sama" });
    const name = ops.filter((o) => o.kind === "text" && o.role === "name").map((o) => (o.kind === "text" ? o.text : "")).join("");
    plainExpect(name).toBe("山田太郎様花子様");
    plainExpect(ops.some((o) => o.kind === "rect" || o.kind === "line")).toBe(false);
    // 1列目（右）より2列目（左）のxが小さい
    const xs = ops.filter((o) => o.kind === "text" && o.role === "name").map((o) => (o.kind === "text" ? o.x : 0));
    plainExpect(xs[xs.length - 1]).toBeLessThan(xs[0]);
  });

  plainTest("入力の確かめ：宛先が空・郵便番号が7けたでない・差出人が空", () => {
    const base = defaultPostcardAddress();
    plainExpect(validatePostcardAddress(base)).toContain("宛先の住所か氏名");
    plainExpect(validatePostcardAddress({ ...base, recipientName: "山田", recipientZip: "12345" })).toContain("7けた");
    plainExpect(validatePostcardAddress({ ...base, recipientName: "山田", useSender: true })).toContain("差出人");
    plainExpect(validatePostcardAddress({ ...base, recipientName: "山田", recipientZip: "100-0001" })).toBeNull();
    plainExpect(zipDigits("〒100−0001")).toBe("1000001");
  });
});

test.describe("宛名面の画面（総合改修 28）", () => {
  test("郵便番号・住所・氏名・差出人を入れると、プレビューに縦書きで出て、PDFは100×148mmで同じ文字が入る", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tools/postcard");
    await page.getByTestId("postcard-side").getByRole("radio", { name: "宛名面" }).click();
    const settings = page.getByTestId("postcard-address-settings");
    const ids = await settings.locator(":scope > details").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(ids).toEqual(["postcard-recipient-section", "postcard-sender-section", "postcard-zip-section", "postcard-layout-section", "postcard-offset-section"]);
    await expect(page.getByTestId("postcard-run")).toBeDisabled();
    await page.getByTestId("postcard-recipient-zip").fill("100-0001");
    await page.getByTestId("postcard-recipient-address").fill("東京都千代田区千代田1-1");
    await page.getByTestId("postcard-recipient-name").fill("山田太郎");
    await page.getByTestId("postcard-use-sender").check();
    await page.getByTestId("postcard-sender-zip").fill("530-0001");
    await page.getByTestId("postcard-sender-address").fill("大阪府大阪市北区梅田");
    await page.getByTestId("postcard-sender-name").fill("佐藤花子");
    const preview = page.getByTestId("postcard-address-preview");
    await expect(preview.getByTestId("postcard-address-text-zip")).toHaveCount(7);
    await expect(preview.getByTestId("postcard-zip-guide")).toHaveCount(7); // 目安の点線（印刷しない）
    await expect(preview.getByTestId("postcard-zip-frame")).toHaveCount(0);
    expect((await preview.getByTestId("postcard-address-text-name").allTextContents()).join("")).toBe("山田太郎様");
    expect((await preview.getByTestId("postcard-address-text-address").allTextContents()).join("")).toBe("東京都千代田区千代田１｜１");
    await expect(preview.getByTestId("postcard-address-text-sender-zip")).toHaveText("〒530-0001");

    // 枠も印刷する
    await page.getByTestId("postcard-print-frames").check();
    await expect(preview.getByTestId("postcard-zip-frame")).toHaveCount(7);
    await expect(preview.getByTestId("postcard-zip-guide")).toHaveCount(0);

    // 氏名の位置をスライダーで動かすと、プレビューの位置が変わる
    const before = Number(await preview.getByTestId("postcard-address-text-name").first().getAttribute("x"));
    const nameX = page.getByLabel("宛先の氏名の横の位置の数値");
    await nameX.fill("40");
    await nameX.press("Enter");
    const after = Number(await preview.getByTestId("postcard-address-text-name").first().getAttribute("x"));
    expect(after).toBeLessThan(before);

    await page.getByTestId("postcard-run").click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, "PDFをダウンロード");
    expect(download.suggestedFilename()).toBe("はがき_宛名面.pdf");
    const out = test.info().outputPath("atena.pdf");
    await download.saveAs(out);
    const r = JSON.parse(py(READ_PDF, [out]));
    expect(r.pages).toBe(1);
    expect(r.w).toBeCloseTo(283.46, 1);
    expect(r.h).toBeCloseTo(419.53, 1);
    const text = (r.text as string).replace(/\s+/g, "");
    for (const s of ["1", "0", "東", "京", "山", "田", "太", "郎", "様", "佐", "藤", "花", "子", "〒530-0001"]) expect(text).toContain(s);
  });

  test("郵便番号が7けたでないときは、理由を出してPDFを作れない。面を切り替えても、入れた内容は残る", async ({ page }) => {
    await page.goto("/tools/postcard");
    await page.getByTestId("postcard-side").getByRole("radio", { name: "宛名面" }).click();
    await page.getByTestId("postcard-recipient-name").fill("山田太郎");
    await page.getByTestId("postcard-recipient-zip").fill("12345");
    await expect(page.getByTestId("postcard-problem")).toContainText("7けた");
    await expect(page.getByTestId("postcard-run")).toBeDisabled();
    await page.getByTestId("postcard-side").getByRole("radio", { name: "文字・画像の面" }).click();
    await expect(page.getByTestId("postcard-preview")).toBeVisible();
    await page.getByTestId("postcard-side").getByRole("radio", { name: "宛名面" }).click();
    await expect(page.getByTestId("postcard-recipient-name")).toHaveValue("山田太郎");
  });
});
