import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { bars, pageCount, pdfText, render, words, type Pred, type Word } from "../helpers/chart-pdf-inspect";

/**
 * Excel→PDF：グラフの分類の軸の項目名(目盛りの文字)の表示(14種類)。
 *
 * テスト用のExcelは tests/fixtures/static/excel-chart-labels/(架空のデータのみ。
 * tests/fixtures/excel-chart/generate_ooxml_chart_fixtures.py で、Excel 2016以降のOOXMLの形で作る)。
 * 項目の数・項目名の長さに応じて、横書き・折り返し・斜め・間引きを選ぶこと、間引いても系列のデータは減らないこと、
 * 先頭と末尾の項目を表示すること、Excel側の間隔(tickLblSkip)・角度(rot)の指定を守ること、文字どうしが重ならないことを確かめる。
 * Excel本体の描画と直接比べたものではない(同じファイルのLibreOfficeのPDFと見比べて確認した)。
 */

const SRC = path.join(__dirname, "..", "fixtures", "static", "excel-chart-labels");

async function convert(page: Page, name: string, timeoutMs = 120_000): Promise<{ pdf: string; screen: string; ms: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xllabels-"));
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, path.join(SRC, name));
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  const t0 = Date.now();
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", timeoutMs);
  const ms = Date.now() - t0;
  const screen = await page.locator("main").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, screen, ms };
}

const accent1: Pred = (r, g, b) => Math.abs(r - 68) < 25 && Math.abs(g - 114) < 25 && Math.abs(b - 196) < 25;

/** 全ページの文字(ページ番号つき) */
function allWords(pdf: string): (Word & { page: number })[] {
  const out: (Word & { page: number })[] = [];
  for (let p = 1; p <= pageCount(pdf); p++) for (const w of words(pdf, p)) out.push({ ...w, page: p });
  return out;
}
/**
 * グラフの分類の軸の項目名だけを取り出す。表のセルの文字(A列〜)と区別するため、
 * 1ページ目のグラフの中の最初の項目名(first)と同じ高さの文字だけを、表の無いページ(=グラフの右側の列のページ)と
 * 1ページ目のグラフの中(x>200)から集める。表のページは、上の方(y<120)の左端(x<120)に表の文字があるページ
 */
function axisLabels(ws: (Word & { page: number })[], re: RegExp, first: string): (Word & { page: number })[] {
  const anchor = ws.find((w) => w.page === 1 && w.text === first && w.x > 200);
  if (!anchor) return [];
  const tablePages = new Set(ws.filter((w) => re.test(w.text) && w.y < 120 && w.x < 120).map((w) => w.page));
  return ws.filter((w) => re.test(w.text) && Math.abs(w.y - anchor.y) < 4 && (w.page === 1 ? w.x > 200 : !tablePages.has(w.page)));
}
/** 同じページで、別の項目名の文字の四角どうしが重ならない(1つの項目名の折り返した行どうし=中心が同じ、は除く) */
function expectNoOverlap(ws: (Word & { page: number })[]) {
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i];
      const b = ws[j];
      if (a.page !== b.page) continue;
      if (Math.abs((a.x + a.x2) / 2 - (b.x + b.x2) / 2) < 2 && a.y !== b.y) continue;
      const overlap = Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y, b.y) > 0.5;
      expect(overlap, `「${a.text}」と「${b.text}」が重なっている(${a.page}ページ目)`).toBe(false);
    }
  }
}
/** 全ページの棒の数 */
function totalBars(pdf: string): number {
  let n = 0;
  for (let p = 1; p <= pageCount(pdf); p++) n += bars(render(pdf, p), accent1).length;
  return n;
}
const texts = (ws: Word[]) => ws.map((w) => w.text);

test.describe.configure({ mode: "parallel" });

test("y01 項目数10：全部の項目名を横書きで表示し、重ならない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y01-count-10.xlsx");
  const labels = axisLabels(allWords(pdf), /^\d+月$/, "1月");
  for (let m = 1; m <= 10; m++) expect(texts(labels)).toContain(`${m}月`);
  expectNoOverlap(labels);
});

test("y02 項目数30：横書きのまま間引く(先頭と末尾は表示)。棒は30本すべて描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y02-count-30.xlsx");
  const labels = axisLabels(allWords(pdf), /^商品\d+$/, "商品01");
  expect(texts(labels)).toContain("商品01");
  expect(texts(labels)).toContain("商品30");
  expect(labels.length).toBeLessThan(30);
  expect(labels.length).toBeGreaterThanOrEqual(10);
  expectNoOverlap(labels);
  expect(totalBars(pdf)).toBe(30);
});

test("y03 項目数100(折れ線)：間引いて重ならず、先頭と末尾を表示", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y03-count-100.xlsx");
  const labels = axisLabels(allWords(pdf), /^No\.\d{3}$/, "No.001");
  expect(texts(labels)).toContain("No.001");
  expect(texts(labels)).toContain("No.100");
  expect(labels.length).toBeLessThan(30);
  expectNoOverlap(labels);
});

test("y04 項目数500(折れ線)：間引いて重ならない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y04-count-500.xlsx");
  const labels = axisLabels(allWords(pdf), /^ID-\d{4}$/, "ID-0001");
  expect(texts(labels)).toContain("ID-0001");
  expect(texts(labels)).toContain("ID-0500");
  expect(labels.length).toBeLessThan(30);
  expectNoOverlap(labels);
});

test("y05 項目数3000(折れ線)：間引いて重ならず、実用的な時間で変換できる", async ({ page }) => {
  test.setTimeout(240_000);
  const { pdf, ms } = await convert(page, "y05-count-3000.xlsx", 200_000);
  expect(pageCount(pdf)).toBe(78);
  // 分類の軸の文字(グラフの中の数字。グラフは1ページ目と、右側の列のページ(40ページ目)にかかる)
  const labels = axisLabels(allWords(pdf), /^\d+$/, "1");
  expect(labels.length).toBeGreaterThanOrEqual(4);
  expect(labels.length).toBeLessThan(40);
  expect(texts(labels)).toContain("1");
  expect(texts(labels)).toContain("3000");
  expectNoOverlap(labels);
  expect(ms).toBeLessThan(150_000);
});

test("y06 長い日本語の項目名：折り返して全部を表示(「…」で切らない)、行は3行まで、重ならない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y06-long-japanese.xlsx");
  const ws = allWords(pdf).filter((w) => !(w.page === 1 && w.x < 200) && w.y > 300 && w.y < 420);
  const joined = ws.map((w) => w.text).join("");
  for (const s of ["北海道・", "東北地方の営業所", "（札幌・仙台）", "関東地方の本社営業", "九州・", "沖縄地方の営業所", "（福岡）"]) expect(joined).toContain(s);
  expect(joined).not.toContain("…");
  expectNoOverlap(ws);
  // 1つの項目名は3行まで：同じ横位置(中心)の行の数
  const byCenter = new Map<string, number>();
  for (const w of ws) {
    const k = `${w.page}:${Math.round((w.x + w.x2) / 2 / 20)}`;
    byCenter.set(k, (byCenter.get(k) ?? 0) + 1);
  }
  for (const n of byCenter.values()) expect(n).toBeLessThanOrEqual(4); // 隣の項目の行が同じ枠に入る誤差を見込む
});

test("y07 英数字と日本語の混在：英数字の単語の途中では改行しない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y07-mixed-alnum-japanese.xlsx");
  const all = allWords(pdf).filter((w) => !(w.page === 1 && w.x < 200));
  const t = texts(all);
  for (const s of ["iPhone", "Galaxy", "Ultra", "512GB", "Pixel", "Xperia", "AQUOS", "sense8", "SH-54D"]) expect(t).toContain(s);
  expect(t.join("")).not.toContain("…");
});

test("y08 日付の横軸：日付の形式で間引いて表示し、重ならない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y08-date-axis.xlsx");
  const labels = axisLabels(allWords(pdf), /^2026\/\d+\/\d+$/, "2026/1/1");
  expect(texts(labels)).toContain("2026/1/1");
  expect(labels.length).toBeGreaterThan(4);
  expect(labels.length).toBeLessThan(25);
  expectNoOverlap(labels);
});

test("y09 長さが不均一な項目名：短い名前はそのまま、長い名前は読みやすい位置で折り返す", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y09-uneven-length.xlsx");
  const ws = allWords(pdf).filter((w) => !(w.page === 1 && w.x < 200) && w.y > 300 && w.y < 400);
  const t = texts(ws);
  for (const s of ["A", "東京", "B社", "C", "千葉"]) expect(t).toContain(s);
  // 「神奈川県横浜市」は 神奈川県 ／ 横浜市 で折り返す(1文字だけの行を作らない)
  expect(t).toContain("神奈川県");
  expect(t).toContain("横浜市");
  expect(t.join("")).not.toContain("…");
  expectNoOverlap(ws);
});

test("y10 横棒：長い項目名を左に表示し、項目数40は間引いて重ならない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y10-horizontal-bar.xlsx");
  const all = allWords(pdf);
  expect(pdfText(pdf, 1).replace(/\s/g, "")).toContain("北海道・東北地方の営業所（札幌・仙台）");
  // 項目数40のグラフは1・2ページ目(表の「支店」の列は、右の方の列のページにある)
  const shops = all.filter((w) => /^支店\d+$/.test(w.text) && w.x > 150 && w.page <= 2);
  expect(texts(shops)).toContain("支店01");
  expect(texts(shops)).toContain("支店40");
  expect(shops.length).toBeLessThan(40);
  expectNoOverlap(shops);
});

test("y11 折れ線・36か月：項目名を重ならないように並べ、先頭と末尾を表示", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y11-line-36-months.xlsx");
  const labels = axisLabels(allWords(pdf), /^20\d\d年\d+月$/, "2024年1月");
  expect(texts(labels)).toContain("2024年1月");
  expect(texts(labels)).toContain("2026年12月");
  expectNoOverlap(labels);
});

test("y12 複合(縦棒＋折れ線)：長めの項目名を斜めにして表示し、棒は20本すべて描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y12-combo.xlsx");
  const t = (pdfText(pdf, 1) + pdfText(pdf, 2)).replace(/\s/g, "");
  expect(t).toContain("第2四半期");
  expect(totalBars(pdf)).toBe(20);
});

test("y13 凡例・タイトル・軸のタイトル：項目名と重ならない(上から 項目名 → 軸のタイトル → 凡例)", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y13-title-legend-axis-titles.xlsx");
  const ws = words(pdf, 1).filter((w) => w.x > 200);
  const axisTitle = ws.find((w) => w.text === "月度")!;
  const legend = ws.find((w) => w.text === "売上" && w.y > axisTitle.y)!;
  const catLines = ws.filter((w) => /月度|四半期|^（第/.test(w.text) && w !== axisTitle);
  expect(catLines.length).toBeGreaterThan(5);
  for (const c of catLines) expect(c.y2).toBeLessThanOrEqual(axisTitle.y + 1);
  expect(legend.y).toBeGreaterThanOrEqual(axisTitle.y2 - 1);
  expect(texts(ws)).toContain("月度別の売上と費用");
});

test("y14 Excelの指定：間隔3・45度、縦書き90度、横書き・間隔2 をそのまま守る", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "y14-explicit-skip-rotation.xlsx");
  // ① 間隔3・45度 と ② 縦書き90度 の項目名の数を比べる(1ページ目のグラフの中。斜めの文字は1文字ずつ取り出されるので「商」の数で数える)
  const w1 = words(pdf, 1).filter((w) => w.x > 150);
  const t1 = w1.find((w) => w.text === "間隔3・45度")!;
  const t2 = w1.find((w) => w.text === "縦書き90度")!;
  const t3 = w1.find((w) => w.text === "横書き・間隔2")!;
  const count = (from: Word, to: Word) =>
    w1
      .filter((w) => w.y > from.y2 && w.y < to.y)
      .map((w) => w.text)
      .join("")
      .split("商").length - 1;
  const n1 = count(t1, t2);
  const n2 = count(t2, t3);
  expect(n1).toBeGreaterThanOrEqual(6); // 30項目のうち、間隔3で1ページ目に入る 01・04・07・10・13・16・19(右端の1つを含めて7〜8)
  expect(n1).toBeLessThanOrEqual(9);
  expect(n2).toBeGreaterThanOrEqual(20); // 縦書きは間引かずに入る(1ページ目に23項目)
  expect(w1.filter((w) => w.y > t2.y2 && w.y < t3.y).map((w) => w.text)).toContain("商品02");
  // ③ 横書き・間隔2：2ページ目のグラフの下端に、商品/01・03・05… を横書き(折り返し)で表示
  const p2 = words(pdf, 2);
  const nums = p2.filter((w) => /^\d\d$/.test(w.text) && w.x > 150).map((w) => w.text);
  expect(nums).toContain("01");
  expect(nums).toContain("03");
  expect(nums).not.toContain("02");
});
