import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";

/**
 * Excel→Word・Word→Excel の品質テスト（指示書7章）。
 *
 * - テスト用のExcel・Wordファイルは、python（openpyxl・python-docx）で毎回作る（架空のデータだけ）。
 * - Excel→Word：変換したWord文書を LibreOffice で実際にページへ配置（PDFに描画）して、
 *   表・画像・文字がページの左右・余白からはみ出していないか、用紙がA4か、を調べる（XMLの数値だけで合格にしない）。
 * - Word→Excel：変換したExcelファイルを openpyxl で開き、行数・列数・セルの文字・結合・シートの順番を、元のWordの表と比べる。
 * python・LibreOffice が無い環境では、このファイルのテストを飛ばす。
 */

const OUT = path.join(fixtures.dir.generated, "office-convert");
const SCRIPTS = path.join(__dirname, "..", "fixtures", "office-convert");

function toolsAvailable(): boolean {
  try {
    execFileSync("python3", ["-c", "import openpyxl, docx, pdfplumber, PIL"], { stdio: "ignore" });
    execFileSync("soffice", ["--version"], { stdio: "ignore", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}
const available = toolsAvailable();

test.beforeAll(() => {
  if (!available) return;
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync("python3", [path.join(SCRIPTS, "generate_fixtures.py"), OUT], { stdio: "ignore" });
});

interface LayoutReport {
  pages: { width: number; height: number; minX: number | null; maxX: number | null; minY: number | null; maxY: number | null; words: number; images: number }[];
  sections: { width: number; height: number; left: number; right: number; top: number; bottom: number }[];
  text: string;
}

function layoutOf(docx: string): LayoutReport {
  const work = path.join(OUT, "render", path.basename(docx, ".docx"));
  const json = execFileSync("python3", [path.join(SCRIPTS, "check_docx_layout.py"), docx, work], { timeout: 200_000 }).toString();
  return JSON.parse(json) as LayoutReport;
}

const A4_W = 595.3;
const A4_H = 841.9;
/** 描画のわずかなずれ（罫線の太さの半分など）の許容（pt） */
const TOL = 2;

async function convertExcel(page: Page, name: string, opts: { landscape?: boolean } = {}) {
  await page.goto("/tools/excel-to-word");
  await uploadFixture(page, path.join(OUT, name));
  await expect(page.getByTestId("excel-to-word-sheets")).toBeVisible({ timeout: 30_000 });
  if (opts.landscape === false) await page.getByLabel(/横向きのページにする/).uncheck();
  await page.getByRole("button", { name: "Wordに変換する" }).click();
  await expect(page.getByTestId("excel-to-word-result")).toBeVisible({ timeout: 120_000 });
  const download = await clickAndDownload(page, "Word文書をダウンロード");
  const file = path.join(OUT, `${path.basename(name, ".xlsx")}.docx`);
  await download.saveAs(file);
  const checks = await page.getByTestId("conversion-checks").locator("li").evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? "", ok: e.getAttribute("data-ok") === "true" })));
  const warnings = (await page.getByTestId("conversion-warnings").count()) > 0 ? await page.getByTestId("conversion-warnings").innerText() : "";
  return { file, checks, warnings };
}

/** すべてのページで、描いたもの（文字・罫線・画像）が、用紙の中・左右の余白の内側にあること */
function expectInsidePages(report: LayoutReport, label: string) {
  expect(report.pages.length, `${label}: ページがありません`).toBeGreaterThan(0);
  report.pages.forEach((p, i) => {
    const sec = report.sections.find((s) => Math.abs(s.width - p.width) < 1 && Math.abs(s.height - p.height) < 1) ?? report.sections[0];
    if (p.minX === null || p.maxX === null) return;
    expect(p.minX, `${label} ${i + 1}ページ目：左端が用紙の外`).toBeGreaterThanOrEqual(-0.5);
    expect(p.maxX, `${label} ${i + 1}ページ目：右端が用紙の外`).toBeLessThanOrEqual(p.width + 0.5);
    expect(p.minX, `${label} ${i + 1}ページ目：左の余白にはみ出し`).toBeGreaterThanOrEqual(sec.left - TOL);
    expect(p.maxX, `${label} ${i + 1}ページ目：右の余白にはみ出し（右端${p.maxX.toFixed(1)}pt・限度${(p.width - sec.right).toFixed(1)}pt）`).toBeLessThanOrEqual(p.width - sec.right + TOL);
    // 上下も用紙の中（画像が行の高さで上に飛び出す、などが無いこと）
    if (p.minY !== null && p.maxY !== null) {
      expect(p.minY, `${label} ${i + 1}ページ目：上端が用紙の外`).toBeGreaterThanOrEqual(-0.5);
      expect(p.maxY, `${label} ${i + 1}ページ目：下端が用紙の外`).toBeLessThanOrEqual(p.height + 0.5);
    }
  });
}

function expectA4(report: LayoutReport, orientation: "portrait" | "landscape", label: string) {
  for (const p of report.pages) {
    const [w, h] = orientation === "portrait" ? [A4_W, A4_H] : [A4_H, A4_W];
    expect(Math.abs(p.width - w), `${label}: 用紙の幅`).toBeLessThan(1.5);
    expect(Math.abs(p.height - h), `${label}: 用紙の高さ`).toBeLessThan(1.5);
  }
}

test.describe("Excel→Word（LibreOfficeで描画して、はみ出しを確かめる）", () => {
  test.skip(!available, "python（openpyxl・python-docx・pdfplumber）または LibreOffice がありません");
  test.describe.configure({ timeout: 240_000 });

  const cases: { file: string; orientation: "portrait" | "landscape"; minPages?: number; text?: string[]; note?: RegExp }[] = [
    { file: "x01-a4-portrait-simple.xlsx", orientation: "portrait", text: ["項目1", "データ12-1", "1201"] },
    { file: "x02-a4-landscape-simple.xlsx", orientation: "landscape", text: ["項目8"] },
    { file: "x03-a4-portrait-wide.xlsx", orientation: "landscape", text: ["項目14"], note: /横向きのページにしました/ },
    { file: "x04-a4-landscape-wide.xlsx", orientation: "landscape", text: ["項目22"] },
    { file: "x05-long-text.xlsx", orientation: "portrait", text: ["改行あり", "2行目"] },
    { file: "x06-merged.xlsx", orientation: "portrait", text: ["結合セルの多い表（タイトル）", "第1区分", "第2区分"] },
    { file: "x07-image.xlsx", orientation: "portrait" },
    { file: "x08-chart.xlsx", orientation: "portrait", text: ["月", "売上"] },
    { file: "x10-print-area.xlsx", orientation: "portrait", text: ["項目4"] },
    { file: "x11-manual-breaks.xlsx", orientation: "portrait", minPages: 3 },
    { file: "x12-hidden.xlsx", orientation: "portrait", note: /非表示の/ },
    { file: "x13-japanese-fonts.xlsx", orientation: "portrait", text: ["游明朝", "メイリオ"] },
    { file: "x14-font-sizes.xlsx", orientation: "portrait", text: ["24ptの文字"] },
    { file: "x15-borders-colors.xlsx", orientation: "portrait", text: ["00123", "25.6%", "1,234,567.89", "¥5,000", "2026/11/14"] },
    { file: "x16-very-wide.xlsx", orientation: "landscape", minPages: 2, text: ["項目40"], note: /列の途中で/ },
    { file: "x17-long-vertical.xlsx", orientation: "portrait", minPages: 3, text: ["データ160-1"] },
    { file: "x18-images-and-table.xlsx", orientation: "portrait" },
  ];

  for (const c of cases) {
    test(`${c.file}：A4の${c.orientation === "portrait" ? "縦" : "横"}で、表・画像がページからはみ出さない`, async ({ page }) => {
      const { file, checks, warnings } = await convertExcel(page, c.file);
      // 画面の「変換後の確認」に、はみ出しの問題が無い
      expect(checks.find((x) => x.text.includes("横幅に収まっている"))?.ok, JSON.stringify(checks)).toBe(true);
      expect(checks.find((x) => x.text.includes("画像・グラフ"))?.ok).toBe(true);
      expect(checks.find((x) => x.text.includes("用紙の大きさ"))?.ok).toBe(true);
      expect(checks.find((x) => x.text.includes("文字の欠け"))?.ok, JSON.stringify(checks)).toBe(true);
      if (c.note) expect(warnings).toMatch(c.note);

      const report = layoutOf(file);
      expectA4(report, c.orientation, c.file);
      expectInsidePages(report, c.file);
      if (c.minPages) expect(report.pages.length).toBeGreaterThanOrEqual(c.minPages);
      // 空白のページが無い
      expect(report.pages.filter((p) => p.words === 0 && p.images === 0 && p.minX === null).length, "空白のページ").toBe(0);
      for (const t of c.text ?? []) expect(report.text, `「${t}」が入っていません`).toContain(t);
    });
  }

  test("x09：複数のシートは、シートごとの向きのページになり、順番どおりに並ぶ", async ({ page }) => {
    const { file } = await convertExcel(page, "x09-multi-sheet.xlsx");
    const report = layoutOf(file);
    expectInsidePages(report, "x09");
    expect(report.sections.map((s) => (s.width > s.height ? "landscape" : "portrait"))).toEqual(["portrait", "landscape", "portrait"]);
    const order = ["項目4", "項目5", "項目6"].map((t) => report.text.indexOf(t));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]))).toBe(true);
  });

  test("x03：横向きへの自動の変更をオフにすると、縦向きのまま（列の幅を縮める・列で分ける）で、はみ出さない", async ({ page }) => {
    const { file } = await convertExcel(page, "x03-a4-portrait-wide.xlsx", { landscape: false });
    const report = layoutOf(file);
    expectA4(report, "portrait", "x03縦");
    expectInsidePages(report, "x03縦");
    expect(report.text).toContain("項目14");
  });

  test("x16：列を分けたページにも、すべての列の見出しが入る（列を消さない）", async ({ page }) => {
    const { file } = await convertExcel(page, "x16-very-wide.xlsx");
    const report = layoutOf(file);
    for (let i = 1; i <= 40; i++) expect(report.text).toContain(`項目${i}`);
  });

  test("x18：表より上の画像は表の前、下の画像は表の後に置く（表と重ねない）", async ({ page }) => {
    const { file } = await convertExcel(page, "x18-images-and-table.xlsx");
    const xml = execFileSync("python3", ["-c", "import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode())", file]).toString();
    const firstDrawing = xml.indexOf("<w:drawing");
    const table = xml.indexOf("<w:tbl>");
    const lastDrawing = xml.lastIndexOf("<w:drawing");
    expect(firstDrawing).toBeGreaterThan(-1);
    expect(firstDrawing).toBeLessThan(table);
    expect(lastDrawing).toBeGreaterThan(table);
  });

  test("x17：見出しの行を、次のページにも繰り返す", async ({ page }) => {
    const { file } = await convertExcel(page, "x17-long-vertical.xlsx");
    const xml = execFileSync("python3", ["-c", "import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode())", file]).toString();
    expect(xml).toContain("<w:tblHeader/>");
    expect(xml).toContain('w:type="fixed"');
    // ヘッダー（シート名）・フッター（ページ番号／総ページ数）
    const parts = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print('\\n'.join(z.read(n).decode() for n in z.namelist() if n.startswith('word/header') or n.startswith('word/footer')))", file]).toString();
    expect(parts).toContain("縦に長い");
    expect(parts).toContain("PAGE");
    expect(parts).toContain("NUMPAGES");
  });

  test("壊れたファイル・古い形式は、分かりやすい案内を出す", async ({ page }) => {
    await page.goto("/tools/excel-to-word");
    const broken = path.join(OUT, "broken.xlsx");
    fs.writeFileSync(broken, "this is not an excel file");
    await uploadFixture(page, broken);
    await expect(page.getByRole("alert").filter({ hasText: /読み込めませんでした|壊れて/ })).toBeVisible({ timeout: 20_000 });
    const xls = path.join(OUT, "old.xls");
    fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await uploadFixture(page, xls);
    await expect(page.getByText(/古い形式のExcelファイル（.xls）/)).toBeVisible({ timeout: 20_000 });
  });
});

interface XlsxReport {
  sheets: { name: string; maxRow: number; maxCol: number; merges: string[]; cells: Record<string, string | number | null>; images: number; fonts: Record<string, { bold: boolean; color: string | null; size: number | null; fill: string | null; h: string | null }> }[];
}

function xlsxOf(file: string): XlsxReport {
  const script = `
import json, sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
out = []
for ws in wb.worksheets:
    cells = {}
    fonts = {}
    for row in ws.iter_rows():
        for c in row:
            if c.value is not None:
                v = c.value
                if hasattr(v, "isoformat"): v = v.date().isoformat() if hasattr(v, "date") else v.isoformat()
                cells[c.coordinate] = v
                fonts[c.coordinate] = {"bold": bool(c.font.b), "color": (c.font.color.rgb if c.font.color is not None and isinstance(c.font.color.rgb, str) else None), "size": c.font.sz, "fill": (c.fill.fgColor.rgb if c.fill and c.fill.fill_type == "solid" else None), "h": c.alignment.horizontal}
    out.append({"name": ws.title, "maxRow": ws.max_row, "maxCol": ws.max_column, "merges": [str(m) for m in ws.merged_cells.ranges], "cells": cells, "images": len(ws._images), "fonts": fonts})
print(json.dumps({"sheets": out}, ensure_ascii=False, default=str))
`;
  return JSON.parse(execFileSync("python3", ["-c", script, file]).toString()) as XlsxReport;
}

async function convertWord(page: Page, name: string) {
  await page.goto("/tools/word-to-excel");
  await uploadFixture(page, path.join(OUT, name));
  await expect(page.getByTestId("word-to-excel-tables")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await expect(page.getByTestId("word-to-excel-result")).toBeVisible({ timeout: 120_000 });
  const download = await clickAndDownload(page, "Excelファイルをダウンロード");
  const file = path.join(OUT, `${path.basename(name, ".docx")}.xlsx`);
  await download.saveAs(file);
  const checks = await page.getByTestId("conversion-checks").locator("li").evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? "", ok: e.getAttribute("data-ok") === "true" })));
  const warnings = (await page.getByTestId("conversion-warnings").count()) > 0 ? await page.getByTestId("conversion-warnings").innerText() : "";
  return { file, checks, warnings, report: xlsxOf(file) };
}

function expectAllChecksOk(checks: { text: string; ok: boolean }[]) {
  for (const c of checks) expect(c.ok, `確認で問題：${c.text}`).toBe(true);
}

test.describe("Word→Excel（openpyxlで開いて、元の表と比べる）", () => {
  test.skip(!available, "python（openpyxl・python-docx）がありません");
  test.describe.configure({ timeout: 120_000 });

  test("w01 単純な表：行・列・文字がそのまま", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w01-simple.docx");
    expectAllChecksOk(checks);
    expect(report.sheets).toHaveLength(1);
    const s = report.sheets[0];
    expect(s.maxRow).toBe(4);
    expect(s.maxCol).toBe(3);
    expect(s.cells.A1).toBe("見出し1");
    expect(s.cells.C4).toBe("値3-3");
  });

  test("w02・w07 複数の表：表ごとにシート、見出しがシート名、順番どおり、本文は最後のシート", async ({ page }) => {
    const r2 = await convertWord(page, "w02-multiple.docx");
    expectAllChecksOk(r2.checks);
    expect(r2.report.sheets.map((s) => s.name)).toEqual(["売上の表", "仕入の表", "本文"]);
    const r7 = await convertWord(page, "w07-headings.docx");
    expectAllChecksOk(r7.checks);
    expect(r7.report.sheets.map((s) => s.name)).toEqual(["表1：会員の一覧", "表2：料金", "本文"]);
    const body = Object.values(r7.report.sheets[2].cells).map(String);
    expect(body).toContain("文書の題名");
    expect(body.some((t) => t.includes("シート「表1：会員の一覧」"))).toBe(true);
    expect(body.indexOf("はじめに、説明の文章を書きます。")).toBeLessThan(body.indexOf("おわりの文章。"));
  });

  test("w03 結合セル：縦・横の結合を引き継ぐ", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w03-merged.docx");
    expectAllChecksOk(checks);
    const s = report.sheets[0];
    expect(s.merges.sort()).toEqual(["A2:A4", "B1:D1"].sort());
    expect(s.cells.A2).toBe("縦に結合");
    expect(s.cells.B1).toBe("横に結合");
  });

  test("w04 複数ページにまたがる表：1つのシートに、すべての行", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w04-multipage.docx");
    expectAllChecksOk(checks);
    expect(report.sheets[0].maxRow).toBe(120);
    expect(report.sheets[0].cells.C120).toBe("値119-3");
  });

  test("w05 長い文章・セルの中の段落：途中で切れず、改行が残る", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w05-long-text.docx");
    expectAllChecksOk(checks);
    expect(report.sheets[0].cells.B2).toBe("長い文章のセルです。".repeat(30));
    expect(report.sheets[0].cells.B3).toBe("1つ目の段落\n2つ目の段落");
  });

  test("w06 画像：本文の画像と表の中の画像を、シートに置く", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w06-images.docx");
    expectAllChecksOk(checks);
    const total = report.sheets.reduce((n, s) => n + s.images, 0);
    expect(total).toBe(2);
  });

  test("w08 日本語・英語の混在", async ({ page }) => {
    const { report } = await convertWord(page, "w08-mixed-lang.docx");
    expect(report.sheets[0].cells.C2).toBe("混在 mixed 123");
  });

  test("w09 書式：背景色・太字・文字色・大きさ・配置・一部だけの太字", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w09-complex-format.docx");
    expectAllChecksOk(checks);
    const f = report.sheets[0].fonts;
    expect(f.A1.fill).toBe("FFFFC000");
    expect(f.B2.fill).toBe("FFBDD7EE");
    expect(f.A2.bold).toBe(true);
    expect(f.A2.color).toBe("FFC00000");
    expect(f.A2.size).toBe(14);
    expect(f.C3.h).toBe("right");
    expect(f.A4.h).toBe("center");
    expect(report.sheets[0].cells.C3).toBe("一部だけ太字");
  });

  test("w10 空白のセルが多い表：位置がずれない", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w10-sparse.docx");
    expectAllChecksOk(checks);
    const c = report.sheets[0].cells;
    expect(c.A1).toBe("あり00");
    expect(c.D3).toBe("あり23");
    expect(c.E6).toBe("あり54");
    expect(c.B4).toBe("あり31");
    expect(Object.keys(c)).toHaveLength(4);
  });

  test("w11 数値・日付：表示を変えずに数値・日付へ。先頭のゼロ・電話番号・ありえない日付は文字のまま", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w11-numbers-dates.docx");
    expectAllChecksOk(checks);
    const c = report.sheets[0].cells;
    expect(c.B2).toBe(1200);
    expect(c.C2).toBe(150);
    expect(c.D2).toBe("2026-11-14");
    expect(c.C3).toBeCloseTo(0.125);
    expect(c.D3).toBe("2026-01-05");
    expect(c.B4).toBe("00123");
    expect(c.C4).toBe("03-1234-5678");
    expect(c.D4).toBe("2026/02/30");
    expect(c.B5).toBe(-42);
    expect(c.C5).toBe(1500);
    expect(c.D5).toBe("R8.1.1");
    expect(c.B6).toBe(3.14);
    expect(c.D6).toBe("1/2");
  });

  test("w12 表の前後の文章：本文のシートに順番どおり、表は別のシート", async ({ page }) => {
    const { checks, report } = await convertWord(page, "w12-text-around.docx");
    expectAllChecksOk(checks);
    expect(report.sheets.map((s) => s.name)).toEqual(["表1", "本文"]);
    const body = Object.values(report.sheets[1].cells).map(String);
    expect(body[0]).toBe("表の前の文章です。説明があります。");
    expect(body.some((t) => t.includes("→ シート「表1」"))).toBe(true);
    expect(body.some((t) => t.includes("箇条書き1"))).toBe(true);
  });

  test("古い形式（.doc）は、保存し直しを案内する", async ({ page }) => {
    await page.goto("/tools/word-to-excel");
    const doc = path.join(OUT, "old.doc");
    fs.writeFileSync(doc, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await uploadFixture(page, doc);
    await expect(page.getByText(/古い形式のWord文書（.doc）には対応していません/)).toBeVisible({ timeout: 20_000 });
  });
});
