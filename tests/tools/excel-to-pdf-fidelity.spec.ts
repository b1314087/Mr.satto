import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { strToU8, zipSync } from "fflate";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import path from "node:path";
import type { Page } from "@playwright/test";

/**
 * Excel→PDF: Excelの見た目の再現(書体・斜体・下線・回転・斜め罫線・リッチテキスト・印刷タイトル・
 * 複数の印刷範囲・枠線・白黒印刷・数値の表示形式・条件付き書式の色スケール・画像・隠しシート)。
 * 手組みの最小限のxlsx(架空のデータのみ)を変換し、できあがったPDFの文字・画素・画像を確認する。
 */

interface SheetDef {
  name: string;
  xml: string; // <worksheet>全体
  state?: "hidden";
  drawing?: { xml: string; rels: string };
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const FONTS = `<fonts count="8">
<font><sz val="11"/><name val="Calibri"/></font>
<font><sz val="11"/><name val="ＭＳ 明朝"/></font>
<font><i/><u/><strike/><sz val="11"/><name val="Calibri"/></font>
<font><u val="double"/><sz val="11"/><name val="Calibri"/></font>
<font><sz val="12"/><color rgb="FFFF0000"/><name val="Calibri"/></font>
<font><sz val="11"/><name val="Calibri"/></font>
<font><sz val="11"/><name val="Calibri"/></font>
<font><sz val="11"/><name val="Calibri"/></font>
</fonts>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet ${NS.split(" xmlns:r")[0]}>
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="@&quot;様&quot;"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>
${FONTS}
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>
<border diagonalUp="1" diagonalDown="1"><left/><right/><top/><bottom/><diagonal style="thin"><color rgb="FF0000FF"/></diagonal></border>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment textRotation="90"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment textRotation="255"/></xf>
</cellXfs>
</styleSheet>`;

function cellsXml(rows: Record<number, Record<string, { v?: string | number; s?: number; t?: "s" | "str" }>>): string {
  return Object.entries(rows)
    .map(([r, cols]) => {
      const cs = Object.entries(cols)
        .map(([c, spec]) => {
          const s = spec.s ? ` s="${spec.s}"` : "";
          if (spec.v === undefined) return `<c r="${c}${r}"${s}/>`;
          if (spec.t === "s") return `<c r="${c}${r}"${s} t="s"><v>${spec.v}</v></c>`;
          if (typeof spec.v === "string") return `<c r="${c}${r}"${s} t="inlineStr"><is><t>${spec.v}</t></is></c>`;
          return `<c r="${c}${r}"${s}><v>${spec.v}</v></c>`;
        })
        .join("");
      return `<row r="${r}">${cs}</row>`;
    })
    .join("");
}

function sheetXml(opts: {
  cols?: string;
  rows: string;
  extraAfterData?: string;
  pageSetup?: string;
  sheetPr?: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}>${opts.sheetPr ?? ""}<sheetFormatPr defaultRowHeight="15"/>${opts.cols ? `<cols>${opts.cols}</cols>` : ""}<sheetData>${opts.rows}</sheetData>${opts.extraAfterData ?? ""}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>${opts.pageSetup ?? ""}</worksheet>`;
}

function buildXlsx(opts: { sheets: SheetDef[]; sharedStrings?: string; definedNames?: string; media?: Record<string, Uint8Array> }): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const sheetsXml = opts.sheets
    .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`)
    .join("");
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${opts.sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets>${sheetsXml}</sheets>${opts.definedNames ? `<definedNames>${opts.definedNames}</definedNames>` : ""}</workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${opts.sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")}<Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  files["xl/styles.xml"] = strToU8(STYLES);
  files["xl/sharedStrings.xml"] = strToU8(
    opts.sharedStrings ?? `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>`
  );
  opts.sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml);
    if (s.drawing) {
      files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdD1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`
      );
      files[`xl/drawings/drawing${i + 1}.xml`] = strToU8(s.drawing.xml);
      files[`xl/drawings/_rels/drawing${i + 1}.xml.rels`] = strToU8(s.drawing.rels);
    }
  });
  for (const [p, bytes] of Object.entries(opts.media ?? {})) files[p] = bytes;
  return zipSync(files);
}

/** 赤い一色の8x8のPNG(zlibとCRCを自前で組み立てる) */
function makeRedPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const size = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8bit
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw[y * (size * 3 + 1) + 1 + x * 3] = 255;
  const idat = zlib.deflateSync(raw);
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
  );
}
const RED_PNG = makeRedPng();

async function convert(page: Page, xlsx: Uint8Array, opts: { keepAllSheets?: boolean } = {}): Promise<{ pdf: string; pageText: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlfid-"));
  const file = path.join(dir, "test.xlsx");
  fs.writeFileSync(file, xlsx);
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
  void opts;
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", 60_000);
  const pageText = await page.locator("body").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, pageText };
}

interface Img {
  w: number;
  h: number;
  data: Buffer;
}
/** PDFの指定ページを72dpiのカラー画像にする(1画素=1pt) */
function render(pdf: string, pageNo = 1): Img {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlimg-"));
  execFileSync("pdftoppm", ["-r", "72", "-f", String(pageNo), "-l", String(pageNo), pdf, path.join(dir, "p")]);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".ppm"))!;
  const buf = fs.readFileSync(path.join(dir, file));
  const m = buf.toString("latin1", 0, 30).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
  return { w: Number(m[1]), h: Number(m[2]), data: buf.subarray(m[0].length) };
}
function countPixels(img: Img, x0: number, y0: number, x1: number, y1: number, pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(img.w, x1); x++) {
      const i = (y * img.w + x) * 3;
      if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
    }
  }
  return n;
}
const reddish = (r: number, g: number, b: number) => r > 180 && g < 90 && b < 90;
const bluish = (r: number, g: number, b: number) => b > 150 && r < 90 && g < 90;

function pdfText(pdf: string, pageNo?: number): string {
  const args = ["-layout"];
  if (pageNo) args.push("-f", String(pageNo), "-l", String(pageNo));
  return execFileSync("pdftotext", [...args, pdf, "-"]).toString();
}

test("明朝体・斜体・下線・取り消し線・文字の回転・斜め罫線・リッチテキストがPDFに反映される", async ({ page }) => {
  test.setTimeout(120_000);
  const shared = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><r><t>Plain</t></r><r><rPr><sz val="14"/><color rgb="FFFF0000"/><rFont val="Calibri"/></rPr><t>REDPART</t></r></si></sst>`;
  const rows = cellsXml({
    1: { A: { v: "食堂予定表", s: 1 } },
    3: { A: { v: "ITALICUNDER", s: 2 }, C: { v: "DOUBLEU", s: 3 } },
    5: { A: { v: "ROTATED", s: 4 } },
    8: { A: { v: "DIAG", s: 5 } },
    10: { A: { v: 0, t: "s", s: 0 } },
  });
  const xml = sheetXml({
    cols: '<col min="1" max="1" width="14" customWidth="1"/><col min="2" max="4" width="12" customWidth="1"/>',
    rows: rows.replace('<row r="5">', '<row r="5" ht="80" customHeight="1">').replace('<row r="8">', '<row r="8" ht="40" customHeight="1">'),
  });
  const { pdf } = await convert(page, buildXlsx({ sheets: [{ name: "書式", xml }], sharedStrings: shared }));

  // 明朝体のフォントが埋め込まれ、日本語の文字が欠けずに抽出できる
  const fonts = execFileSync("pdffonts", [pdf]).toString();
  expect(fonts).toMatch(/NotoSerifJP/);
  const text = pdfText(pdf);
  expect(text).toContain("食堂予定表");
  expect(text).toContain("ITALICUNDER");
  expect(text).toContain("REDPART");

  const img = render(pdf);
  // 赤い文字(リッチテキストの一部)が描かれている
  expect(countPixels(img, 0, 0, img.w, img.h, reddish)).toBeGreaterThan(5);
  // 斜めの罫線(青)が描かれている
  expect(countPixels(img, 0, 0, img.w, img.h, bluish)).toBeGreaterThan(30);

  // 90度回転した文字は、横幅より縦の長さのほうが大きい
  const bbox = execFileSync("pdftotext", ["-bbox", pdf, "-"]).toString();
  const m = bbox.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">ROTATED<\/word>/);
  expect(m, "回転した文字が見つかりません").not.toBeNull();
  const wBox = Number(m![3]) - Number(m![1]);
  const hBox = Number(m![4]) - Number(m![2]);
  expect(hBox).toBeGreaterThan(wBox * 2);
});

test("数値・文字列の表示形式(桁区切り・%・「様」)が反映される", async ({ page }) => {
  test.setTimeout(120_000);
  const rows = cellsXml({
    1: { A: { v: 1234.5, s: 6 }, B: { v: "太郎", s: 7 }, C: { v: 0.1234, s: 8 } },
    2: { A: { v: 0.1 + 0.2 } },
  });
  const xml = sheetXml({ cols: '<col min="1" max="3" width="16" customWidth="1"/>', rows });
  const { pdf } = await convert(page, buildXlsx({ sheets: [{ name: "形式", xml }] }));
  const text = pdfText(pdf);
  expect(text).toContain("1,234.50");
  expect(text).toContain("太郎様");
  expect(text).toContain("12.3%");
  // 0.1+0.2の2進数の誤差が出ない
  expect(text).toContain("0.3");
  expect(text).not.toContain("0.30000000000000004");
});

test("列の幅に入らない数値は「####」で表示される", async ({ page }) => {
  test.setTimeout(120_000);
  const rows = cellsXml({ 1: { A: { v: 123456789012 }, B: { v: "OK" } } });
  const xml = sheetXml({ cols: '<col min="1" max="1" width="3" customWidth="1"/><col min="2" max="2" width="10" customWidth="1"/>', rows });
  const { pdf } = await convert(page, buildXlsx({ sheets: [{ name: "幅", xml }] }));
  const text = pdfText(pdf);
  expect(text).toContain("#");
  expect(text).not.toContain("123456789012");
});

test("印刷タイトル(行)が2ページ目以降にも繰り返される", async ({ page }) => {
  test.setTimeout(120_000);
  const data: Record<number, Record<string, { v: string | number }>> = { 1: { A: { v: "TITLEROW" } } };
  for (let r = 2; r <= 70; r++) data[r] = { A: { v: `data${r}` } };
  const xml = sheetXml({ cols: '<col min="1" max="1" width="14" customWidth="1"/>', rows: cellsXml(data).replace(/<row r="(\d+)">/g, '<row r="$1" ht="30" customHeight="1">') });
  const { pdf } = await convert(
    page,
    buildXlsx({ sheets: [{ name: "タイトル", xml }], definedNames: `<definedName name="_xlnm.Print_Titles" localSheetId="0">タイトル!$1:$1</definedName>` })
  );
  const pages = execFileSync("pdfinfo", [pdf]).toString().match(/Pages:\s+(\d+)/)![1];
  expect(Number(pages)).toBeGreaterThanOrEqual(2);
  expect(pdfText(pdf, 2)).toContain("TITLEROW");
});

test("複数の印刷範囲は別々のページに出力される", async ({ page }) => {
  test.setTimeout(120_000);
  const rows = cellsXml({ 1: { A: { v: "AREA_ONE" } }, 10: { D: { v: "AREA_TWO" } }, 20: { F: { v: "OUTSIDE" } } });
  const xml = sheetXml({ rows });
  const { pdf } = await convert(
    page,
    buildXlsx({ sheets: [{ name: "範囲", xml }], definedNames: `<definedName name="_xlnm.Print_Area" localSheetId="0">範囲!$A$1:$B$2,範囲!$D$10:$E$11</definedName>` })
  );
  const pages = Number(execFileSync("pdfinfo", [pdf]).toString().match(/Pages:\s+(\d+)/)![1]);
  expect(pages).toBe(2);
  expect(pdfText(pdf, 1)).toContain("AREA_ONE");
  expect(pdfText(pdf, 2)).toContain("AREA_TWO");
  expect(pdfText(pdf)).not.toContain("OUTSIDE");
});

test("B4の用紙サイズに対応し、未対応の用紙番号は警告してA4で出力する", async ({ page }) => {
  test.setTimeout(150_000);
  const rows = cellsXml({ 1: { A: { v: "paper" } } });
  const b4 = await convert(page, buildXlsx({ sheets: [{ name: "B4", xml: sheetXml({ rows, pageSetup: '<pageSetup paperSize="12" orientation="portrait"/>' }) }] }));
  const size = execFileSync("pdfinfo", [b4.pdf]).toString().match(/Page size:\s+([\d.]+) x ([\d.]+)/)!;
  expect(Math.abs(Number(size[1]) - 708.66)).toBeLessThan(2);
  const odd = await convert(page, buildXlsx({ sheets: [{ name: "奇数", xml: sheetXml({ rows, pageSetup: '<pageSetup paperSize="30" orientation="portrait"/>' }) }] }));
  expect(odd.pageText).toContain("未対応");
});

test("枠線の印刷と白黒印刷が反映される", async ({ page }) => {
  test.setTimeout(150_000);
  const rows = cellsXml({ 1: { A: { v: "grid" }, B: { v: "x" } }, 2: { A: { v: "y" } } });
  const withGrid = await convert(
    page,
    buildXlsx({ sheets: [{ name: "枠", xml: sheetXml({ rows, extraAfterData: '<printOptions gridLines="1"/>' }) }] })
  );
  const noGrid = await convert(page, buildXlsx({ sheets: [{ name: "枠なし", xml: sheetXml({ rows }) }] }));
  const a = countPixels(render(withGrid.pdf), 0, 0, 400, 150, (r, g, b) => r < 200 && g < 200 && b < 200);
  const b = countPixels(render(noGrid.pdf), 0, 0, 400, 150, (r, g, b) => r < 200 && g < 200 && b < 200);
  expect(a).toBeGreaterThan(b + 40);
});

test("条件付き書式の色スケールが段階的な色になる", async ({ page }) => {
  test.setTimeout(120_000);
  const rows = cellsXml({ 1: { A: { v: 0 } }, 2: { A: { v: 50 } }, 3: { A: { v: 100 } } });
  const cf = `<conditionalFormatting sqref="A1:A3"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FF0000FF"/></colorScale></cfRule></conditionalFormatting>`;
  const { pdf } = await convert(page, buildXlsx({ sheets: [{ name: "色", xml: sheetXml({ rows, extraAfterData: cf }) }] }));
  const img = render(pdf);
  // 最大値のセル(3行目)は青、最小値(1行目)は白のまま。中間(2行目)は薄い青
  const topMargin = 54;
  const rowH = 15;
  const blueAtRow3 = countPixels(img, 54, topMargin + rowH * 2 + 2, 100, topMargin + rowH * 3 - 1, (r, g, b) => b > 200 && r < 60);
  expect(blueAtRow3).toBeGreaterThan(100);
  const mid = countPixels(img, 54, topMargin + rowH + 2, 100, topMargin + rowH * 2 - 1, (r, g, b) => b > 200 && r > 100 && r < 160);
  expect(mid).toBeGreaterThan(100);
});

test("画像(PNG)がPDFに埋め込まれる", async ({ page }) => {
  test.setTimeout(120_000);
  const drawing = `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Pic"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdI1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdI1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`;
  const xml = sheetXml({
    cols: '<col min="1" max="4" width="12" customWidth="1"/>',
    rows: cellsXml({ 1: { A: { v: "pic" } } }),
    extraAfterData: "",
  }).replace("</worksheet>", '<drawing r:id="rIdD1"/></worksheet>');
  const { pdf } = await convert(
    page,
    buildXlsx({ sheets: [{ name: "画像", xml, drawing: { xml: drawing, rels } }], media: { "xl/media/image1.png": RED_PNG } })
  );
  const list = execFileSync("pdfimages", ["-list", pdf]).toString();
  expect(list.split("\n").filter((l) => /\bimage\b/.test(l)).length).toBeGreaterThanOrEqual(1);
  const img = render(pdf);
  expect(countPixels(img, 0, 0, img.w, img.h, reddish)).toBeGreaterThan(200);
});

test("非表示のシートは、最初は変換対象に選ばれない", async ({ page }) => {
  test.setTimeout(120_000);
  const visible = sheetXml({ rows: cellsXml({ 1: { A: { v: "VISIBLE_SHEET" } } }) });
  const hidden = sheetXml({ rows: cellsXml({ 1: { A: { v: "HIDDEN_SHEET" } } }) });
  const { pdf } = await convert(
    page,
    buildXlsx({
      sheets: [
        { name: "表示", xml: visible },
        { name: "隠し", xml: hidden, state: "hidden" },
      ],
    })
  );
  const text = pdfText(pdf);
  expect(text).toContain("VISIBLE_SHEET");
  expect(text).not.toContain("HIDDEN_SHEET");
});
