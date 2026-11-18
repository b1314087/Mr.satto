import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import * as lib from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { parseContentStream } from "@/lib/pdf-text-edit/content-tokens";
import { buildTextGuides, nearestGuide } from "@/lib/pdf-text-edit/guides";
import { fixtures } from "../fixtures/paths";
import { uploadWhenReady } from "../helpers/tool-ready";
import { clickAndDownload, closeResultPopup, waitForSuccess } from "../helpers/tool-runner";
import { choosePdfFixOperation } from "../helpers/pdf-fix-operation";
import { analyzeNode, eraseSentencesNode, glyphPositions } from "../helpers/pdf-text-node";

/**
 * PDF修正「文字を消す（文単位）」と「位置合わせの目印（もともとの文字の書き始め・基準線）」（2026-11-18）
 * - 前半：部品（描く命令の読み取り・文の分け方・消し方・目印）を、Node の pdf.js で確かめる
 * - 後半：画面（文を選んで消す・戻す・書き出したPDFに文字が残らない・スキャンPDFの案内・目印の点線と吸い付き）
 */

const CANVAS = '[data-testid="pdf-annotate-canvas"]';

/** 標準フォント（Helvetica）で、描く命令を直接書いたPDFを作る（文字間隔・単語間隔・横の縮小・TJ・'・" を含められる） */
async function rawContentPdf(content: (font: string) => string): Promise<Uint8Array> {
  const doc = await lib.PDFDocument.create();
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const key = page.node.newFontDictionary("F1", font.ref).asString().replace(/^\//, "");
  const stream = doc.context.flateStream(content(key));
  page.node.set(lib.PDFName.of("Contents"), doc.context.register(stream));
  return doc.save();
}

async function mixedPdf(): Promise<Uint8Array> {
  const doc = await lib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const jp = await doc.embedFont(fs.readFileSync("public/fonts/NotoSansJP-Regular.ttf"), { subset: true });
  const hv = await doc.embedFont(lib.StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText("First sentence here. Second sentence follows.", { x: 20, y: 350, size: 12, font: hv });
  page.drawText("今日は晴れです。明日は雨です。", { x: 20, y: 320, size: 12, font: jp });
  page.drawText("This long sentence keeps going until it reaches\nacross two lines. Next one.", { x: 20, y: 280, size: 12, font: hv, lineHeight: 15 });
  return doc.save();
}

// ---------------------------------------------------------------------------
// 1. 部品
// ---------------------------------------------------------------------------
plainTest.describe("文字を消す：部品", () => {
  plainTest("描く命令を読み取れる（エスケープ・16進の文字列・配列・辞書・画像を直接書く命令）", () => {
    const src = "q 1 0 0 1 10 20 cm BT /F1 12 Tf (a\\(b\\)\\101\\n) Tj [<0041> -250 (B)] TJ ET /Span <</ActualText (X)>> BDC EMC BI /W 1 /H 1 ID \x00\xffEI\n EI Q";
    const ops = parseContentStream(new TextEncoder().encode(src.replace(/[\x00\xff]/g, "z")));
    plainExpect(ops.map((o) => o.operator)).toEqual(["q", "cm", "BT", "Tf", "Tj", "TJ", "ET", "BDC", "EMC", "BI", "Q"]);
    const tj = ops[4].operands[0];
    plainExpect(tj.kind === "string" && new TextDecoder().decode(tj.bytes)).toBe("a(b)A\n");
    const arr = ops[5].operands[0];
    plainExpect(arr.kind === "array" && arr.items.map((i) => i.kind)).toEqual(["string", "number", "string"]);
    const dict = ops[7].operands[1];
    plainExpect(dict.kind === "dict" && dict.entries[0].key).toBe("ActualText");
  });

  plainTest("文に分ける：「。」「.」で区切り、行をまたぐ文は1つにする。「1.5」の途中では区切らない", async () => {
    const a = await analyzeNode(await mixedPdf());
    plainExpect(a.aligned).toBe(true);
    plainExpect(a.sentences.map((s) => s.text)).toEqual([
      "First sentence here.",
      "Second sentence follows.",
      "今日は晴れです。",
      "明日は雨です。",
      "This long sentence keeps going until it reaches across two lines.",
      "Next one.",
    ]);
    // 行をまたぐ文は、行ごとの範囲を2つ持つ
    plainExpect(a.sentences[4].boxes).toHaveLength(2);
    const dec = await analyzeNode(await rawContentPdf((f) => `BT /${f} 12 Tf 20 300 Td (Version 1.5 is out. Next.) Tj ET`));
    plainExpect(dec.sentences.map((s) => s.text)).toEqual(["Version 1.5 is out.", "Next."]);
  });

  plainTest("文を消すと、その文字はデータから消え、ほかの文字の位置は動かない（日本語・欧文・行をまたぐ文）", async () => {
    const bytes = await mixedPdf();
    const before = await analyzeNode(bytes);
    const out = await eraseSentencesNode(bytes, ["Second", "明日", "This long"]);
    const after = await analyzeNode(out);
    plainExpect(after.sentences.map((s) => s.text)).toEqual(["First sentence here.", "今日は晴れです。", "Next one."]);
    // 残った文字は、1文字ずつ、消す前と同じ位置
    const keep = new Set(glyphPositions(after));
    const kept = glyphPositions(before).filter((p) => keep.has(p));
    plainExpect(kept.length).toBe(keep.size);
    // 書き出したPDFの文字（pdftotext）にも残らない
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "erase-")), "out.pdf");
    fs.writeFileSync(file, out);
    const text = execFileSync("pdftotext", [file, "-"]).toString();
    plainExpect(text).toContain("First sentence here.");
    plainExpect(text).toContain("今日は晴れです。");
    plainExpect(text).not.toContain("Second");
    plainExpect(text).not.toContain("明日");
    plainExpect(text).not.toContain("across");
  });

  plainTest("文字間隔・単語間隔・横の縮小・TJ の間隔・' と \" があっても、残りの文字の位置は動かない", async () => {
    const bytes = await rawContentPdf(
      (f) =>
        `BT /${f} 12 Tf 1.5 Tc 4 Tw 90 Tz 16 TL 20 350 Td (Alpha one. Beta two.) Tj [(Gam) -120 (ma three. Delta) 300 ( four.)] TJ (Epsilon five. Zeta.) ' 2 0.5 (Eta six. Theta.) " ET`,
    );
    const before = await analyzeNode(bytes);
    plainExpect(before.aligned).toBe(true);
    const out = await eraseSentencesNode(bytes, ["Beta", "Gamma", "Epsilon", "Theta"]);
    const after = await analyzeNode(out);
    plainExpect(after.sentences.map((s) => s.text).join(" | ")).not.toMatch(/Beta|Gamma|Epsilon|Theta/);
    const keep = glyphPositions(after);
    const all = new Set(glyphPositions(before));
    for (const p of keep) plainExpect(all.has(p), p).toBe(true);
    plainExpect(keep.length).toBeGreaterThan(10);
  });

  plainTest("読み上げ用の文字（ActualText）を持つ囲みの中の文字を消すと、読み上げ用の文字も消える", async () => {
    const bytes = await rawContentPdf((f) => `/Span <</ActualText (Secret word.) /Lang (en)>> BDC BT /${f} 12 Tf 20 300 Td (Secret word.) Tj ET EMC BT /${f} 12 Tf 20 280 Td (Keep me.) Tj ET`);
    const out = await eraseSentencesNode(bytes, ["Secret"]);
    const doc = await lib.PDFDocument.load(out);
    const { readPageContent } = await import("../helpers/pdf-text-node");
    const content = new TextDecoder("latin1").decode(await readPageContent(doc, 0));
    plainExpect(content).not.toContain("ActualText");
    plainExpect(content).toContain("/Lang");
    plainExpect((await analyzeNode(out)).sentences.map((s) => s.text)).toEqual(["Keep me."]);
  });

  plainTest("位置合わせの目印：行の先頭と、同じ行で大きく離れて始まる位置・基準線を作り、近いときだけ吸い付く", () => {
    const g = buildTextGuides([
      { x0: 20, x1: 120, baseY: 350, size: 12 },
      { x0: 125, x1: 200, baseY: 350.2, size: 12 },
      { x0: 260, x1: 300, baseY: 350, size: 12 },
      { x0: 20.3, x1: 90, baseY: 320, size: 12 },
    ]);
    plainExpect(g.xs).toEqual([20, 260]);
    plainExpect(g.ys).toEqual([320, 350]);
    plainExpect(nearestGuide(22, g.xs, 3)).toBe(20);
    plainExpect(nearestGuide(25, g.xs, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------
async function writeTmpPdf(bytes: Uint8Array, name: string): Promise<string> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "erase-ui-")), name);
  fs.writeFileSync(file, bytes);
  return file;
}

async function openWithPdf(page: import("@playwright/test").Page, file: string) {
  await page.goto("/tools/pdf-fix");
  await uploadWhenReady(page, file, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
}

/** PDFの点（左下が原点、pt）を、画面の座標にする */
async function toScreen(page: import("@playwright/test").Page, x: number, y: number, pageHeight = 400, pageWidth = 400) {
  // プレビューを画面の中に出してから測る（画面の外の位置には、マウスを動かせない）
  await page.locator(CANVAS).evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await page.locator(`${CANVAS} img`).boundingBox())!;
  const scale = box.width / pageWidth;
  return { x: box.x + x * scale, y: box.y + (pageHeight - y) * scale, scale };
}

async function exportedText(page: import("@playwright/test").Page): Promise<{ text: string; file: string }> {
  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await waitForSuccess(page, "書き出しが完了しました");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "erase-out-")), "out.pdf");
  await download.saveAs(file);
  await closeResultPopup(page);
  return { text: execFileSync("pdftotext", [file, "-"]).toString(), file };
}

test.describe("PDF修正：文字を消す（文単位）", () => {
  test("文を押して選び、Deleteで消す。書き出したPDFからその文字は消え、ほかの文は残る。1つ前に戻すと元に戻る", async ({ page }) => {
    const file = await writeTmpPdf(await mixedPdf(), "mixed.pdf");
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await openWithPdf(page, file);
    await choosePdfFixOperation(page, "文字を消す");
    await expect(page.getByTestId("pdf-erase-panel")).toBeVisible();
    await expect(page.getByTestId("pdf-erase-loading")).toHaveCount(0, { timeout: 20_000 });

    // 「Second sentence follows.」（基準線 350、x はおよそ 135〜260）を押す
    const pt = await toScreen(page, 190, 353);
    await page.mouse.move(pt.x, pt.y);
    await expect(page.getByTestId("pdf-erase-hover").first()).toBeVisible();
    await page.mouse.click(pt.x, pt.y);
    await expect(page.getByTestId("pdf-erase-selected")).toHaveCount(1);
    await expect(page.getByTestId("pdf-erase-run")).toHaveText(/選んだ文を消す（1）/);
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("pdf-erase-message")).toHaveText("1つの文を消しました。", { timeout: 20_000 });
    await expect(page.getByTestId("pdf-erase-selected")).toHaveCount(0);

    let out = await exportedText(page);
    expect(out.text).toContain("First sentence here.");
    expect(out.text).toContain("今日は晴れです。");
    expect(out.text).not.toContain("Second sentence");

    // 行をまたぐ文も、ボタンで消せる（書き出したあとも、文字を消す操作のまま）
    await expect(page.getByTestId("pdf-erase-loading")).toHaveCount(0, { timeout: 20_000 });
    const pt2 = await toScreen(page, 60, 283);
    await page.mouse.click(pt2.x, pt2.y);
    await expect(page.getByTestId("pdf-erase-selected")).toHaveCount(2); // 2行にまたがる文
    await page.getByTestId("pdf-erase-run").click();
    await expect(page.getByTestId("pdf-erase-message")).toHaveText("1つの文を消しました。", { timeout: 20_000 });
    out = await exportedText(page);
    expect(out.text).not.toContain("across two lines");
    expect(out.text).toContain("Next one.");

    // 1つ前に戻す → 行をまたぐ文が戻る（Second は消えたまま）
    await page.getByTestId("pdf-erase-undo").click();
    out = await exportedText(page);
    expect(out.text).toContain("across two lines");
    expect(out.text).not.toContain("Second sentence");
    expect(errors.filter((e) => !/favicon|Failed to load resource|eval\(\) is not supported/.test(e))).toEqual([]);
  });

  test("スキャンしたPDF（文字の情報がない）では、白消しを使うよう案内する", async ({ page }) => {
    await openWithPdf(page, fixtures.templateBlankScannedPdf);
    await choosePdfFixOperation(page, "文字を消す");
    await expect(page.getByTestId("pdf-erase-no-text")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("pdf-erase-run")).toBeDisabled();
  });
});

test.describe("PDF修正：位置合わせの目印", () => {
  test("文字を書き込むとき、もともとの文字の書き始め・基準線の近くでは点線が出て、押すとその位置にぴったり置かれる", async ({ page }) => {
    const file = await writeTmpPdf(await mixedPdf(), "guide.pdf");
    await openWithPdf(page, file);
    await choosePdfFixOperation(page, "テキスト");
    await expect(page.locator(CANVAS)).toHaveAttribute("data-text-guides", /^[1-9]/, { timeout: 20_000 });
    // 「First sentence here.」の書き始め（x=20、基準線350）の少し右下を指す（文字の大きさ14のとき、押した位置の4.2pt下が基準線になる）
    const target = await toScreen(page, 21.2, 350 + 4.2 + 0.8);
    await page.mouse.move(target.x - 30, target.y - 40);
    await page.mouse.move(target.x, target.y, { steps: 3 });
    await expect(page.getByTestId("pdf-text-guide-x")).toBeVisible();
    await expect(page.getByTestId("pdf-text-guide-y")).toBeVisible();
    await page.mouse.click(target.x, target.y);
    await page.keyboard.type("ZQX");
    await page.keyboard.press("Escape");
    const out = await exportedText(page);
    // 書き出したPDFで、書き込んだ文字の左端が、もともとの文字の左端（20pt）と同じ
    const bbox = execFileSync("pdftotext", ["-bbox", out.file, "-"]).toString();
    const m = bbox.match(/<word xMin="([\d.]+)" yMin="[\d.]+" xMax="[\d.]+" yMax="([\d.]+)">ZQX<\/word>/);
    expect(m, bbox).not.toBeNull();
    expect(Math.abs(Number(m![1]) - 20)).toBeLessThan(0.6);
  });
});
