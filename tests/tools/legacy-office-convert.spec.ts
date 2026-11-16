import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { convertXlsToXlsx } from "@/lib/office-convert/xls-to-xlsx";
import { convertDocToDocx, isWellFormedXml } from "@/lib/office-convert/doc-to-docx";
import { readXls } from "@/lib/office-convert/xls-reader";
import { readDoc } from "@/lib/office-convert/doc-reader";

/**
 * Office旧形式→新形式の変換（.xls→.xlsx・.doc→.docx）のテスト。
 *
 * テスト用の .xls・.doc は、架空のデータで作ったファイルを LibreOffice（と xlwt）で古い形式に保存したもの
 * （tests/fixtures/legacy-office。.doc の元は sample2-source.fodt）。
 * - 変換の中身：書き出したファイルを openpyxl で開き、値・数式・書式・結合・列の幅・行の高さ・シートの表示を元と比べる。
 * - Word：書き出した .docx を LibreOffice でページに配置（PDF）して、文字が元の .doc と同じに出るかを比べる。
 * - 異常系：壊れたファイル・別の形式・途中で切れたファイルに、分かる言葉のエラーを出す。
 * python・LibreOffice が無い環境では、外部の道具を使う確認だけを飛ばす。
 */

const DIR = path.join(__dirname, "..", "fixtures", "legacy-office");
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(DIR, name)));

function has(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}
const pythonOk = has("python3", ["-c", "import openpyxl, docx"]);
const sofficeOk = has("soffice", ["--version"]);

function tmp(name: string, data: Uint8Array | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

test.describe(".xls → .xlsx（変換の中身）", () => {
  test("値・数式・書式・結合・列の幅・行の高さ・非表示のシートと行列を引き継ぐ", async () => {
    const out = convertXlsToXlsx(read("sample1.xls"));
    expect(out.checks.every((c) => c.ok), JSON.stringify(out.checks)).toBe(true);
    expect(out.sheets.map((s) => s.name)).toEqual(["売上表", "集計 (参照)", "非表示シート", "空白セル"]);
    expect(out.sheets[1].formulas).toBe(105);
    test.skip(!pythonOk, "openpyxl が無い環境");
    const file = tmp("out.xlsx", Buffer.from(await out.blob.arrayBuffer()));
    const report = JSON.parse(
      execFileSync("python3", [
        "-c",
        `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb["売上表"]; w2 = wb["集計 (参照)"]
r = {
 "states": [wb[n].sheet_state for n in wb.sheetnames],
 "A1": [ws["A1"].value, ws["A1"].font.name, ws["A1"].font.sz, ws["A1"].font.b, ws["A1"].font.color.rgb],
 "A3fill": ws["A3"].fill.fgColor.rgb, "A3border": ws["A3"].border.bottom.style,
 "B5": ws["B5"].value, "D4fmt": ws["D4"].number_format, "A4fmt": ws["A4"].number_format, "F4fmt": ws["F4"].number_format,
 "E5": ws["E5"].value, "E10": ws["E10"].value, "E12": ws["E12"].value,
 "G4": [ws["G4"].font.i, ws["G4"].font.u], "G5": ws["G5"].font.strike,
 "A14wrap": ws["A14"].alignment.wrap_text,
 "merges": sorted(str(m) for m in ws.merged_cells.ranges),
 "widthB": ws.column_dimensions["B"].width, "hiddenH": ws.column_dimensions["H"].hidden,
 "h1": ws.row_dimensions[1].height, "hidden20": ws.row_dimensions[20].hidden,
 "ref": [w2["B1"].value, w2["B4"].value, w2["C56"].value],
}
print(json.dumps(r, ensure_ascii=False))`,
        file,
      ]).toString()
    );
    expect(report.states).toEqual(["visible", "visible", "hidden", "visible"]);
    expect(report.A1).toEqual(["2024年度 売上一覧", "ＭＳ ゴシック", 16, true, "FFC00000"]);
    expect(report.A3fill).toBe("FF4472C4");
    expect(report.A3border).toBe("double");
    expect(report.B5).toBe("みかん");
    expect(report.D4fmt).toContain("#,##0");
    expect(report.A4fmt).toBe("yyyy/mm/dd");
    expect(report.F4fmt).toBe("0.0%");
    expect(report.E5).toBe("=C5*D5");
    expect(report.E10).toBe("=SUM(E4:E8)");
    expect(report.E12).toBe('=IF(E10>10000,"達成","未達")');
    expect(report.G4).toEqual([true, "single"]);
    expect(report.G5).toBe(true);
    expect(report.A14wrap).toBe(true);
    expect(report.merges).toEqual(["A14:C15", "A1:E1"]);
    expect(report.widthB).toBe(22);
    expect(report.hiddenH).toBe(true);
    expect(report.h1).toBe(30);
    expect(report.hidden20).toBe(true);
    expect(report.ref).toEqual(["='売上表'!E10", '=VLOOKUP("メロン",\'売上表\'!B4:E8,4,FALSE)', "=B56+$A$7"]);
  });

  test("LibreOfficeで開いて計算し直すと、元と同じ値になる（実際に開けるファイル）", async () => {
    test.skip(!sofficeOk, "LibreOffice が無い環境");
    const out = convertXlsToXlsx(read("sample1.xls"));
    const file = tmp("calc.xlsx", Buffer.from(await out.blob.arrayBuffer()));
    execFileSync("soffice", ["--headless", "--convert-to", "csv", "--outdir", path.dirname(file), file], { stdio: "ignore", timeout: 120_000 });
    const csv = fs.readFileSync(file.replace(/\.xlsx$/, ".csv"), "utf8");
    expect(csv).toContain("りんご,12,150,1800");
    expect(csv).toContain(",,,合計,16580");
    expect(csv).toContain(",,,判定,達成");
  });

  test("xlwt で作った .xls（別の作り方のファイル）も変換できる", () => {
    const out = convertXlsToXlsx(read("xlwt.xls"));
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(out.sheets[0]).toMatchObject({ name: "xlwtシート", formulas: 3, merges: 1 });
    const book = readXls(read("xlwt.xls"));
    const a1 = book.sheets[0].cells.get(0)?.get(0);
    expect(book.xfs[a1!.xf].font).toMatchObject({ name: "ＭＳ 明朝", bold: true, color: "FF0000" });
    expect(book.sheets[1].cells.get(0)?.get(0)?.formula).toBe("'xlwtシート'!A2+1");
  });

  test("値のない、書式だけのセル（罫線・塗りつぶし）も残す", async () => {
    const out = convertXlsToXlsx(read("sample1.xls"));
    expect(out.sheets[3]).toMatchObject({ name: "空白セル", cells: 2 });
    const { unzipSync, strFromU8 } = await import("fflate");
    const sheet4 = strFromU8(unzipSync(new Uint8Array(await out.blob.arrayBuffer()))["xl/worksheets/sheet4.xml"]);
    expect(sheet4).toMatch(/<c r="B3" s="\d+"\/>/);
  });

  test("壊れたファイル・別の形式・途中で切れたファイルは、分かる言葉で断る", () => {
    expect(() => convertXlsToXlsx(new TextEncoder().encode("not an excel file"))).toThrow(/古い形式のOffice文書/);
    expect(() => convertXlsToXlsx(read("sample1.xls").slice(0, 3000))).toThrow(/壊れています/);
    expect(() => convertXlsToXlsx(read("sample1.doc"))).toThrow(/Word文書（.doc）です/);
  });
});

test.describe(".doc → .docx（変換の中身）", () => {
  test("文字の書式・段落・表・画像・ヘッダー・フッター・セクションを引き継ぐ", () => {
    const m = readDoc(read("sample1.doc"));
    const first = m.body[1];
    expect(first.type).toBe("p");
    if (first.type !== "p") return;
    const runs = first.inlines.filter((i) => i.kind === "text");
    expect(runs.map((r) => (r.kind === "text" ? r.text : ""))).toEqual(["日時：2024年4月1日　", "赤い文字", "、斜体", "、下線", "、ゴシック体"]);
    expect(runs[0].props.bold).toBe(true);
    expect(runs[1].props).toMatchObject({ color: "C00000", sizeHalfPt: 28 });
    expect(runs[2].props.italic).toBe(true);
    expect(runs[3].props.underline).toBe("single");
    expect(m.fonts[runs[4].props.fontEastAsia!]).toBe("ＭＳ ゴシック");
    const table = m.body.find((b) => b.type === "table");
    expect(table && table.type === "table" && table.rows.length).toBe(3);
    expect(m.images).toHaveLength(1);
    expect(m.images[0].ext).toBe("png");
    expect(m.sections).toHaveLength(2);
    expect(m.sections[1].landscape).toBe(true);
    expect(m.headers[0].header.default?.length).toBeGreaterThan(0);

    const out = convertDocToDocx(read("sample1.doc"));
    expect(out.checks.every((c) => c.ok), JSON.stringify(out.checks)).toBe(true);
    expect(out.summary).toMatchObject({ tables: 1, images: 1, sections: 2 });
  });

  test("箇条書き・段落番号・脚注・セルの結合・セルの色・ページ番号・先頭ページのヘッダー", async () => {
    const out = convertDocToDocx(read("sample2.doc"));
    expect(out.checks.every((c) => c.ok), JSON.stringify(out.checks)).toBe(true);
    expect(out.summary.footnotes).toBe(1);
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(await out.blob.arrayBuffer()));
    const doc = strFromU8(files["word/document.xml"]);
    expect(doc).toContain('<w:gridSpan w:val="3"/>');
    expect(doc).toContain('<w:vMerge w:val="restart"/>');
    expect(doc).toContain('w:fill="DDDDDD"');
    expect(doc).toContain("<w:footnoteReference");
    expect(doc).toContain("<w:numPr>");
    expect(doc).toContain('<w:headerReference w:type="first"');
    expect(doc).toContain("<w:titlePg/>");
    expect(doc).toContain('w:fill="FFFF00"'); // 文字の網かけ（お見積り）
    expect(doc).toContain('<w:vertAlign w:val="superscript"/>');
    const footers = Object.keys(files).filter((n) => /word\/footer\d+\.xml$/.test(n)).map((n) => strFromU8(files[n]));
    expect(footers.some((f) => f.includes('w:instr=" PAGE "') && f.includes('w:instr=" NUMPAGES "'))).toBe(true);
    const numbering = strFromU8(files["word/numbering.xml"]);
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>');
    expect(numbering).toContain('<w:numFmt w:val="lowerLetter"/>');
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>');
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) expect(isWellFormedXml(strFromU8(data)), name).toBe(true);
    }
  });

  test("JPEGの画像・縦書きのセクションも引き継ぐ", async () => {
    const jpg = convertDocToDocx(read("jpg.doc"));
    expect(jpg.summary.images).toBe(1);
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(new Uint8Array(await jpg.blob.arrayBuffer()));
    expect(Object.keys(files)).toContain("word/media/image1.jpeg");
    expect([...files["word/media/image1.jpeg"].subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const v = unzipSync(new Uint8Array(await convertDocToDocx(read("vertical.doc")).blob.arrayBuffer()));
    expect(strFromU8(v["word/document.xml"])).toContain('<w:textDirection w:val="tbRl"/>');
  });

  test("LibreOfficeでページにすると、元の .doc と同じ文字・同じページ数になる", async () => {
    test.skip(!sofficeOk || !has("pdftotext", ["-v"]), "LibreOffice・pdftotext が無い環境");
    for (const name of ["sample1.doc", "sample2.doc"]) {
      const out = convertDocToDocx(read(name));
      const docx = tmp("conv.docx", Buffer.from(await out.blob.arrayBuffer()));
      const orig = path.join(path.dirname(docx), "orig.doc");
      fs.copyFileSync(path.join(DIR, name), orig);
      execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", path.dirname(docx), docx, orig], { stdio: "ignore", timeout: 180_000 });
      const text = (f: string) => execFileSync("pdftotext", ["-layout", f, "-"]).toString().replace(/\s+/g, "");
      const pages = (f: string) => Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [f]).toString())?.[1]);
      const a = path.join(path.dirname(docx), "orig.pdf");
      const b = path.join(path.dirname(docx), "conv.pdf");
      expect(pages(b), name).toBe(pages(a));
      expect(text(b), name).toBe(text(a));
    }
  });

  test("壊れたファイル・別の形式は、分かる言葉で断る", () => {
    expect(() => convertDocToDocx(new TextEncoder().encode("hello"))).toThrow(/古い形式のOffice文書/);
    expect(() => convertDocToDocx(read("sample1.doc").slice(0, 5000))).toThrow(/壊れています/);
    expect(() => convertDocToDocx(read("sample1.xls"))).toThrow(/Excelのファイル（.xls）です/);
  });
});

test.describe("画面", () => {
  test(".xls を選んで変換し、.xlsx をダウンロードできる", async ({ page }) => {
    await page.goto("/tools/xls-to-xlsx");
    await uploadFixture(page, path.join(DIR, "sample1.xls"));
    await page.getByTestId("legacy-convert-run").click();
    await expect(page.getByTestId("legacy-convert-result")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("legacy-xls-sheet")).toHaveCount(4);
    await expect(page.getByTestId("conversion-checks")).toContainText("問題は見つかりませんでした");
    const dl = await clickAndDownload(page, "Excelファイル(.xlsx)をダウンロード");
    expect(dl.suggestedFilename()).toBe("sample1.xlsx");
    const buf = fs.readFileSync((await dl.path())!);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  test(".doc を選んで変換し、.docx をダウンロードできる。プレビューも見られる", async ({ page }) => {
    await page.goto("/tools/doc-to-docx");
    await uploadFixture(page, path.join(DIR, "sample2.doc"));
    await page.getByTestId("legacy-convert-run").click();
    await expect(page.getByTestId("legacy-doc-summary")).toContainText("表1個", { timeout: 60_000 });
    await expect(page.getByTestId("conversion-checks")).toContainText("問題は見つかりませんでした");
    const dl = await clickAndDownload(page, "Word文書(.docx)をダウンロード");
    expect(dl.suggestedFilename()).toBe("sample2.docx");
  });

  test("壊れたファイル・新しい形式のファイルには、エラーを出す", async ({ page }) => {
    await page.goto("/tools/doc-to-docx");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "broken.doc", mimeType: "application/msword", buffer: Buffer.from("broken file") });
    await page.getByTestId("legacy-convert-run").click();
    await expect(page.getByTestId("legacy-convert-error")).toContainText("古い形式のOffice文書", { timeout: 30_000 });
  });
});
