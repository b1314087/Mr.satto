import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { bars, components, countPixels, pageCount, pdfText, render, words, type Box, type Pred, type Word } from "../helpers/chart-pdf-inspect";

/**
 * Excel→PDF：Excel本体が保存するファイルの構造(OOXML)をまねたExcelでの、グラフの互換性の検証(25種類)。
 *
 * テスト用のExcelは tests/fixtures/static/excel-chart-ooxml/(架空のデータのみ)。
 * tests/fixtures/excel-chart/generate_ooxml_chart_fixtures.py で、LibreOfficeを通さずにXMLから直接作っている
 * (c14:style の包み・c16:uniqueId・テーマ色の明暗で書いた色・sharedStrings・游ゴシック 等、Excel 2016以降の形)。
 * 作るときに、ZIPの中のXMLがすべて読めること・関係(rels)の参照先・Content Types・r:id の不整合が無いことも確かめている。
 *
 * これは「Excel本体が保存したファイル」そのものではなく、Excel本体での表示と直接比べたものでもない。
 * 同じファイルをLibreOfficeでPDFにした結果と、ページ数・グラフの種類・目盛り・凡例・位置を見比べて確認した。
 */

const SRC = path.join(__dirname, "..", "fixtures", "static", "excel-chart-ooxml");

async function convert(page: Page, name: string, timeoutMs = 120_000): Promise<{ pdf: string; screen: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlooxml-"));
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, path.join(SRC, name));
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", timeoutMs);
  const screen = await page.locator("main").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, screen };
}

// テーマ(Office 2013〜2022)のアクセント色
const accent1: Pred = (r, g, b) => Math.abs(r - 68) < 25 && Math.abs(g - 114) < 25 && Math.abs(b - 196) < 25; // #4472C4
const accent2: Pred = (r, g, b) => Math.abs(r - 237) < 20 && Math.abs(g - 125) < 25 && Math.abs(b - 49) < 30; // #ED7D31
const purpleImg: Pred = (r, g, b) => Math.abs(r - 112) < 15 && Math.abs(g - 48) < 15 && Math.abs(b - 160) < 15;

const NOTICE = "グラフは、Excelの見た目に近づけて描いています";
/** タイトルの文字から下、次のタイトルの上まで(同じ列にあるグラフの範囲) */
const below = (top: Word, bottom: Word | undefined, img: { w: number; h: number }): Box => ({ x0: 0, y0: top.y2, x1: img.w, y1: bottom ? bottom.y : img.h });

test.describe.configure({ mode: "parallel" });

test("x01 Excel標準の縦棒：2系列の棒・タイトル・凡例。グラフ フィルターで隠した系列は描かない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf, screen } = await convert(page, "x01-standard-column.xlsx");
  const img = render(pdf, 1);
  expect(bars(img, accent1).length).toBeGreaterThanOrEqual(4);
  expect(bars(img, accent2).length).toBeGreaterThanOrEqual(4);
  const ws = words(pdf, 1);
  const title = ws.find((w) => w.text.startsWith("月別の売上"))!;
  expect(title).toBeTruthy();
  // 凡例(タイトルより下・グラフの中)に、売上・費用はあり、隠した「予備」は無い(表の見出しの「予備」は左の表にある)
  const inChart = ws.filter((w) => w.x > title.x - 120 && w.y > title.y2);
  expect(inChart.some((w) => w.text === "売上")).toBe(true);
  expect(inChart.some((w) => w.text === "費用")).toBe(true);
  expect(inChart.some((w) => w.text === "予備")).toBe(false);
  expect(screen).toContain(NOTICE);
});

test("x02 値の控えなし・数式のセル：参照しているセル(計算結果)から値を読んで描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x02-no-cache-formula.xlsx");
  // 1ページ目に1月・2月の棒(300・480)。折れ線が棒を横切って塊が分かれるので、同じ横位置の塊をまとめる
  const parts = bars(render(pdf, 1), accent1, undefined, 2);
  const cols = new Map<number, { y0: number; y1: number }>();
  for (const c of parts) {
    const k = Math.round(c.x0 / 4);
    const prev = cols.get(k);
    cols.set(k, { y0: Math.min(prev?.y0 ?? Infinity, c.y0), y1: Math.max(prev?.y1 ?? -Infinity, c.y1) });
  }
  const b = [...cols.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
  expect(b.length).toBeGreaterThanOrEqual(2);
  const h = b.map((c) => c.y1 - c.y0 + 1);
  expect(Math.abs(h[1] / h[0] - 480 / 300)).toBeLessThan(0.08);
  expect(countPixels(render(pdf, 1), accent2)).toBeGreaterThan(30); // 単価の折れ線
});

test("x03 空白のセル：空白=gap / zero / span の3つのグラフを描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x03-blank-cells.xlsx");
  expect(pageCount(pdf)).toBe(4);
  const t = pdfText(pdf, 1).replace(/\s/g, "");
  for (const s of ["空白=gap", "空白=zero", "空白=span"]) expect(t).toContain(s);
  const img = render(pdf, 1);
  const ws = words(pdf, 1);
  const gapT = ws.find((w) => w.text === "空白=gap")!;
  const zeroT = ws.find((w) => w.text === "空白=zero")!;
  const spanT = ws.find((w) => w.text === "空白=span")!;
  // zero のグラフは、空白(3月)の点が0まで下がる＝線が gap のグラフより縦に長く伸びる
  const lineH = (area: Box) => {
    const c = components(img, accent1, 10, area).sort((a, b2) => b2.n - a.n)[0];
    return c ? c.y1 - c.y0 : 0;
  };
  expect(lineH(below(zeroT, spanT, img))).toBeGreaterThan(lineH(below(gapT, zeroT, img)) + 30);
});

test("x04 非表示の行：値の控えが無いときも、非表示の行(4月=999)はグラフに出さない。plotVisOnly=0 なら出す", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x04-hidden-rows.xlsx");
  const img = render(pdf, 1);
  const ws = words(pdf, 1);
  const t1 = ws.find((w) => w.text === "控えあり")!;
  const t2 = ws.find((w) => w.text === "控えなし")!;
  const t3 = ws.find((w) => w.text === "非表示も表示")!;
  expect(bars(img, accent1, below(t1, t2, img))).toHaveLength(4);
  expect(bars(img, accent1, below(t2, t3, img))).toHaveLength(4);
  expect(bars(img, accent1, below(t3, undefined, img))).toHaveLength(5);
});

test("x05 リッチテキストのタイトル・テーマ色の明暗・透明度・グラフと描画領域の背景色と枠線", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x05-rich-title-theme.xlsx");
  const img = render(pdf, 1);
  const t = pdfText(pdf, 1).replace(/\s/g, "");
  expect(t).toContain("地域別の売上");
  expect(t).toContain("（単位：千円）");
  // 東日本：accent1 を50%に暗くした紺(#203864付近)
  expect(countPixels(img, (r, g, b) => Math.abs(r - 32) < 15 && Math.abs(g - 56) < 15 && Math.abs(b - 100) < 18)).toBeGreaterThan(300);
  // 西日本(透明度50%)が東日本に重なった所は、2色が混ざった色になる(不透明で塗りつぶさない)
  expect(countPixels(img, (r, g, b) => r > 110 && r < 170 && g > 95 && g < 150 && b > 100 && b < 160 && Math.abs(r - b) < 25)).toBeGreaterThan(100);
  // グラフの背景(薄い黄色 FFF2CC)と、赤い枠線(C00000)
  expect(countPixels(img, (r, g, b) => r > 250 && Math.abs(g - 242) < 4 && Math.abs(b - 204) < 5)).toBeGreaterThan(5000);
  expect(countPixels(img, (r, g, b) => r > 170 && g < 30 && b < 30)).toBeGreaterThan(300);
});

test("x06 データ点ごとの色と、データラベルの個別設定(1つだけ表示・文字の書き換え)・数値の書式つきラベル", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x06-point-format-labels.xlsx");
  const img = render(pdf, 1);
  expect(countPixels(img, (r, g, b) => r > 180 && g < 20 && b < 20)).toBeGreaterThan(200); // 4月だけ赤(C00000)
  const all = [...words(pdf, 1), ...words(pdf, 2)].map((w) => w.text);
  expect(all.filter((w) => w === "180").length).toBe(2); // 表のセル＋2月の棒のラベル(この1本だけ表示)
  expect(all.filter((w) => w === "120").length).toBe(1); // 表のセルだけ(1月のラベルは出さない)
  expect(all.join("")).toContain("最高");
  expect(all).toContain("120円");
});

test("x07 軸：最小値100の棒は軸の下へはみ出さない／横軸を上(crosses=max)／交差位置=150／軸の書式", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x07-axis-settings.xlsx");
  // 左の列(①③)は1ページ目、右の列(②④)は2ページ目
  const img = render(pdf, 1);
  const ws = words(pdf, 1);
  const t1 = ws.find((w) => w.text.startsWith("最小100"))!;
  const t3 = ws.find((w) => w.text === "交差位置=150")!;
  // ① 最小100：棒の下端は、目盛り「100」の位置(プロットの下端)より下に出ない
  const tick100 = ws.find((w) => w.text === "100" && w.y > t1.y2 && w.y < t3.y && w.x > 200)!;
  const b1 = bars(img, accent1, below(t1, t3, img));
  expect(b1.length).toBeGreaterThanOrEqual(3);
  for (const b of b1) expect(b.y1).toBeLessThanOrEqual((tick100.y + tick100.y2) / 2 + 2);
  // ③ 交差位置=150：1月(120)の棒は150から下へ、2月(180)は上へ。どちらも目盛り150の高さが端
  const b3 = bars(img, accent1, below(t3, undefined, img)).sort((a, b) => a.x0 - b.x0);
  const tick150 = ws.find((w) => w.text === "150" && w.y > t3.y2 && w.x > 200)!;
  const y150 = (tick150.y + tick150.y2) / 2;
  expect(Math.abs(b3[0].y0 - y150)).toBeLessThan(3);
  expect(Math.abs(b3[1].y1 - y150)).toBeLessThan(3);
  // ② 横軸を上に：分類の文字(1月)が棒より上にあり、棒は上から下へ伸びる(上端がそろう)
  const img2 = render(pdf, 2);
  const ws2 = words(pdf, 2);
  const t2 = ws2.find((w) => w.text === "横軸を上に")!;
  const t4 = ws2.find((w) => w.text.startsWith("軸の書式"))!;
  const jan2 = ws2.find((w) => w.text === "1月" && w.y > t2.y2 && w.y < t4.y)!;
  const b2 = bars(img2, accent1, { ...below(t2, t4, img2), x0: t2.x - 170 }); // 左端には、①のグラフの右端の棒がかかる
  expect(b2.length).toBe(4);
  for (const b of b2) expect(b.y0).toBeGreaterThan(jan2.y2);
  expect(Math.max(...b2.map((b) => b.y0)) - Math.min(...b2.map((b) => b.y0))).toBeLessThanOrEqual(1);
  // ④ 軸の書式
  expect(ws2.some((w) => w.text === "250千円")).toBe(true);
});

test("x08 第2軸：右の軸(0%〜140%)と左の軸(0〜1400)・両方の軸のタイトル", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x08-secondary-axis.xlsx");
  const t = (pdfText(pdf, 1) + pdfText(pdf, 2)).replace(/\s/g, "");
  for (const s of ["1400", "140%", "120%", "売上（千円）", "達成率", "売上と達成"]) expect(t).toContain(s);
  expect(countPixels(render(pdf, 2), accent2)).toBeGreaterThan(30);
});

test("x09 日付の軸：日付の間隔どおりに並べる(データの無い日にも目盛り)・月単位の軸は軸の書式で表示", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x09-date-axis.xlsx");
  const ws = [...words(pdf, 1), ...words(pdf, 2)];
  // データは 1/1・1/2・1/5・1/10・1/20・1/31。データの無い 1/3・1/7 にも目盛りの文字が出る
  expect(ws.some((w) => w.text === "1/3")).toBe(true);
  expect(ws.some((w) => w.text === "1/7")).toBe(true);
  // 目盛りの文字は1日を同じ幅として並ぶ：1/1→1/5 の距離は、1/1→1/3 の距離の2倍
  const p1 = words(pdf, 1);
  const tDays = p1.find((w) => w.text === "日付の間隔どおり")!;
  const tMonths = p1.find((w) => w.text === "月単位の日付軸")!;
  const x = (t: string) => {
    const w = p1.find((ww) => ww.text === t && ww.x > 200 && ww.y > tDays.y2 && ww.y < tMonths.y)!; // 左の表の日付ではなく、グラフの目盛り
    return (w.x + w.x2) / 2;
  };
  expect(Math.abs(x("1/5") - x("1/1") - 2 * (x("1/3") - x("1/1")))).toBeLessThan(2);
  expect(ws.some((w) => w.text === "2026年1月")).toBe(true);
});

test("x10 凡例の位置(上・左・右上・下)と、凡例の項目の削除", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x10-legend-positions.xlsx");
  const ws = words(pdf, 1);
  const tT = ws.find((w) => w.text === "凡例=t")!;
  const ws2 = words(pdf, 2); // 右の列のグラフ(凡例=l・凡例=b)は2ページ目
  const tB = ws2.find((w) => w.text === "凡例=b")!;
  // 凡例=t：タイトルのすぐ下に凡例(売上)
  const legT = ws.find((w) => w.text === "売上" && w.y > tT.y2 && w.y < tT.y2 + 30 && w.x > tT.x - 150);
  expect(legT).toBeTruthy();
  // 凡例=b：グラフの下の凡例に、売上・利益はあり、削除した費用は無い
  const bottomWords = ws2.filter((w) => w.y > tB.y2 + 150 && Math.abs(w.x - tB.x) < 150);
  expect(bottomWords.some((w) => w.text === "売上")).toBe(true);
  expect(bottomWords.some((w) => w.text === "利益")).toBe(true);
  expect(bottomWords.some((w) => w.text === "費用")).toBe(false);
});

test("x11 配置の種類：セルに合わせる・移動のみ・固定・oneCellAnchor・absoluteAnchor のすべてを描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf, screen } = await convert(page, "x11-anchor-types.xlsx");
  const t = pdfText(pdf, 1).replace(/\s/g, "");
  for (const s of ["セルに合わせる", "移動のみ", "固定", "oneCell", "absolute"]) expect(t).toContain(s);
  expect(screen).not.toContain("複雑な図形");
  // absoluteAnchor(シートの左上から x=300pt, y=470pt)：左余白0.7インチ・上余白0.75インチを足した位置にタイトルの枠
  const abs = words(pdf, 1).find((w) => w.text === "absolute")!;
  expect(abs.x).toBeGreaterThan(50.4 + 300);
  expect(abs.x).toBeLessThan(50.4 + 300 + 200);
  expect(abs.y).toBeGreaterThan(54 + 470);
  expect(abs.y).toBeLessThan(54 + 470 + 30);
});

test("x12 重なり：後に置いたグラフが上、グラフの上に置いた画像は、グラフより上に描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x12-overlap.xlsx");
  const img = render(pdf, 1);
  const pic = components(img, purpleImg, 50);
  expect(pic.length).toBe(1);
  const c = pic[0];
  expect(c.x1 - c.x0).toBeGreaterThan(60); // グラフに隠れずに、画像の全体が見える
  // 「上のグラフ」のタイトルは「下のグラフ」の棒に隠れない
  expect(pdfText(pdf, 1)).toContain("上のグ");
});

test("x13 印刷範囲の境界：範囲(A〜F列)の外にはみ出したグラフの部分は描かない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x13-print-area-boundary.xlsx");
  expect(pageCount(pdf)).toBe(1);
  const img = render(pdf, 1);
  const f7 = words(pdf, 1).find((w) => w.text === "F7")!;
  // F列の右端(F列の左端＋列の幅54pt。既定の列幅8.38文字＝72px)より右には、グラフの棒も枠も無い
  const fRight = f7.x - 4 + 54;
  expect(countPixels(img, accent1)).toBeGreaterThan(100);
  expect(countPixels(img, accent1, { x0: fRight + 3, y0: 0, x1: img.w, y1: img.h })).toBe(0);
  expect(countPixels(img, (r, g, b) => r < 235 && Math.abs(r - g) < 8 && Math.abs(g - b) < 8, { x0: fRight + 3, y0: 0, x1: img.w, y1: img.h })).toBe(0);
});

test("x14 改ページをまたぐグラフ：タイトルは1ページ目、棒は2ページ目", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x14-page-break.xlsx");
  expect(pageCount(pdf)).toBe(2);
  expect(pdfText(pdf, 1).replace(/\s/g, "")).toContain("改ページをまたぐ");
  expect(bars(render(pdf, 2), accent1).length).toBeGreaterThanOrEqual(3);
  expect(pdfText(pdf, 2)).toContain("行21");
});

test("x15 複数シート：非表示のシートは出力せず、そのシートのデータを参照するグラフは描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x15-multi-sheet-hidden.xlsx");
  expect(pageCount(pdf)).toBe(2);
  const all = pdfText(pdf).replace(/\s/g, "");
  expect(all).toContain("集計のグラフ");
  expect(all).toContain("非表示シートを参照");
  expect(all).not.toContain("非表示シートのグラフ");
  expect(bars(render(pdf, 2), accent2)).toHaveLength(4);
});

test("x16 参照先が別のシート(シート名に空白・値の控えなし)：2系列とも描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x16-other-sheet-ref.xlsx");
  const img = render(pdf, 1);
  expect(bars(img, accent1)).toHaveLength(4);
  expect(bars(img, accent2)).toHaveLength(4);
});

test("x17 参照先が別のブック：値の控えがあれば控えから、無ければブックに保存された外部の値の控え(externalLink)から描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf, screen } = await convert(page, "x17-external-book-ref.xlsx");
  const img = render(pdf, 1);
  expect(bars(img, accent1)).toHaveLength(4);
  expect(bars(render(pdf, 2), accent2).length).toBeGreaterThanOrEqual(3); // 2つ目のグラフ(控えなし)の棒は2ページ目
  expect(screen).not.toContain("データを読み取れない系列");
});

test("x18 名前の定義を参照するグラフ(値の控えなし)：ブック全体の名前・シートだけの名前の両方を読む", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf, screen } = await convert(page, "x18-defined-names.xlsx");
  const img = render(pdf, 1);
  expect(bars(img, accent1).length).toBeGreaterThanOrEqual(3);
  expect(bars(img, accent2).length).toBeGreaterThanOrEqual(3);
  expect(screen).not.toContain("データを読み取れない系列");
});

test("x19 大量のデータ(3000点の折れ線・2000点の散布図)：描けて、何も無いページは出力しない", async ({ page }) => {
  test.setTimeout(240_000);
  const t0 = Date.now();
  const { pdf, screen } = await convert(page, "x19-large-data.xlsx", 200_000);
  const ms = Date.now() - t0;
  expect(pageCount(pdf)).toBe(78); // 77ページ(縦)＋グラフの右側の1ページ。同じファイルのLibreOfficeのPDFと同じ
  expect(screen).toMatch(/何も無いページ\d+枚は、出力していません/);
  const img = render(pdf, 1);
  expect(countPixels(img, accent1)).toBeGreaterThan(1000);
  expect(countPixels(img, accent2)).toBeGreaterThan(200);
  expect(ms).toBeLessThan(150_000);
});

test("x20 系列が多い(15系列・25系列)：凡例に全部の系列名を出す", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x20-many-series.xlsx");
  expect(pageCount(pdf)).toBe(5);
  const all = pdfText(pdf);
  expect(all).toContain("店15");
  expect(all).toContain("店25");
});

test("x21 日本語：日本語のシート名・タイトル・凡例・長い分類名・縦書きの軸タイトル", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x21-japanese.xlsx");
  const t = (pdfText(pdf, 1) + pdfText(pdf, 2)).replace(/\s/g, "");
  for (const s of ["地域別の売上高", "前年度との比較", "前年度実績", "北海道・東北地方", "九州・沖縄地方", "売上高（百万円）"]) expect(t).toContain(s);
});

test("x22 日付と通貨：日付の分類は日付の間隔で並べ、金額は ¥#,##0 で表示(値の控えが無いときもセルの書式から)", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x22-date-currency.xlsx");
  const ws = [...words(pdf, 1), ...words(pdf, 2)].map((w) => w.text);
  expect(ws).toContain("¥125,000");
  expect(ws).toContain("¥160,000");
  // データの無い 4月4日・4月5日にも目盛り(日付の軸)。上下2つのグラフの両方で
  expect(ws.filter((w) => w === "2026年4月5日").length).toBeGreaterThanOrEqual(2);
});

test("x23 負の数：縦棒は0の線から下へ伸び、折れ線の分類名は0の線のそばに出す", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x23-negative-values.xlsx");
  const img = render(pdf, 1);
  const ws = words(pdf, 1);
  const t1 = ws.find((w) => w.text.startsWith("縦棒"))!;
  const t3 = ws.find((w) => w.text.startsWith("折れ線"))!;
  const zero = ws.find((w) => w.text === "0" && w.y > t1.y2 && w.y < t3.y && w.x < t1.x)!;
  const y0 = (zero.y + zero.y2) / 2;
  const b = bars(img, accent1, below(t1, t3, img)).sort((a, c) => a.x0 - c.x0);
  expect(b.length).toBeGreaterThanOrEqual(5);
  expect(Math.abs(b[1].y0 - y0)).toBeLessThan(3); // 2月(-80)は0の線から下へ
  expect(b[1].y1).toBeGreaterThan(y0 + 20);
  // 折れ線(分類名の位置は既定=軸のそば)：「1月」は、折れ線のグラフの0の目盛りの高さの近く
  const zero3 = ws.find((w) => w.text === "0" && w.y > t3.y2 && w.x < t3.x)!;
  const jan3 = ws.find((w) => w.text === "1月" && w.y > t3.y2 && w.x > t3.x - 150)!;
  expect(Math.abs(jan3.y - zero3.y2)).toBeLessThan(12);
});

test("x24 0と空白：円グラフは0と空白の扇形を描かずに割合を出し、縦棒は0のラベルを出す", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "x24-zero-blank.xlsx");
  const t = pdfText(pdf, 1);
  for (const s of ["30%", "20%"]) expect(t).toContain(s);
  const ws = words(pdf, 2); // 右の縦棒のグラフは2ページ目
  const barT = ws.find((w) => w.text.startsWith("0を含む"))!;
  // 分類「B」(値0)。2ページ目には円グラフの凡例の「B」もあるので、いちばん下(分類の軸)のものを使う
  const bLabel = ws.filter((w) => w.text === "B" && w.y > barT.y2).sort((a, b) => b.y - a.y)[0];
  expect(ws.some((w) => w.text === "0" && Math.abs((w.x + w.x2) / 2 - (bLabel.x + bLabel.x2) / 2) < 6 && w.y < bLabel.y)).toBe(true);
});

test("x25 対応していない種類(8種類)：別の種類に描き替えず、枠と説明を出し、画面の注意は1つにまとめる。外部に送らない", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const recorder = new NetworkRecorder(page);
  const { pdf, screen } = await convert(page, "x25-unsupported-types.xlsx");
  const all = pdfText(pdf).replace(/\s/g, "");
  expect(all.split("このグラフは表示できません").length - 1).toBe(8);
  for (const s of ["3-D棒グラフ", "株価チャート", "等高線グラフ"]) expect(all).toContain(s);
  expect(screen.split("対応していない種類").length - 1).toBe(1);
  for (const s of ["レーダーチャート", "バブルチャート", "補助円グラフ付き円グラフ", "ウォーターフォール"]) expect(screen).toContain(s);
  for (let p = 1; p <= pageCount(pdf); p++) expect(countPixels(render(pdf, p), accent1)).toBe(0); // 棒などは描かない
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});
