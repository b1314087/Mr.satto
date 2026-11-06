import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";

/**
 * Excel→PDF：グラフの再現（20種類のExcel）。
 *
 * テスト用のExcelは tests/fixtures/static/excel-chart/ にある（架空のデータのみ。作り方は
 * tests/fixtures/excel-chart/generate_chart_fixtures.py。openpyxlで作り、LibreOfficeで保存し直して、
 * Excelが保存したファイルと同じく、グラフに値の控えと書式が入った形にしている。01b だけは控えなし）。
 *
 * PDFの中身（ページ数・文字・画素の色と形）で、グラフの種類・データの大きさの関係・タイトル・凡例・軸・
 * データラベル・位置と大きさ・印刷範囲・改ページ・複数シート・未対応の種類の扱いを確かめる。
 * Excel本体の描画と画素単位で一致することは確かめていない（同じファイルをLibreOfficeでPDFにした結果と、
 * ページ数・グラフの種類・目盛り・凡例を見比べて確認した）。
 */

const SRC = path.join(__dirname, "..", "fixtures", "static", "excel-chart");

async function convert(page: Page, name: string): Promise<{ pdf: string; screen: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlchart-"));
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, path.join(SRC, name));
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", 120_000);
  const screen = await page.locator("main").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, screen };
}

function pageSizes(pdf: string): { w: number; h: number }[] {
  const out = execFileSync("pdfinfo", ["-f", "1", "-l", "999", pdf]).toString();
  return [...out.matchAll(/Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
}
function pdfText(pdf: string, pageNo?: number): string {
  const args = ["-layout"];
  if (pageNo) args.push("-f", String(pageNo), "-l", String(pageNo));
  return execFileSync("pdftotext", [...args, pdf, "-"]).toString();
}
function words(pdf: string, pageNo = 1): { text: string; x: number; y: number; x2: number; y2: number }[] {
  const out = execFileSync("pdftotext", ["-bbox", "-f", String(pageNo), "-l", String(pageNo), pdf, "-"]).toString();
  return [...out.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    x2: Number(m[3]),
    y2: Number(m[4]),
    text: m[5],
  }));
}

interface Img {
  w: number;
  h: number;
  data: Buffer;
}
/** PDFの指定ページを72dpiの画像にする(1画素=1pt) */
function render(pdf: string, pageNo = 1): Img {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlchart-img-"));
  execFileSync("pdftoppm", ["-r", "72", "-f", String(pageNo), "-l", String(pageNo), pdf, path.join(dir, "p")]);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".ppm"))!;
  const buf = fs.readFileSync(path.join(dir, file));
  const m = buf.toString("latin1", 0, 30).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
  return { w: Number(m[1]), h: Number(m[2]), data: buf.subarray(m[0].length) };
}
type Pred = (r: number, g: number, b: number) => boolean;
function pixel(img: Img, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.w + Math.round(x)) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
function countPixels(img: Img, pred: Pred, area?: { x0: number; y0: number; x1: number; y1: number }): number {
  let n = 0;
  const a = area ?? { x0: 0, y0: 0, x1: img.w, y1: img.h };
  for (let y = Math.max(0, a.y0); y < Math.min(img.h, a.y1); y++)
    for (let x = Math.max(0, a.x0); x < Math.min(img.w, a.x1); x++) if (pred(...pixel(img, x, y))) n++;
  return n;
}
/** 同じ色のつながった塊(棒・扇形・マーカー)の外形。小さすぎる塊(文字の一部・線の端)は除く */
function components(img: Img, pred: Pred, minPixels = 6): { x0: number; y0: number; x1: number; y1: number; n: number }[] {
  const seen = new Uint8Array(img.w * img.h);
  const out: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      if (seen[i] || !pred(...pixel(img, x, y))) continue;
      const stack = [i];
      seen[i] = 1;
      const c = { x0: x, y0: y, x1: x, y1: y, n: 0 };
      while (stack.length) {
        const j = stack.pop()!;
        const jx = j % img.w;
        const jy = (j - jx) / img.w;
        c.n++;
        c.x0 = Math.min(c.x0, jx);
        c.x1 = Math.max(c.x1, jx);
        c.y0 = Math.min(c.y0, jy);
        c.y1 = Math.max(c.y1, jy);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue;
          const k = ny * img.w + nx;
          if (!seen[k] && pred(...pixel(img, nx, ny))) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      if (c.n >= minPixels) out.push(c);
    }
  }
  return out;
}

// グラフの系列の色（LibreOfficeで保存したファイルに書かれている色。Office 2007の既定のアクセント色）
const blue: Pred = (r, g, b) => b > 150 && r < 110 && g > 90 && g < 160;
const red: Pred = (r, g, b) => r > 160 && g < 110 && b < 110;
const green: Pred = (r, g, b) => g > 150 && r > 110 && r < 190 && b < 120;
const purple: Pred = (r, g, b) => r > 100 && r < 160 && g < 120 && b > 140;
/** 色の付いた画素(灰色・白・黒以外) */
const saturated: Pred = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 60;
const orange: Pred = (r, g, b) => r > 230 && g > 90 && g < 150 && b < 40;

const NOTICE = "グラフは、Excelの見た目に近づけて描いています";

test.describe.configure({ mode: "parallel" });

test("01 縦棒：月ごとの棒が、値の大きさの順に高くなり、タイトル・凡例・目盛りが出る", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf, screen } = await convert(page, "01-column.xlsx");
  expect(pageSizes(pdf)).toHaveLength(2); // グラフが用紙の横幅をはみ出すので、Excelと同じく2ページ
  const bars = components(render(pdf, 1), blue, 20).sort((a, b) => a.x0 - b.x0);
  expect(bars.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < bars.length; i++) expect(bars[i].y1 - bars[i].y0, `${i + 1}本目の棒の高さ`).toBeGreaterThan(bars[i - 1].y1 - bars[i - 1].y0);
  expect(components(render(pdf, 1), red, 20).length).toBeGreaterThanOrEqual(4); // 2つ目の系列(費用)
  const text = pdfText(pdf) .replace(/\s/g, "");
  expect(text).toContain("月別の売上と");
  for (const t of ["700", "600", "100", "1月", "4月", "売上", "費用"]) expect(text, t).toContain(t);
  expect(screen).toContain(NOTICE);
});

test("01b 値の控えが無いグラフ：参照しているセルの値を読んで描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "01b-column-no-cache.xlsx");
  const bars = components(render(pdf, 1), (r, g, b) => saturated(r, g, b) && b > r, 20).sort((a, b) => a.x0 - b.x0);
  expect(bars.length).toBeGreaterThanOrEqual(4);
  // 100・200・300・400 の棒の高さは、ほぼ 1:2:3:4
  const h = bars.slice(0, 4).map((c) => c.y1 - c.y0 + 1);
  expect(Math.abs(h[3] / h[0] - 4)).toBeLessThan(0.4);
  expect(pdfText(pdf).replace(/\s/g, "")).toContain("1月");
});

test("02 横棒：棒が横向きで、上の分類ほど長い（最初の分類が下）", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "02-bar.xlsx");
  const bars = components(render(pdf, 1), blue, 20).sort((a, b) => b.y0 - a.y0); // 下から
  expect(bars.length).toBeGreaterThanOrEqual(4);
  for (const c of bars) expect(c.x1 - c.x0, "横に長い").toBeGreaterThan(c.y1 - c.y0);
  for (let i = 1; i < bars.length; i++) expect(bars[i].x1 - bars[i].x0).toBeGreaterThanOrEqual(bars[i - 1].x1 - bars[i - 1].x0);
  expect(pdfText(pdf).replace(/\s/g, "")).toContain("横棒の比");
});

test("03 折れ線：3つの系列が線で描かれ（塗りつぶしの塊にならない）、マーカーが付く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "03-line.xlsx");
  const img = render(pdf, 1);
  for (const [name, pred] of [
    ["売上", blue],
    ["費用", red],
    ["利益", green],
  ] as const) {
    expect(countPixels(img, pred), name).toBeGreaterThan(60);
    const biggest = components(img, pred, 10).sort((a, b) => b.n - a.n)[0];
    expect(biggest.n / ((biggest.x1 - biggest.x0 + 1) * (biggest.y1 - biggest.y0 + 1)), `${name}は線`).toBeLessThan(0.35);
  }
  expect(pdfText(pdf).replace(/\s/g, "")).toContain("推移");
});

test("04 円：4つの扇形が別々の色で描かれ、割合のデータラベルが出る", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "04-pie.xlsx");
  const img = render(pdf, 1);
  for (const [name, pred] of [
    ["東日本", blue],
    ["西日本", red],
    ["九州", green],
    ["その他", purple],
  ] as const)
    expect(countPixels(img, pred), name).toBeGreaterThan(150);
  // 東日本(45%)の扇形は、その他(10%)より大きい
  expect(countPixels(img, blue)).toBeGreaterThan(countPixels(img, purple) * 3);
  const text = pdfText(pdf);
  for (const t of ["45%", "30%", "15%", "10%", "地域別の割合", "東日本"]) expect(text, t).toContain(t);
});

test("05 面：2つの系列が塗りつぶした面で描かれる", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "05-area.xlsx");
  const img = render(pdf, 1);
  expect(countPixels(img, blue)).toBeGreaterThan(800);
  expect(countPixels(img, red)).toBeGreaterThan(2000);
  expect(pdfText(pdf).replace(/\s/g, "")).toContain("来店と予約");
});

test("06 散布図：7つの点(マーカー)が、気温と販売数の位置に描かれ、軸のタイトルが出る", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "06-scatter.xlsx");
  // マーカーは中が白い小さなひし形なので、近くにある青い画素をまとめて1つの点として数える
  const bits = components(render(pdf, 1), (r, g, b) => b > 150 && b - r > 40, 1);
  const marks: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const c of bits) {
    const near = marks.find((m) => c.x0 <= m.x1 + 3 && c.x1 >= m.x0 - 3 && c.y0 <= m.y1 + 3 && c.y1 >= m.y0 - 3);
    if (near) {
      near.x0 = Math.min(near.x0, c.x0);
      near.y0 = Math.min(near.y0, c.y0);
      near.x1 = Math.max(near.x1, c.x1);
      near.y1 = Math.max(near.y1, c.y1);
    } else marks.push({ ...c });
  }
  expect(marks).toHaveLength(7);
  for (const m of marks) expect(m.x1 - m.x0).toBeLessThan(12);
  // 気温が高いほど(右ほど)販売数が多い(上にある)
  const sorted = [...marks].sort((a, b) => a.x0 - b.x0);
  for (let i = 1; i < sorted.length; i++) expect(sorted[i].y0).toBeLessThan(sorted[i - 1].y0);
  const text = pdfText(pdf).replace(/\s/g, "");
  expect(text).toContain("気温（℃）");
  expect(text).toContain("販売数");
});

test("07 積み上げ：積み上げ縦棒・100%積み上げ縦棒・積み上げ横棒。100%は全部の棒の高さがそろう", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "07-stacked.xlsx");
  const img = render(pdf, 1);
  const ws = words(pdf, 1);
  const titleOf = (t: string) => ws.find((w) => w.text.startsWith(t))!;
  const pct = titleOf("100%積み上げ縦棒");
  const hbar = titleOf("積み上げ横棒");
  // 100%積み上げ縦棒(タイトルの下〜次のグラフのタイトルの上)の、緑(利益・いちばん上)の塊の上端がそろう
  const tops = components(img, green, 20)
    .filter((c) => c.y0 > pct.y2 && c.y1 < hbar.y && c.x1 - c.x0 > 10) // 凡例の小さな四角は除く
    .map((c) => c.y0);
  expect(tops.length).toBe(4);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
  // 積み上げ横棒は横向き
  const hbars = components(img, blue, 20).filter((c) => c.y0 > hbar.y2 && c.x1 - c.x0 > 10);
  expect(hbars.length).toBe(4);
  for (const c of hbars) expect(c.x1 - c.x0).toBeGreaterThan(c.y1 - c.y0);
  const text = pdfText(pdf);
  expect(text).toContain("100%");
  expect(text).toContain("積み上げ縦棒");
});

test("08 ドーナツ：輪の形で、中心は穴(白)になる", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "08-doughnut.xlsx");
  const img = render(pdf, 1);
  const parts = components(img, saturated, 50);
  const ring = {
    x0: Math.min(...parts.map((c) => c.x0)),
    x1: Math.max(...parts.map((c) => c.x1)),
    y0: Math.min(...parts.map((c) => c.y0)),
    y1: Math.max(...parts.map((c) => c.y1)),
  };
  const center = pixel(img, (ring.x0 + ring.x1) / 2, (ring.y0 + ring.y1) / 2);
  expect(Math.min(...center), `中心 ${center}`).toBeGreaterThan(240);
  for (const pred of [blue, red, green]) expect(countPixels(img, pred)).toBeGreaterThan(200);
});

test("09 複合：縦棒と折れ線を重ね、折れ線は第2軸(右・%)で描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "09-combo.xlsx");
  const img = render(pdf, 1);
  const bars = components(img, blue, 20);
  expect(bars.length).toBeGreaterThanOrEqual(4);
  const redLine = components(img, red, 10).sort((a, b) => b.n - a.n)[0];
  expect(redLine.x1 - redLine.x0).toBeGreaterThan(100); // 横に長い線
  const all = pdfText(pdf, 1) + pdfText(pdf, 2);
  expect(all).toContain("1000");
  expect(all).toContain("100%"); // 第2軸の目盛り
  expect(all.replace(/\s/g, "")).toContain("売上と達成率");
});

test("10 タイトル・凡例(下)・軸のタイトル・最大値と目盛りの間隔の指定を守る", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "10-title-legend-axes.xlsx");
  const ws = words(pdf, 1);
  const text = pdfText(pdf, 1).replace(/\s/g, "");
  expect(text).toContain("店舗別の売上");
  expect(text).toContain("売上（千円）");
  // 縦の軸: 0〜700、100ごと(Excelで指定した最大値と間隔)
  for (const t of ["0", "100", "200", "300", "400", "500", "600", "700"]) expect(ws.some((w) => w.text === t), t).toBe(true);
  expect(ws.some((w) => w.text === "800")).toBe(false);
  // 凡例は下(分類の文字より下)
  const legend = ws.find((w) => w.text === "東京" && w.x > 250)!; // 左の表の見出しの「東京」ではなく、グラフの凡例
  const cat = ws.find((w) => w.text === "1月" && w.x > 250)!;
  expect(legend.y).toBeGreaterThan(cat.y);
});

test("11 データラベル：棒の上に値が出る", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "11-data-labels.xlsx");
  const img = render(pdf, 1);
  const bars = components(img, blue, 20).sort((a, b) => a.x0 - b.x0);
  expect(bars).toHaveLength(4);
  const ws = words(pdf, 1);
  // いちばん高い棒(400)の上に、400を含むラベルがある
  const tallest = bars[3];
  const lbl = ws.find((w) => w.text.includes("400") && w.x2 > tallest.x0 - 30 && w.x < tallest.x1 + 30 && w.y2 <= tallest.y0 + 2);
  expect(lbl, "400のデータラベル").toBeTruthy();
});

test("12 複数のグラフ：縦棒・折れ線・円の3つを、それぞれの位置に描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "12-multiple.xlsx");
  const ws = words(pdf, 1);
  const t1 = ws.find((w) => w.text === "縦棒")!;
  const t2 = ws.find((w) => w.text === "折れ線")!;
  const t3 = ws.find((w) => w.text === "円")!;
  expect(t1 && t2 && t3).toBeTruthy();
  expect(t2.x).toBeGreaterThan(t1.x2); // 折れ線は縦棒の右
  expect(t3.y).toBeGreaterThan(t1.y2); // 円は下
  expect(Math.abs(t3.x - t1.x)).toBeLessThan(40);
});

test("13 グラフとセルの重なり：表の上に置いたグラフは、下のセルを隠して描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "13-overlap-cells.xlsx");
  const img = render(pdf, 1);
  const ws = words(pdf, 1);
  // グラフの下に隠れるセル(R8C4)の文字の位置に、黒い文字の画素が無い(グラフの白い背景で隠れている)
  const hidden = ws.find((w) => w.text === "R8C4")!;
  const dark: Pred = (r, g, b) => r < 90 && g < 90 && b < 90;
  expect(countPixels(img, dark, { x0: Math.floor(hidden.x), y0: Math.floor(hidden.y), x1: Math.ceil(hidden.x2), y1: Math.ceil(hidden.y2) })).toBeLessThan(4);
  // グラフの外のセル(R20C8)は見える
  const shown = ws.find((w) => w.text === "R20C8")!;
  expect(countPixels(img, dark, { x0: Math.floor(shown.x), y0: Math.floor(shown.y), x1: Math.ceil(shown.x2), y1: Math.ceil(shown.y2) })).toBeGreaterThan(4);
  expect(components(img, blue, 20).length).toBeGreaterThanOrEqual(4);
});

test("14 グラフと画像：画像とグラフをそれぞれの位置に描き、グラフの位置と大きさはExcelの設定どおり", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "14-chart-and-image.xlsx");
  const img = render(pdf, 1);
  expect(countPixels(img, orange)).toBeGreaterThan(90 * 45 * 0.8);
  // グラフの枠: D7セルの左上(左余白0.7インチ=50.4pt＋A〜C列、上余白0.75インチ=54pt＋6行×15pt)から、10×6cm
  // 列の幅は、このファイルの既定の列幅(8.68文字)をExcelの式で計算した61px=45.75pt。
  // グラフの右下はセル(I列)に結び付けて保存されているため、横幅は列の幅で決まる。このファイルを保存したLibreOfficeは
  // 既定の列幅を48ptとして計算しているので、Excelの列幅で並べると10cmより4%ほど短くなる(縦は行の高さが同じなので6cmのまま)
  const expected = { x: 50.4 + 3 * 45.75, y: 54 + 6 * 15, w: (10 / 2.54) * 72, h: (6 / 2.54) * 72 };
  // グラフの枠線(上と下の横線。縦線は細く薄いので、上下の横線で測る)
  const lines = components(img, (r, g, b) => r < 235 && Math.abs(r - g) < 12 && Math.abs(g - b) < 12, 30)
    .filter((c) => c.y0 >= expected.y - 4 && c.x1 - c.x0 > 250 && c.y1 - c.y0 <= 2)
    .sort((a, b) => a.y0 - b.y0);
  expect(lines.length, "グラフの枠の上下の線").toBeGreaterThanOrEqual(2);
  const frame = { x0: lines[0].x0, x1: lines[0].x1, y0: lines[0].y0, y1: lines[lines.length - 1].y0 };
  expect(Math.abs(frame.x0 - expected.x)).toBeLessThan(3);
  expect(Math.abs(frame.y0 - expected.y)).toBeLessThan(3);
  expect(Math.abs(frame.x1 - frame.x0 - expected.w * (45.75 / 48))).toBeLessThan(5);
  expect(Math.abs(frame.y1 - frame.y0 - expected.h)).toBeLessThan(4);
  // 画像(D2)はグラフより上
  let orangeMaxY = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (orange(...pixel(img, x, y))) orangeMaxY = Math.max(orangeMaxY, y);
  expect(orangeMaxY).toBeLessThan(frame.y0);
});

test("15 印刷範囲：範囲の中のグラフは描き、範囲の外のグラフは描かない（範囲を広げない）", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "15-print-area.xlsx");
  expect(pageSizes(pdf)).toHaveLength(1);
  const text = pdfText(pdf).replace(/\s/g, "");
  expect(text).toContain("範囲の中");
  expect(text).not.toContain("範囲の外");
});

test("16 改ページ付近のグラフ：ページの境目をまたぐグラフは、それぞれのページに入る部分を描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "16-page-break.xlsx");
  expect(pageSizes(pdf)).toHaveLength(2);
  expect(pdfText(pdf, 1).replace(/\s/g, "")).toContain("ページをまたぐ"); // グラフの上の部分(タイトル)は1ページ目
  expect(countPixels(render(pdf, 2), blue)).toBeGreaterThan(100); // 下の部分(棒)は2ページ目
  expect(pdfText(pdf, 2)).toContain("行80"); // セルの改ページはこれまでどおり
});

test("17 複数シート：シートごとのグラフを、それぞれの用紙の向きで描く", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "17-multi-sheet.xlsx");
  const sizes = pageSizes(pdf);
  expect(sizes).toHaveLength(2);
  expect(sizes[0].h).toBeGreaterThan(sizes[0].w); // A4縦
  expect(sizes[1].w).toBeGreaterThan(sizes[1].h); // A4横
  expect(pdfText(pdf, 1).replace(/\s/g, "")).toContain("シート1のグラフ");
  expect(pdfText(pdf, 2).replace(/\s/g, "")).toContain("シート2のグラフ");
});

test("18 印刷範囲の外だけにあるグラフ：描かず、ページも増やさない", async ({ page }) => {
  test.setTimeout(150_000);
  const { pdf } = await convert(page, "18-outside-print-area.xlsx");
  expect(pageSizes(pdf)).toHaveLength(1);
  expect(pdfText(pdf)).not.toContain("印刷されないグラフ");
  expect(countPixels(render(pdf, 1), saturated)).toBeLessThan(10);
});

test("19 対応していない種類(3-D)：別の種類に描き替えず、その場所に枠と説明を出して、画面でも知らせる。外部に送らない", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const recorder = new NetworkRecorder(page);
  const { pdf, screen } = await convert(page, "19-unsupported-3d.xlsx");
  const text = pdfText(pdf).replace(/\s/g, "");
  expect(text).toContain("このグラフは表示できません");
  expect(text).toContain("3-D棒グラフ");
  expect(countPixels(render(pdf, 1), blue)).toBe(0); // 棒は描かない
  expect(screen).toContain("対応していない種類（3-D 棒グラフ）");
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});
