import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture, clickAndDownload } from "../helpers/tool-runner";

/**
 * 新しい4つのツール（2026-11-17）：和暦・西暦一括変換・Word結合・Word→画像・Excelシート分割/結合。
 * 書き出したファイルを Python（openpyxl・python-docx）で開き直して中身を確かめ、LibreOffice があれば開けることも確かめる。
 */

const DIR = path.join(__dirname, "../fixtures/office-merge");
const fx = (n: string) => path.join(DIR, n);
const pythonOk = (() => {
  try {
    execFileSync("python3", ["-c", "import openpyxl, docx"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const sofficeOk = (() => {
  try {
    execFileSync("which", ["soffice"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function py(script: string, ...files: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync("python3", ["-c", script, ...files]).toString());
}

function tmp(name: string) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "newtools-")), name);
}

function opensInLibreOffice(file: string) {
  if (!sofficeOk) return;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-"));
  execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outDir, file], { stdio: "ignore", timeout: 120_000 });
  expect(fs.readdirSync(outDir).some((f) => f.endsWith(".pdf")), "LibreOffice で開いてPDFにできる").toBe(true);
}

async function save(page: Page, name: RegExp | string, file: string) {
  const dl = await clickAndDownload(page, name);
  const out = tmp(file);
  await dl.saveAs(out);
  return { out, suggested: dl.suggestedFilename() };
}

function unzipList(file: string): string[] {
  return py(`import json,sys,zipfile; print(json.dumps({"n": zipfile.ZipFile(sys.argv[1]).namelist()}))`, file).n as string[];
}

test.describe.configure({ timeout: 180_000 });

/** ページを開き、操作できる状態（読み込み後）になるまで待つ */
async function open(page: Page, id: string) {
  await page.goto(`/tools/${id}`);
  await expect(page.getByTestId("guide-open-howto")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
test.describe("和暦・西暦一括変換", () => {
  test("貼り付けた日付：変換・要確認・そのままを分けて表示し、元年・改元日を正しく扱う", async ({ page }) => {
    await open(page, "wareki-convert");
    await page.getByTestId("wareki-text").fill(["2026/11/17", "2019/5/1", "1989/1/7", "令和元年5月1日", "H31.5.1", "2026/2/30", "山田太郎"].join("\n"));
    const preview = page.getByTestId("wareki-preview");
    await expect(preview).toContainText("令和8年11月17日");
    await expect(preview).toContainText("令和元年5月1日");
    await expect(preview).toContainText("昭和64年1月7日");
    await expect(preview).toContainText("2019/05/01");
    await expect(preview).toContainText("平成の期間にありません");
    await expect(preview).toContainText("存在しない日付です");
    await expect(page.getByTestId("wareki-summary")).toContainText("変換 4件");
    await expect(page.getByTestId("wareki-summary")).toContainText("要確認 2件");
    await expect(page.getByTestId("wareki-summary")).toContainText("そのまま 1件");
    // 向きを「西暦→和暦」にすると、和暦の値はそのまま
    await page.getByTestId("wareki-direction").getByRole("radio", { name: "西暦→和暦" }).click();
    await expect(page.getByTestId("wareki-summary")).toContainText("変換 3件");
  });

  test("CSV：日付の列を自動で選び、元の列の右に変換結果の列を足した別ファイルを書き出す（要確認は元の値のまま）", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "wareki-convert");
    await page.getByTestId("wareki-mode").getByRole("radio", { name: "Excel・CSVから" }).click();
    await uploadFixture(page, fx("wareki.csv"));
    await expect(page.getByTestId("wareki-preview")).toBeVisible();
    // 生年月日の列だけが選ばれている
    const cols = page.getByTestId("wareki-columns").locator("input[type=checkbox]");
    await expect(cols.nth(1)).toBeChecked();
    await expect(cols.nth(0)).not.toBeChecked();
    await expect(page.getByTestId("wareki-summary")).toContainText("変換 2件");
    await expect(page.getByTestId("wareki-summary")).toContainText("要確認 2件");
    const { out, suggested } = await save(page, /CSVでダウンロード/, "out.csv");
    expect(suggested).toBe("wareki_変換.csv");
    const text = fs.readFileSync(out, "utf8").replace(/^﻿/, "");
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe("氏名,生年月日,生年月日（変換結果）,備考");
    expect(lines[1]).toBe("山田,1989/1/7,昭和64年1月7日,昭和最後");
    expect(lines[2]).toBe("佐藤,令和元年5月1日,2019/05/01,令和初日");
    expect(lines[3]).toBe("鈴木,2026/2/30,2026/2/30,存在しない");
    // 元のファイルは変わらない
    expect(fs.readFileSync(fx("wareki.csv"), "utf8")).toContain("山田,1989/1/7,昭和最後");
  });

  test("Excel：日付の書式のセルも和暦にし、Excelで書き出す", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "wareki-convert");
    await page.getByTestId("wareki-mode").getByRole("radio", { name: "Excel・CSVから" }).click();
    await uploadFixture(page, fx("wareki.xlsx"));
    await expect(page.getByTestId("wareki-preview")).toContainText("平成31年4月30日");
    await expect(page.getByTestId("wareki-preview")).toContainText("令和元年5月1日");
    await expect(page.getByTestId("wareki-preview")).toContainText("1975/04/01");
    const { out } = await save(page, /Excel（\.xlsx）でダウンロード/, "out.xlsx");
    const r = py(
      `import json,sys,openpyxl
ws=openpyxl.load_workbook(sys.argv[1]).active
print(json.dumps({"h":[c.value for c in ws[1]],"r2":ws["C2"].value,"r3":ws["C3"].value,"r4":ws["C4"].value,"n":ws["D2"].value}))`,
      out
    );
    expect(r.h).toEqual(["氏名", "入社日", "入社日（変換結果）", "番号"]);
    expect(r.r2).toBe("平成31年4月30日");
    expect(r.r3).toBe("令和元年5月1日");
    expect(r.r4).toBe("1975/04/01");
    expect(r.n).toBe(101);
  });

  test("異常系：Excel・CSV以外のファイルはエラーを出す", async ({ page }) => {
    await open(page, "wareki-convert");
    await page.getByTestId("wareki-mode").getByRole("radio", { name: "Excel・CSVから" }).click();
    await uploadFixture(page, fx("merge-a.docx"));
    await expect(page.getByTestId("wareki-error")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
test.describe("Word結合", () => {
  test("3つのWordを結合：本文・書式・表・画像・ヘッダー/フッター・用紙の設定がファイルごとに残り、ヘッダーは引き継がない", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "word-merge");
    await uploadFixture(page, [fx("merge-a.docx"), fx("merge-b.docx"), fx("merge-c-plain.docx")]);
    await expect(page.getByTestId("word-merge-run")).toContainText("3件のWordを結合する");
    await page.getByTestId("word-merge-run").click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    const { out, suggested } = await save(page, /ダウンロード/, "merged.docx");
    expect(suggested).toBe("merge-a_結合.docx");
    const r = py(
      `import json,sys,docx
d=docx.Document(sys.argv[1])
paras=[p.text for p in d.paragraphs]
secs=[]
for s in d.sections:
  secs.append({"w":round(s.page_width.mm),"h":round(s.page_height.mm),"top":round(s.top_margin.mm),"left":round(s.left_margin.mm),
    "header":" ".join(p.text for p in s.header.paragraphs) if not s.header.is_linked_to_previous else "(linked)",
    "footer":" ".join(p.text for p in s.footer.paragraphs) if not s.footer.is_linked_to_previous else "(linked)"})
bold=[r.text for p in d.paragraphs for r in p.runs if r.bold]
red=[r.text for p in d.paragraphs for r in p.runs if r.font.color and r.font.color.rgb is not None and str(r.font.color.rgb)=="C00000"]
imgs=len(d.inline_shapes)
print(json.dumps({"paras":paras,"secs":secs,"bold":bold,"red":red,"tables":len(d.tables),"imgs":imgs,"t0":d.tables[0].cell(1,1).text}))`,
      out
    );
    const paras = r.paras as string[];
    const idx = (t: string) => paras.findIndex((p) => p.includes(t));
    expect(idx("文書A見出し")).toBeGreaterThanOrEqual(0);
    expect(idx("文書A2ページ目")).toBeGreaterThan(idx("文書A見出し"));
    expect(idx("文書B見出し")).toBeGreaterThan(idx("文書A2ページ目"));
    expect(idx("文書B第2セクション")).toBeGreaterThan(idx("文書B本文"));
    expect(idx("文書Cヘッダーなし")).toBeGreaterThan(idx("文書B第2セクション"));
    expect(r.bold).toContain("太字赤");
    expect(r.red).toContain("太字赤");
    expect(r.tables).toBe(1);
    expect(r.t0).toBe("B2");
    expect(r.imgs).toBe(2);
    const secs = r.secs as { w: number; h: number; top: number; left: number; header: string; footer: string }[];
    expect(secs).toHaveLength(4);
    // A：A4縦・左余白30mm・ヘッダー/フッターA
    expect(secs[0]).toMatchObject({ w: 210, h: 297, left: 30, header: "ヘッダーA", footer: "フッターA" });
    // B：レター横・上余白10mm・ヘッダーB（フッターは引き継がず空）
    expect(secs[1]).toMatchObject({ w: 279, h: 216, top: 10, left: 15, header: "ヘッダーB", footer: "" });
    // B の2つ目のセクション：縦（ヘッダーは B のものを引き継ぐ＝元の文書と同じ）
    expect(secs[2]).toMatchObject({ w: 216, h: 279 });
    // C：ヘッダー・フッターなし（前のファイルのものを引き継がない）
    expect(secs[3].header).toBe("");
    expect(secs[3].footer).toBe("");
    opensInLibreOffice(out);
  });

  test("並べ替え・削除が結合の順番に反映される。スタイルの違う文書（LibreOffice作成）も結合できる", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "word-merge");
    await uploadFixture(page, [fx("merge-a.docx"), fx("merge-lo.docx"), fx("merge-c-plain.docx")]);
    await expect(page.getByTestId("tool-preview")).toContainText("merge-lo.docx");
    // 3つ目（merge-c-plain）を外し、2つ目（merge-lo）を先頭へ
    await page.getByRole("button", { name: /merge-c-plain\.docx.*(削除|外す)/ }).click();
    await page.getByRole("button", { name: /merge-lo\.docx.*上/ }).click();
    await expect(page.getByTestId("word-merge-run")).toContainText("2件のWordを結合する");
    await page.getByTestId("word-merge-page-numbers").getByRole("radio", { name: "ファイルごとに1から" }).click();
    await page.getByTestId("word-merge-run").click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    const { out, suggested } = await save(page, /ダウンロード/, "merged2.docx");
    expect(suggested).toBe("merge-lo_結合.docx");
    const r = py(
      `import json,sys,docx
d=docx.Document(sys.argv[1])
x=d.element.body.xml
print(json.dumps({"paras":[p.text for p in d.paragraphs if p.text],"tables":len(d.tables),"restart":'w:start="1"' in x}))`,
      out
    );
    const paras = r.paras as string[];
    expect(paras.findIndex((p) => p.includes("文書L見出し"))).toBeLessThan(paras.findIndex((p) => p.includes("文書A見出し")));
    expect(paras.some((p) => p.includes("文書Cヘッダーなし"))).toBe(false);
    expect(r.tables).toBe(2);
    expect(r.restart).toBe(true);
    opensInLibreOffice(out);
  });

  test("異常系：Word以外・壊れたファイルはエラーになり、ダウンロードできない", async ({ page }) => {
    await open(page, "word-merge");
    await uploadFixture(page, [fx("wareki.csv")]);
    await expect(page.getByTestId("word-merge-error")).toContainText("対応していません");
    await uploadFixture(page, [fx("merge-a.docx"), fx("broken.docx")]);
    await page.getByTestId("word-merge-run").click();
    await expect(page.getByTestId("word-merge-error")).toContainText("broken.docx");
    await expect(page.getByTestId("result-popup")).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
test.describe("Word→画像", () => {
  test("ページのプレビューを出し、選んだページを指定の解像度でPNGにする。複数ページはZIP", async ({ page }) => {
    await open(page, "word-to-image");
    await uploadFixture(page, fx("merge-a.docx"));
    const pages = page.getByTestId("word-image-page");
    await expect(pages.first()).toBeVisible({ timeout: 60_000 });
    const count = await pages.count();
    expect(count).toBeGreaterThanOrEqual(2);
    // すべてのページ・150dpi（A4 = 1240×1754px 前後）
    await page.getByTestId("word-image-run").click();
    await expect(page.getByTestId("word-image-result")).toContainText(`${count}枚`, { timeout: 60_000 });
    await expect(page.getByTestId("word-image-result")).toContainText(/12[34]\d×17[45]\dpx/);
    const { out, suggested } = await save(page, /ZIPをダウンロード/, "pages.zip");
    expect(suggested).toBe("merge-a-images.zip");
    const names = unzipList(out);
    expect(names).toHaveLength(count);
    expect(names[0]).toMatch(/^merge-a-0?1\.png$/);
  });

  test("ページを選ぶ：番号で1ページだけ選ぶとJPEG1枚になり、96dpiで小さくなる。不正な番号はエラー", async ({ page }) => {
    await open(page, "word-to-image");
    await uploadFixture(page, fx("merge-a.docx"));
    await expect(page.getByTestId("word-image-page").first()).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("word-image-page-mode").getByRole("radio", { name: "ページを選ぶ" }).click();
    await page.getByTestId("word-image-range").fill("99");
    await page.getByTestId("word-image-range-apply").click();
    await expect(page.getByTestId("word-image-error")).toBeVisible();
    await page.getByTestId("word-image-range").fill("2");
    await page.getByTestId("word-image-range-apply").click();
    await page.getByTestId("word-image-format").getByRole("radio", { name: /JPEG/ }).click();
    await page.getByTestId("word-image-dpi").getByRole("radio", { name: "96dpi" }).click();
    await expect(page.getByTestId("word-image-run")).toContainText("1ページを画像にする");
    await page.getByTestId("word-image-run").click();
    await expect(page.getByTestId("word-image-result")).toContainText("1枚", { timeout: 60_000 });
    await expect(page.getByTestId("word-image-result")).toContainText(/79\d×112\dpx/);
    const { out, suggested } = await save(page, /^ダウンロード$/, "p2.jpg");
    expect(suggested).toMatch(/^merge-a-0?2\.jpg$/);
    const head = fs.readFileSync(out).subarray(0, 3);
    expect([head[0], head[1], head[2]]).toEqual([0xff, 0xd8, 0xff]);
  });

  test("異常系：壊れたWordはエラーを出す", async ({ page }) => {
    await open(page, "word-to-image");
    await uploadFixture(page, fx("broken.docx"));
    await expect(page.getByTestId("word-image-error")).toBeVisible({ timeout: 60_000 });
  });
});

// ---------------------------------------------------------------------------
test.describe("Excelシート分割・結合", () => {
  test("分割：選んだシートを1シートずつのブックにし、書式・結合・列の幅・行の高さ・非表示を保つ。ほかのシートを参照する数式は値になる", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "excel-sheet-split-merge");
    await expect(page.getByTestId("excel-sheets-mode-split")).toHaveAttribute("aria-pressed", "true");
    await uploadFixture(page, fx("book-a.xlsx"));
    const boxes = page.getByTestId("excel-split-sheet");
    await expect(boxes).toHaveCount(4);
    await expect(page.getByTestId("excel-split-sheets")).toContainText("非表示");
    // 「売上」と「非表示」だけにする
    await page.getByTestId("excel-split-toggle-all").click();
    await boxes.nth(0).check();
    await boxes.nth(2).check();
    await page.getByTestId("excel-split-run").click();
    await expect(page.getByTestId("excel-split-result")).toContainText("2ファイル", { timeout: 60_000 });
    await expect(page.getByTestId("excel-sheets-notices")).toContainText("計算結果の値");
    const { out, suggested } = await save(page, /ZIPをダウンロード/, "split.zip");
    expect(suggested).toBe("book-a_シート分割.zip");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-"));
    execFileSync("python3", ["-c", "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", out, dir]);
    expect(fs.readdirSync(dir).sort()).toEqual(["売上.xlsx", "非表示.xlsx"]);
    const sales = path.join(dir, "売上.xlsx");
    const r = py(
      `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1]); ws=wb.active
wv=openpyxl.load_workbook(sys.argv[1],data_only=True).active
print(json.dumps({"sheets":wb.sheetnames,"a1":ws["A1"].value,"bold":ws["A1"].font.b,"size":ws["A1"].font.sz,"color":ws["A1"].font.color.rgb,
 "merged":[str(m) for m in ws.merged_cells.ranges],"wA":ws.column_dimensions["A"].width,"hidD":ws.column_dimensions["D"].hidden,
 "h2":ws.row_dimensions[2].height,"hid6":ws.row_dimensions[6].hidden,"fill":ws["A2"].fill.fgColor.rgb,"border":ws["A3"].border.left.style,
 "b5":ws["B5"].value,"c5":ws["C5"].value,"c3":ws["C3"].value,"c3v":wv["C3"].value,"fmt":ws["B3"].number_format}))`,
      sales
    );
    expect(r.sheets).toEqual(["売上"]);
    expect(r.a1).toBe("売上表");
    expect(r.bold).toBe(true);
    expect(r.size).toBe(16);
    expect(String(r.color)).toMatch(/C00000$/);
    expect(r.merged).toEqual(["A1:C1"]);
    expect(Math.round(Number(r.wA))).toBe(25);
    expect(r.hidD).toBe(true);
    expect(r.h2).toBe(30);
    expect(r.hid6).toBe(true);
    expect(String(r.fill)).toMatch(/FFFF00$/);
    expect(r.border).toBe("thin");
    expect(String(r.fmt)).toMatch(/^#,##0.*円/);
    // 同じシートの中の数式は残る
    expect(r.b5).toBe("=SUM(B3:B4)");
    // ほかのシート（設定）を参照する数式・なくなる名前を使う数式は、保存されていた値になる
    expect(r.c5).toBe(10);
    expect(r.c3).toBe(110);
    // 非表示だったシートは、1つだけのブックでは表示になる
    const h = py(`import json,sys,openpyxl; wb=openpyxl.load_workbook(sys.argv[1]); print(json.dumps({"s":wb.sheetnames,"st":wb.active.sheet_state,"a1":wb.active["A1"].value}))`, path.join(dir, "非表示.xlsx"));
    expect(h).toEqual({ s: ["非表示"], st: "visible", a1: "secret" });
    opensInLibreOffice(sales);
  });

  test("結合：シートを順に並べ、同じ名前は番号付きに変え、参照する数式・テーブル名も直す。書式・画像・非表示を保つ", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "excel-sheet-split-merge");
    await page.getByTestId("excel-sheets-mode-merge").click();
    await uploadFixture(page, [fx("book-a.xlsx"), fx("book-b-openpyxl.xlsx")]);
    await expect(page.getByTestId("excel-merge-preview")).toContainText("売上 (2)");
    await page.getByTestId("excel-merge-run").click();
    await expect(page.getByTestId("excel-merge-result")).toContainText("7シート", { timeout: 60_000 });
    const { out, suggested } = await save(page, /ダウンロード/, "merged.xlsx");
    expect(suggested).toBe("book-a_シート結合.xlsx");
    const r = py(
      `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1])
b=wb["売上 (2)"]; s=wb["集計"]; a=wb["売上"]
tables={ws.title:list(ws.tables.keys()) for ws in wb}
print(json.dumps({"sheets":wb.sheetnames,"states":[ws.sheet_state for ws in wb],
 "b_a1":b["A1"].value,"b_italic":b["A1"].font.i,"b_font":b["A1"].font.name,"b_color":b["A1"].font.color.rgb,"b_fill":b["A1"].fill.fgColor.rgb,
 "b_fmt":b["A2"].number_format,"b_align":b["A2"].alignment.horizontal,"b_wB":b.column_dimensions["B"].width,"b_imgs":len(b._images),
 "s_a1":s["A1"].value,"s_a2":s["A2"].value,"a_a1_bold":a["A1"].font.b,"a_c3":a["C3"].value,"names":list(wb.defined_names.keys()),"tables":tables}))`,
      out
    );
    expect(r.sheets).toEqual(["売上", "設定", "非表示", "表", "売上 (2)", "集計", "表 (2)"]);
    expect(r.states).toEqual(["visible", "visible", "hidden", "visible", "visible", "visible", "visible"]);
    expect(r.b_a1).toBe("B社売上");
    expect(r.b_italic).toBe(true);
    expect(r.b_font).toBe("Meiryo");
    expect(String(r.b_color)).toMatch(/0070C0$/);
    expect(String(r.b_fill)).toMatch(/DDEBF7$/);
    expect(r.b_fmt).toBe('0.00"kg"');
    expect(r.b_align).toBe("center");
    expect(Math.round(Number(r.b_wB))).toBe(40);
    expect(r.b_imgs).toBe(1);
    // 名前を変えたシート・テーブルを参照する数式は、新しい名前に合わせる
    expect(r.s_a1).toBe("='売上 (2)'!A2*2");
    expect(r.s_a2).toBe("=SUM(Table1_2[点])");
    expect((r.tables as Record<string, string[]>)["表 (2)"]).toEqual(["Table1_2"]);
    // 1つ目のブックはそのまま
    expect(r.a_a1_bold).toBe(true);
    expect(r.a_c3).toBe("=B3*(1+税率)");
    expect(r.names).toContain("税率");
    opensInLibreOffice(out);
    // LibreOffice で計算し直しても、名前を変えたシートへの参照が正しく計算される
    if (sofficeOk) {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-recalc-"));
      execFileSync("soffice", ["--headless", "--convert-to", "xlsx", "--outdir", outDir, out], { stdio: "ignore", timeout: 120_000 });
      const v = py(`import json,sys,openpyxl; wb=openpyxl.load_workbook(sys.argv[1],data_only=True); print(json.dumps({"a1":wb["集計"]["A1"].value,"a2":wb["集計"]["A2"].value,"c3":wb["売上"]["C3"].value}))`, path.join(outDir, "merged.xlsx"));
      expect(v.a1).toBe(2469);
      expect(v.a2).toBe(12);
      expect(Math.round(Number(v.c3))).toBe(110);
    }
  });

  test("結合：LibreOffice で保存したブック（書式の作りが違う）同士も結合でき、開ける", async ({ page }) => {
    test.skip(!pythonOk, "python が無い環境");
    await open(page, "excel-sheet-split-merge");
    await page.getByTestId("excel-sheets-mode-merge").click();
    await uploadFixture(page, [fx("book-b.xlsx"), fx("book-a.xlsx")]);
    await page.getByTestId("excel-merge-run").click();
    await expect(page.getByTestId("excel-merge-result")).toContainText("7シート", { timeout: 60_000 });
    const { out } = await save(page, /ダウンロード/, "merged-lo.xlsx");
    const r = py(
      `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1]); a=wb["売上 (2)"]
print(json.dumps({"s":wb.sheetnames,"a1":a["A1"].value,"bold":a["A1"].font.b,"color":a["A1"].font.color.rgb,"merged":[str(m) for m in a.merged_cells.ranges],"c5":a["C5"].value,"b_a1":wb["売上"]["A1"].font.i}))`,
      out
    );
    expect(r.s).toEqual(["売上", "集計", "表", "売上 (2)", "設定", "非表示", "表 (2)"]);
    expect(r.a1).toBe("売上表");
    expect(r.bold).toBe(true);
    expect(String(r.color)).toMatch(/C00000$/);
    expect(r.merged).toEqual(["A1:C1"]);
    expect(r.c5).toBe("=設定!B1*100");
    expect(r.b_a1).toBe(true);
    opensInLibreOffice(out);
  });

  test("異常系：.xlsx 以外・1ファイルだけでは実行できない", async ({ page }) => {
    await open(page, "excel-sheet-split-merge");
    await uploadFixture(page, fx("wareki.csv"));
    await expect(page.getByTestId("excel-sheets-error")).toContainText("対応していません");
    await page.getByTestId("excel-sheets-mode-merge").click();
    await uploadFixture(page, [fx("book-a.xlsx")]);
    await expect(page.getByText("もう1つ以上Excelのファイルを追加してください")).toBeVisible();
    await expect(page.getByTestId("excel-merge-run")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
test.describe("スマホの幅", () => {
  test.use({ viewport: { width: 375, height: 800 } });
  for (const id of ["wareki-convert", "word-merge", "word-to-image", "excel-sheet-split-merge"]) {
    test(`${id}：横スクロールが出ない`, async ({ page }) => {
      await open(page, id);
      if (id === "wareki-convert") await page.getByTestId("wareki-text").fill("2026/11/17\n令和元年5月1日\nH31.5.1");
      if (id === "excel-sheet-split-merge") {
        await uploadFixture(page, fx("book-a.xlsx"));
        await expect(page.getByTestId("excel-split-sheet").first()).toBeVisible();
      }
      if (id === "word-merge") {
        await uploadFixture(page, [fx("merge-a.docx"), fx("merge-b.docx")]);
        await expect(page.getByTestId("word-merge-run")).toBeVisible();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});
