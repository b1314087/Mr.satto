import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { extractPdfContent, getFillColorsUsed } from "../helpers/pdf-inspect";
import { excelNumberFormatColor, excelTextFormatColor, formatExcelNumber } from "@/lib/excel/excel-number-format";
import { parseHeaderFooterSections } from "@/lib/excel/ooxml-page-settings";
import { scratchDir } from "../helpers/tmp";

/**
 * Excel→PDF：Excelの表示の決まりごと（機能単位の回帰テスト。特定のファイル専用の調整ではない）。
 * - 「縮小して全体を表示」のセルは、隣が空いていてもはみ出さず、文字を小さくして収める
 * - 「均等割り付け」のセルは、隣が空いていてもセルの中だけに並べる
 * - 表示形式の色（[Red] など）を文字色に反映する（負数の赤字など）
 * - ヘッダー/フッターは、ブックの標準の文字サイズ（&nn の指定があればそれ）・黒で描く
 * - 日本語の既定フォント（游ゴシック等）のブックでは、幅を手で「標準の幅（8.38文字）」にした列と、
 *   標準のまま残した列が同じ幅（72ピクセル＝54pt）になる
 * - 「次のページ数に合わせて印刷」は縮小するだけで拡大しない。指定のページ数は上限（小さい表は100%のまま1ページ）
 * 手組みの最小限のxlsx（架空のデータのみ）を変換し、できあがったPDFを確かめる。
 */

// ---------------------------------------------------------------------------
// 1. 規則（純粋な関数）
// ---------------------------------------------------------------------------

plainTest("表示形式の色：選ばれたセクションの [Red]・[Blue]・[ColorN] を返し、色の指定が無ければ null", () => {
  const code = '#,##0;[Red]-#,##0;[Blue]"ゼロ"';
  plainExpect(excelNumberFormatColor(1200, code)).toBeNull();
  plainExpect(excelNumberFormatColor(-1200, code)).toBe("#FF0000");
  plainExpect(excelNumberFormatColor(0, code)).toBe("#0000FF");
  plainExpect(formatExcelNumber(-1200, code)).toBe("-1,200"); // 色の指定は文字には出ない
  plainExpect(excelNumberFormatColor(-1, "#,##0_);[Red](#,##0)")).toBe("#FF0000");
  plainExpect(excelNumberFormatColor(5, "[Color10]0")).toBe("#008000");
  plainExpect(excelNumberFormatColor(150, "[Red][>=100]0;0")).toBe("#FF0000");
  plainExpect(excelNumberFormatColor(50, "[Red][>=100]0;0")).toBeNull();
  plainExpect(excelNumberFormatColor(-1, '"[Red]"0')).toBeNull(); // 引用符の中は色の指定ではない
  plainExpect(excelNumberFormatColor(-1, "General")).toBeNull();
  plainExpect(excelTextFormatColor('0;0;0;[Blue]@"様"')).toBe("#0000FF");
  plainExpect(excelTextFormatColor("0")).toBeNull();
});

plainTest("ヘッダー/フッター：&nn の文字サイズをセクションごとに読み取り、文字からは取り除く", () => {
  plainExpect(parseHeaderFooterSections("&L&14左&C中央&R&8&P / &N")).toEqual({
    left: "左",
    center: "中央",
    right: "{{PAGE}} / {{PAGES}}",
    sizes: { left: 14, right: 8 },
  });
  plainExpect(parseHeaderFooterSections("&C社内資料")).toEqual({ left: "", center: "社内資料", right: "" });
});

// ---------------------------------------------------------------------------
// 2. 変換したPDF
// ---------------------------------------------------------------------------

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;[Red]\\-#,##0"/></numFmts>
<fonts count="1"><font><sz val="11"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment shrinkToFit="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="distributed"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

const c = (ref: string, v: string | number, s = 0) =>
  typeof v === "number" ? `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${v}</v></c>` : `<c r="${ref}"${s ? ` s="${s}"` : ""} t="inlineStr"><is><t>${v}</t></is></c>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}><sheetFormatPr defaultRowHeight="18.75"/><cols><col min="1" max="6" width="12" customWidth="1"/></cols><sheetData>
<row r="1">${c("A1", "A列")}${c("B1", "B列")}${c("C1", "C列")}${c("D1", "D列")}</row>
<row r="2">${c("B2", "均等割付", 2)}${c("D2", "右端")}</row>
<row r="3">${c("A3", "縮小して全体を表示するとても長い文字列です", 1)}</row>
<row r="4">${c("A4", "金額")}${c("B4", -5000, 3)}${c("C4", 5000, 3)}</row>
</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><headerFooter><oddHeader>&amp;C社内資料</oddHeader><oddFooter>&amp;C&amp;9&amp;P ページ</oddFooter></headerFooter></worksheet>`;

function buildXlsx(sheet = SHEET): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets><sheet name="決まり" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ),
    "xl/styles.xml": strToU8(STYLES),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

interface Item {
  str: string;
  x: number;
  y: number;
  size: number;
}

/** PDFの文字を、位置と文字の大きさ（変換行列の拡大率）つきで取り出す */
async function textItems(file: string): Promise<{ items: Item[]; height: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items: Item[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const it of content.items as any[]) {
    if (typeof it.str !== "string" || it.str === "") continue;
    const t = it.transform as number[];
    // 文字の大きさは、縦の倍率(t[2], t[3])で測る。横の倍率(t[0])は、文字をフォントの幅に合わせて横に伸び縮みさせると変わるため
    items.push({ str: it.str, x: t[4], y: t[5], size: Math.hypot(t[2], t[3]) });
  }
  return { items, height: page.getViewport({ scale: 1 }).height };
}

async function convert(page: Page, sheet = SHEET): Promise<string> {
  const dir = scratchDir("xlrule");
  const file = path.join(dir, "rules.xlsx");
  fs.writeFileSync(file, buildXlsx(sheet));
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, file);
  const ok = await page
    .getByRole("button", { name: "PDFに変換する" })
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    await page.reload();
    await uploadFixture(page, file);
  }
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", 60_000);
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const out = path.join(dir, "out.pdf");
  await download.saveAs(out);
  return out;
}

test("Excel→PDF：縮小して全体を表示・均等割り付けははみ出さず、[Red] の負数は赤、ヘッダー/フッターは標準の文字サイズで黒", async ({ page }) => {
  test.setTimeout(120_000);
  const pdf = await convert(page);
  const { items, height } = await textItems(pdf);
  // 1文字ずつの項目を、同じ高さ（ベースライン）ごとに1行の文字にまとめて探す
  const lines: Item[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < 0.5 && Math.abs(l.size - it.size) < 0.5);
    if (line) line.str += it.str;
    else lines.push({ ...it });
  }
  const find = (s: string) => lines.find((l) => l.str.replace(/\s/g, "").includes(s.replace(/\s/g, "")));

  // 縮小して全体を表示：隣（B3）が空いていても、A列の幅に収まるよう小さくなる（11ptより小さい）
  const shrink = find("縮小して全体を表示")!;
  expect(shrink).toBeTruthy();
  expect(shrink.size).toBeLessThan(9);

  // 均等割り付け：B2の文字は、隣のC2が空いていても、C列（「C列」の文字の位置）より左に収まる
  // 1行目の見出しは同じ行にまとまるため、「C列」の「C」の文字そのものから位置を取る
  const cCol = items.find((i) => i.str === "C")!;
  expect(cCol).toBeTruthy();
  const distGlyphs = items.filter((i) => /^[均等割付]$/.test(i.str));
  expect(distGlyphs.length).toBeGreaterThan(0);
  for (const g of distGlyphs) expect(g.x).toBeLessThan(cCol.x - 2);

  // [Red]：負数のセルだけ赤
  const colors = await getFillColorsUsed(pdf, 1);
  expect(colors.has("#ff0000")).toBe(true);
  expect(find("-5,000")).toBeTruthy();
  expect(find("5,000")).toBeTruthy();

  // ヘッダー（標準の11pt）・フッター（&9 の指定で9pt）
  const header = find("社内資料")!;
  expect(header.size).toBeGreaterThan(10.5);
  expect(header.size).toBeLessThan(11.5);
  expect(header.y).toBeGreaterThan(height - 50);
  const footer = find("1 ページ")!;
  expect(footer.size).toBeGreaterThan(8.5);
  expect(footer.size).toBeLessThan(9.5);
  expect(footer.y).toBeLessThan(40);
});

/** A列だけ幅を「標準の幅（8.38文字＝ファイル上は 9.00390625）」に手で設定し、B・C列は標準のまま */
const WIDTH_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}><sheetFormatPr defaultRowHeight="18.75"/><cols><col min="1" max="1" width="9.00390625" customWidth="1"/></cols><sheetData>
<row r="1">${c("A1", "A")}${c("B1", "B")}${c("C1", "C")}${c("D1", "D")}</row>
</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

test("Excel→PDF：日本語の既定フォントのブックでは、手で標準の幅にした列と標準のままの列が同じ幅（72ピクセル）になる", async ({ page }) => {
  test.setTimeout(120_000);
  const pdf = await convert(page, WIDTH_SHEET);
  const { items } = await textItems(pdf);
  const x = (s: string) => items.find((i) => i.str === s)!.x;
  const ab = x("B") - x("A");
  const bc = x("C") - x("B");
  const cd = x("D") - x("C");
  // 72ピクセル＝54pt（用紙に収まるので縮小はされない）
  expect(Math.abs(ab - 54)).toBeLessThan(0.6);
  expect(Math.abs(bc - 54)).toBeLessThan(0.6);
  expect(Math.abs(cd - 54)).toBeLessThan(0.6);
});

/** 小さい表に「横1×縦3ページに合わせる」を設定（Excelでは100%のまま1ページで印刷される） */
const SMALL_FIT_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetFormatPr defaultRowHeight="18.75"/><sheetData>
<row r="1">${c("A1", "小さい表")}${c("B1", "B")}</row>
<row r="2">${c("A2", "2行目")}${c("B2", 100)}</row>
</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="3"/></worksheet>`;

test("Excel→PDF：「次のページ数に合わせて印刷」は小さい表を拡大せず、100%のまま1ページで印刷する", async ({ page }) => {
  test.setTimeout(120_000);
  const pdf = await convert(page, SMALL_FIT_SHEET);
  const content = await extractPdfContent(pdf);
  expect(content.pageCount).toBe(1);
  const { items } = await textItems(pdf);
  const a = items.find((i) => i.str === "小" || i.str.startsWith("小さい"))!;
  expect(a).toBeTruthy();
  expect(Math.abs(a.size - 11)).toBeLessThan(0.2);
});
