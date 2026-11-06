import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";

/**
 * Excel→PDF：印刷結果の再現性（12種類のExcel）。
 *
 * テスト用のExcelは tests/fixtures/static/excel-print/ にある（架空のデータのみ。作り方は
 * tests/fixtures/excel-print/generate_fixtures.py。Excelと同じ形式で保存するopenpyxlで作成）。
 * 各ファイルをMr.SattoでPDFにし、Excelの設定（用紙・向き・印刷範囲・拡大縮小・改ページ・非表示・
 * ヘッダー/フッター・表示形式・色）とPDFの中身（ページ数・ページの大きさ・文字・位置・画素の色）を照らし合わせる。
 *
 * 期待値の根拠：
 * - 用紙の大きさはExcelの用紙番号の定義（A4=210×297mm、B4・B5はJIS規格 等）
 * - 列幅はExcelの列幅の計算式（標準フォントの数字の幅7pxで、幅5→35px=26.25pt、幅30→210px=157.5pt）
 * - 行の高さは、Excelの既定（Calibri 11ptで15pt）と、ファイルに保存された高さ
 * - ページ数は、同じファイルをLibreOfficeでPDFにした結果とも照合済み（ヘッダー/フッターを除き一致）
 */

const SRC = path.join(__dirname, "..", "fixtures", "static", "excel-print");
const A4 = { w: 595.28, h: 841.89 };

async function convert(page: Page, name: string): Promise<{ pdf: string; screen: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlprint-"));
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, path.join(SRC, name));
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", 90_000);
  const screen = await page.locator("main").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, screen };
}

/** 各ページの大きさ(pt) */
function pageSizes(pdf: string): { w: number; h: number }[] {
  const out = execFileSync("pdfinfo", ["-f", "1", "-l", "999", pdf]).toString();
  return [...out.matchAll(/Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
}
function pdfText(pdf: string, pageNo?: number): string {
  const args = ["-layout"];
  if (pageNo) args.push("-f", String(pageNo), "-l", String(pageNo));
  return execFileSync("pdftotext", [...args, pdf, "-"]).toString();
}
/** 単語の位置(pt。左上が原点) */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlprint-img-"));
  execFileSync("pdftoppm", ["-r", "72", "-f", String(pageNo), "-l", String(pageNo), pdf, path.join(dir, "p")]);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".ppm"))!;
  const buf = fs.readFileSync(path.join(dir, file));
  const m = buf.toString("latin1", 0, 30).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
  return { w: Number(m[1]), h: Number(m[2]), data: buf.subarray(m[0].length) };
}
function pixel(img: Img, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.w + Math.round(x)) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
function countPixels(img: Img, pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 3) if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
  return n;
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

test.describe.configure({ mode: "parallel" });

test("01 A4縦・印刷範囲：範囲の中だけを1ページに出し、範囲外の行・列は出さない", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "01-a4-portrait-print-area.xlsx");
  const sizes = pageSizes(pdf);
  expect(sizes).toHaveLength(1);
  expect(near(sizes[0].w, A4.w) && near(sizes[0].h, A4.h)).toBe(true);
  const text = pdfText(pdf);
  expect(text).toContain("項目1");
  expect(text).toContain("行19");
  expect(text).not.toContain("範囲外");
});

test("02 A4横・横1ページに収める：全部の列が1ページの横幅に入り、縦は内容に応じてページが分かれる", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "02-a4-landscape-fit-width.xlsx");
  const sizes = pageSizes(pdf);
  expect(sizes.length).toBe(2);
  for (const s of sizes) expect(near(s.w, A4.h) && near(s.h, A4.w), "A4横").toBe(true);
  const first = pdfText(pdf, 1);
  expect(first).toContain("項目1");
  expect(first).toContain("項目24");
  // 24列目が、ページの右余白(0.4インチ=28.8pt)の内側に収まっている
  const last = words(pdf, 1).find((w) => w.text === "項目24")!;
  expect(last.x2).toBeLessThanOrEqual(A4.h - 28.8 + 1);
});

test("03 複数ページ：A4縦・拡大縮小なしで4ページになり、印刷タイトル(1行目)が毎ページに出る", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "03-multi-page.xlsx");
  const sizes = pageSizes(pdf);
  expect(sizes).toHaveLength(4);
  for (let p = 1; p <= 4; p++) expect(pdfText(pdf, p), `${p}ページ目の見出し`).toContain("項目1");
  // 行の高さはExcelの既定の15pt（Calibri 11pt）
  const ws = words(pdf, 1);
  const r1 = ws.find((w) => w.text === "行1")!;
  const r2 = ws.find((w) => w.text === "行2")!;
  expect(near(r2.y - r1.y, 15, 0.2)).toBe(true);
  // 1ページ目の最後の行の次の行が、2ページ目の見出しの次に来る（行の抜け・重複がない）
  const lastOnFirst = Math.max(...ws.filter((w) => /^行\d+$/.test(w.text)).map((w) => Number(w.text.slice(1))));
  const firstOnSecond = Math.min(...words(pdf, 2).filter((w) => /^行\d+$/.test(w.text)).map((w) => Number(w.text.slice(1))));
  expect(firstOnSecond).toBe(lastOnFirst + 1);
});

test("04 色：テーマ色・パレット色・パターン・グラデーションの背景色と、罫線の色がPDFに出る（白や黒にならない）", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "04-colors-borders.xlsx");
  const img = render(pdf);
  // rgbの赤・パレット色の黄色(indexed 13)の背景
  expect(countPixels(img, (r, g, b) => r > 230 && g < 40 && b < 40)).toBeGreaterThan(300);
  expect(countPixels(img, (r, g, b) => r > 230 && g > 230 && b < 60)).toBeGreaterThan(300);
  // 見本の列(B列)の位置と、1行目の中心。行の高さは既定の15pt（長い見出しは右隣まではみ出して「見本」とつながることがあるため、
  // 位置は1行目の「見本」から計算する）
  const first = words(pdf).find((w) => w.text === "見本")!;
  const bx = first.x;
  const rowMid = (i: number) => (first.y + first.y2) / 2 + 15 * i;
  const rowTop = (i: number) => rowMid(i) - 7.5;
  // テーマ色(アクセント1：青系)の背景（2行目）
  const accent = pixel(img, bx + 40, rowMid(1));
  expect(accent[2] > accent[0] + 40 && accent[0] < 140, `テーマ色の背景 ${accent}`).toBe(true);

  // グラデーション(青→白、左→右。8行目)：セルの左端は青く、右端は白に近い。以前は塗りなし(白)になっていた
  const left = pixel(img, bx - 1, rowMid(7));
  const right = pixel(img, bx + 95, rowMid(7));
  expect(left[2] - left[0], `グラデーションの左端 ${left}`).toBeGreaterThan(60);
  expect(Math.min(...right), `グラデーションの右端 ${right}`).toBeGreaterThan(200);
  // グラデーション(緑→黄、上→下。9行目)：セルの上は緑、下は黄色に近い
  const top = pixel(img, bx + 60, rowTop(8) + 1.5);
  const bottom = pixel(img, bx + 60, rowTop(8) + 13.5);
  expect(top[1] > top[0], `上端は緑 ${top}`).toBe(true);
  expect(bottom[0] > top[0] + 40, `下端は黄色に近い ${bottom}`).toBe(true);

  // 罫線の色(赤の細線・青の太線・緑の中線)
  expect(countPixels(img, (r, g, b) => b > 200 && r < 60 && g < 60)).toBeGreaterThan(80);
  expect(countPixels(img, (r, g, b) => g > 150 && r < 60 && b < 120)).toBeGreaterThan(40);
});

test("05 結合セル：結合したタイトルが結合範囲の中央に出て、縦の結合・折り返しの文字も1ページに出る", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "05-merged-cells.xlsx");
  expect(pageSizes(pdf)).toHaveLength(1);
  const ws = words(pdf);
  const title = ws.find((w) => w.text.startsWith("横方向に結合したタイトル"))!;
  // A1:F1（標準の列幅6列=6×48pt）の中央。左余白0.7インチ=50.4pt
  const center = 50.4 + (6 * 48) / 2;
  expect(Math.abs((title.x + title.x2) / 2 - center)).toBeLessThan(6);
  const text = pdfText(pdf);
  expect(text).toContain("右下揃え");
  // 「縦に結合」(縦に結合したA3:A8・中央揃え・折り返し)。列幅が狭いので2行に折り返されることがある
  expect(text).toMatch(/縦に結/);
  expect(text).toContain("折り返して表示");
});

test("06 列幅・行高：Excelの列幅の計算式と、保存された行の高さのとおりに並ぶ", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "06-column-row-sizes.xlsx");
  const ws = words(pdf);
  const at = (t: string) => ws.find((w) => w.text === t)!;
  // 列幅(文字数) 5・30・12・8 → 35px・210px・84px・56px（26.25pt・157.5pt・63pt・42pt）
  expect(near(at("B1").x - at("A1").x, 26.25, 0.3)).toBe(true);
  expect(near(at("C1").x - at("B1").x, 157.5, 0.3)).toBe(true);
  expect(near(at("D1").x - at("C1").x, 63, 0.3)).toBe(true);
  expect(near(at("E1").x - at("D1").x, 42, 0.3)).toBe(true);
  // 行の高さ 15・40・(10)・60・25pt（上下中央揃え）：1→2行目の中心の差は(15+40)/2、4→5行目は(60+25)/2
  expect(near(at("A2").y - at("A1").y, 27.5, 0.5)).toBe(true);
  expect(near(at("A5").y - at("A4").y, 42.5, 0.5)).toBe(true);
});

test("07 表示形式：日付・和暦・曜日・時刻・通貨・負数の赤・桁区切り・パーセント・文字列", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "07-number-formats.xlsx");
  const text = pdfText(pdf);
  for (const expected of [
    "2026/11/6",
    "2026年11月6日",
    "令和8年11月6日", // 以前は「46332」(日数のまま)になっていた
    "11月6日(金)",
    "9:05",
    "2026/11/06 14:30", // 以前は1分手前の「14:29」になっていた
    "¥1,234,567",
    "$1,234.50",
    "-2,500",
    "9,876,543.21",
    "26%",
    "12.3%",
    "0123",
  ]) {
    expect(text, expected).toContain(expected);
  }
  expect(text).not.toContain("46332");
  // 負数は赤
  expect(countPixels(render(pdf), (r, g, b) => r > 200 && g < 60 && b < 60)).toBeGreaterThan(10);
});

test("08 手動改ページ：行の改ページ(10行目・20行目の後)と列の改ページ(C列の後)で6ページに分かれる", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "08-manual-breaks.xlsx");
  expect(pageSizes(pdf)).toHaveLength(6);
  const p1 = pdfText(pdf, 1);
  expect(p1).toContain("項目3");
  expect(p1).not.toContain("項目4");
  expect(p1).toContain("行9"); // 10行目(=行9)の後で改ページ
  expect(p1).not.toContain("行10");
  // 2ページ目は、11行目(行10)から始まる(Excelは上から下へ、次に右へ並べる)
  expect(pdfText(pdf, 2)).toContain("行10");
});

test("09 複数シート：シートごとの用紙(A4・A3・B5 JIS・Letter・B4 JIS)と向きを守り、非表示のシートは出さない", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf, screen } = await convert(page, "09-multi-sheet-settings.xlsx");
  const sizes = pageSizes(pdf);
  const expected = [
    { w: 595.28, h: 841.89 }, // A4縦
    { w: 1190.55, h: 841.89 }, // A3横
    { w: 515.91, h: 728.5 }, // B5(JIS)縦 182×257mm
    { w: 612, h: 792 }, // Letter縦
    { w: 1031.81, h: 728.5 }, // B4(JIS)横 257×364mm（以前はISOの250×353mmで出していた）
  ];
  expect(sizes).toHaveLength(expected.length);
  expected.forEach((e, i) => expect(near(sizes[i].w, e.w) && near(sizes[i].h, e.h), `${i + 1}ページ目 ${sizes[i].w}x${sizes[i].h}`).toBe(true));
  expect(pdfText(pdf)).not.toContain("このシートは非表示");
  // 変換する前に、シートごとの用紙・向きを画面に表示している
  expect(screen).toContain("B4(JIS)・横");
  expect(screen).toContain("A3・横");
  // 「枠線を印刷する」のシートだけ、罫線の無いセルにも枠線が出る
  const grid = render(pdf, 4);
  expect(countPixels(grid, (r, g, b) => r < 200 && r > 60 && Math.abs(r - g) < 10 && Math.abs(r - b) < 10)).toBeGreaterThan(100);
});

test("10 非表示行・非表示列：非表示にした行(4・5・9行目)と列(C・E列)は出さない", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "10-hidden-rows-cols.xlsx");
  const text = pdfText(pdf);
  for (const shown of ["項目1", "項目2", "項目4", "項目6", "行2", "行5", "行9"]) expect(text, shown).toContain(shown);
  for (const hidden of ["項目3", "項目5", "行3", "行4", "行8"]) expect(text, hidden).not.toMatch(new RegExp(`${hidden}(?!\\d)`));
});

test("11 ヘッダー・フッター：ファイル名・シート名・日付・ページ番号/総ページ数を、各ページに出す", async ({ page }) => {
  test.setTimeout(120_000);
  const { pdf } = await convert(page, "11-header-footer.xlsx");
  const sizes = pageSizes(pdf);
  expect(sizes.length).toBe(2); // 上下の余白1インチ・15ptの行 → 1ページ46行で2ページ
  for (let p = 1; p <= sizes.length; p++) {
    const t = pdfText(pdf, p);
    expect(t).toContain("11-header-footer.xlsx");
    expect(t).toContain("ヘッダーフッター");
    expect(t).toMatch(/\d{4}\/\d{2}\/\d{2}/); // &D は日本語のExcelと同じ yyyy/mm/dd
    expect(t).toContain(`${p} / ${sizes.length} ページ`);
    expect(t).toContain("社外秘（架空）");
  }
});

test("12 画像・グラフ：画像は元の位置に出し、グラフ(縦棒)も描く。ファイルは外部に送らない", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const recorder = new NetworkRecorder(page);
  const { pdf, screen } = await convert(page, "12-image-chart.xlsx");
  const img = render(pdf);
  // オレンジの画像(120×60px = 90×45pt)がD2セルのあたりに描かれている
  const orange = (r: number, g: number, b: number) => r > 230 && g > 90 && g < 150 && b < 40;
  expect(countPixels(img, orange)).toBeGreaterThan(90 * 45 * 0.8);
  let minX = Infinity;
  let minY = Infinity;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (orange(...pixel(img, x, y))) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
      }
  // D2セルの左上：このファイルの余白(左0.75インチ=54pt・上1インチ=72pt)＋標準の幅3列(3×48pt)・1行(15pt)
  expect(Math.abs(minX - (54 + 3 * 48))).toBeLessThan(1.5);
  expect(Math.abs(minY - (72 + 15))).toBeLessThan(1.5);
  // グラフ(縦棒・テーマのアクセント1の青)も描かれる(グラフの描画は tests/tools/excel-to-pdf-charts.spec.ts で詳しく確かめる)
  expect(countPixels(img, (r, g, b) => b > 150 && r < 110 && g > 90 && g < 160)).toBeGreaterThan(100);
  expect(pdfText(pdf)).toContain("売上（架空）");
  expect(screen).toContain("グラフは、Excelの見た目に近づけて描いています");
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});
