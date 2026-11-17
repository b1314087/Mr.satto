import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadWhenReady } from "../helpers/tool-ready";
import { clickAndDownload } from "../helpers/tool-runner";

/**
 * Excel・Word・PowerPoint の「書式・ページ設定を標準に戻す」ツール（2026-11-17）。
 * 書き出したファイルを Python（openpyxl・python-docx・python-pptx）で開き直し、書式とページの設定が標準に戻り、
 * 中身（値・数式・見出し・箇条書き・表・画像など）が残っていることを確かめる。LibreOffice があれば、開けることも確かめる。
 */

const DIR = path.join(__dirname, "../fixtures/office-reset");
const pythonOk = (() => {
  try {
    execFileSync("python3", ["-c", "import openpyxl, docx, pptx"], { stdio: "ignore" });
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

async function runTool(page: Page, toolId: string, fixture: string, opts: { format?: boolean; page?: boolean } = {}) {
  await page.goto(`/tools/${toolId}`);
  await uploadWhenReady(page, path.join(DIR, fixture), page.getByTestId("office-reset-run"));
  if (opts.format === false) await page.getByTestId("office-reset-format").uncheck();
  if (opts.page === false) await page.getByTestId("office-reset-page").uncheck();
  await page.getByTestId("office-reset-run").click();
  await expect(page.getByTestId("office-reset-result")).toBeVisible({ timeout: 30_000 });
  const ext = path.extname(fixture);
  const dl = await clickAndDownload(page, /ダウンロード/);
  expect(dl.suggestedFilename()).toMatch(new RegExp(`_標準\\${ext}$`));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reset-")), `out${ext}`);
  await dl.saveAs(out);
  return out;
}

function py(script: string, file: string): Record<string, unknown> {
  return JSON.parse(execFileSync("python3", ["-c", script, file]).toString());
}

function opensInLibreOffice(file: string) {
  if (!sofficeOk) return;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-"));
  execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outDir, file], { stdio: "ignore", timeout: 120_000 });
  const pdf = fs.readdirSync(outDir).find((f) => f.endsWith(".pdf"));
  expect(pdf, "LibreOffice で開いてPDFにできる").toBeTruthy();
}

test.describe("Office の書式・ページ設定を標準に戻す", () => {
  test.describe.configure({ timeout: 180_000 });
  test.skip(!pythonOk, "openpyxl・python-docx・python-pptx が無い環境");

  test("Excel：書式とページ・印刷の設定が標準に戻り、値・数式・表示形式・結合・条件付き書式は残る", async ({ page }) => {
    const out = await runTool(page, "excel-format-reset", "reset_sample.xlsx");
    await expect(page.getByTestId("office-reset-done").first()).toContainText("游ゴシック 11pt");
    await expect(page.getByTestId("office-reset-kept")).toContainText("数値の表示形式");
    const r = py(
      `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb["売上"]
a1 = ws["A1"]
print(json.dumps({
  "sheets": wb.sheetnames,
  "a1": a1.value, "a1_bold": bool(a1.font.b), "a1_size": a1.font.sz, "a1_name": a1.font.name, "a1_fill": a1.fill.fill_type, "a1_align": a1.alignment.horizontal,
  "a3_border": ws["A3"].border.left.style,
  "b3_fmt": ws["B3"].number_format, "b3_italic": bool(ws["B3"].font.i), "c3_fmt": ws["C3"].number_format,
  "b5": ws["B5"].value, "b5_bold": bool(ws["B5"].font.b),
  "a6": str(ws["A6"].value),
  "merged": [str(m) for m in ws.merged_cells.ranges],
  "colA_present": "A" in ws.column_dimensions, "colD_hidden": bool(ws.column_dimensions["D"].hidden),
  "row3": ws.row_dimensions[3].height,
  "print_area": ws.print_area, "orient": ws.page_setup.orientation, "paper": ws.page_setup.paperSize, "scale": ws.page_setup.scale,
  "m_left": ws.page_margins.left, "m_top": ws.page_margins.top,
  "header": ws.oddHeader.center.text, "zoom": ws.sheet_view.zoomScale, "grid": ws.sheet_view.showGridLines,
  "cf": len(ws.conditional_formatting),
  "memo_size": wb["メモ"]["A1"].font.sz, "memo_value": wb["メモ"]["A1"].value,
}))`,
      out
    );
    // 書式は標準
    expect(r.a1_bold).toBe(false);
    expect(r.a1_size).toBe(11);
    expect(r.a1_name).toBe("游ゴシック");
    expect(r.a1_fill).toBeNull();
    expect(r.a1_align).toBeNull();
    expect(r.a3_border).toBeNull();
    expect(r.b3_italic).toBe(false);
    expect(r.b5_bold).toBe(false);
    expect(r.memo_size).toBe(11);
    // 中身・表示形式は残る
    expect(r.sheets).toEqual(["売上", "メモ"]);
    expect(r.a1).toBe("見積書");
    expect(r.b5).toBe("=SUM(B3:B4)");
    expect(r.b3_fmt).toBe('"¥"#,##0');
    expect(r.c3_fmt).toBe("yyyy/mm/dd");
    expect(r.a6).toBe("通常の文字赤い太字");
    expect(r.merged).toEqual(["A1:C1"]);
    expect(r.cf).toBe(1);
    expect(r.memo_value).toBe("2枚目");
    // ページ・印刷の設定は標準
    // 列Aの幅の指定は外れる（標準の幅）
    expect(r.colA_present).toBe(false);
    expect(r.colD_hidden).toBe(true);
    expect(r.row3).toBeNull();
    expect(r.print_area || null).toBeNull();
    expect(r.orient).toBeNull();
    expect(r.paper).toBeNull();
    expect(r.scale).toBeNull();
    expect(r.m_left).toBe(0.7);
    expect(r.m_top).toBe(0.75);
    expect(r.header).toBeNull();
    expect(r.zoom).toBeNull();
    // 枠線を隠す設定が外れる（未指定＝表示）
    expect(r.grid === null || r.grid === true).toBe(true);
    opensInLibreOffice(out);
  });

  test("Excel：「書式」だけを選ぶと、印刷範囲・列の幅は残る", async ({ page }) => {
    const out = await runTool(page, "excel-format-reset", "reset_sample.xlsx", { page: false });
    const r = py(
      `
import json, sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1])["売上"]
print(json.dumps({"bold": bool(ws["A1"].font.b), "print_area": ws.print_area, "colA": ws.column_dimensions["A"].width, "orient": ws.page_setup.orientation}))`,
      out
    );
    expect(r.bold).toBe(false);
    expect(String(r.print_area)).toContain("A$1:$C$6");
    expect(r.colA).toBe(30);
    expect(r.orient).toBe("landscape");
  });

  test("Word：文字・段落・表の書式とページの設定が標準に戻り、見出し・箇条書き・隠し文字・表・ヘッダーは残る", async ({ page }) => {
    const out = await runTool(page, "word-format-reset", "reset_sample.docx");
    await expect(page.getByTestId("office-reset-done").first()).toContainText("10.5pt");
    const r = py(
      `
import json, sys, docx
d = docx.Document(sys.argv[1])
ps = d.paragraphs
body = ps[1]
run = body.runs[0]
s = d.sections[0]
bullet = ps[2]
hidden = [r for r in ps[3].runs if r.text == "隠し文字"][0]
tc = d.tables[0].cell(0, 0)._tc
print(json.dumps({
  "texts": [p.text for p in ps],
  "h_style": ps[0].style.name,
  "run_size": run.font.size, "run_bold": run.font.bold, "run_color": str(run.font.color.rgb) if run.font.color and run.font.color.type else None, "run_font": run.font.name,
  "align": body.alignment, "indent": body.paragraph_format.left_indent, "space_after": body.paragraph_format.space_after,
  "bullet_style": bullet.style.name, "bullet_num": bullet._p.pPr is not None and bullet._p.pPr.numPr is not None,
  "hidden": hidden.font.hidden,
  "table_style": d.tables[0].style.name if d.tables[0].style is not None else None, "table_text": d.tables[0].cell(0, 0).text,
  "shd": len(tc.xpath("./w:tcPr/w:shd")),
  "w": s.page_width, "h": s.page_height, "orient": int(s.orientation), "left": s.left_margin, "top": s.top_margin,
  "cols": len(s._sectPr.xpath("./w:cols")),
  "header": s.header.paragraphs[0].text, "header_size": s.header.paragraphs[0].runs[0].font.size,
}))`,
      out
    );
    expect(r.texts).toEqual(["報告書のタイトル", "大きな赤い太字の文章", "箇条書きの1つ目", "通常の文章。隠し文字"]);
    expect(r.h_style).toBe("Heading 1");
    expect(r.run_size).toBeNull();
    expect(r.run_bold).toBeNull();
    expect(r.run_color).toBeNull();
    expect(r.run_font).toBeNull();
    expect(r.align).toBeNull();
    expect(r.indent).toBeNull();
    expect(r.space_after).toBeNull();
    // 箇条書きは、標準の「リスト段落」＋番号の設定で残る
    expect(r.bullet_style).toBe("List Paragraph");
    expect(r.bullet_num).toBe(true);
    expect(r.hidden).toBe(true);
    expect(r.table_style).toBe("Table Grid");
    expect(r.table_text).toBe("見出しセル");
    expect(r.shd).toBe(0);
    // A4縦・余白「標準」・1段組み
    expect(r.w).toBe(11906 * 635);
    expect(r.h).toBe(16838 * 635);
    expect(r.orient).toBe(0);
    expect(r.left).toBe(1701 * 635);
    expect(r.top).toBe(1985 * 635);
    expect(r.cols).toBe(0);
    expect(r.header).toBe("ヘッダーの文字");
    expect(r.header_size).toBeNull();
    opensInLibreOffice(out);
  });

  test("Word：日本語版 Word のスタイル（見出し1 の ID が「1」）も、見出しとして残る", async ({ page }) => {
    const out = await runTool(page, "word-format-reset", "reset_sample_ja.docx");
    const r = py(
      `
import json, sys, docx
d = docx.Document(sys.argv[1])
print(json.dumps({"h": d.paragraphs[0].style.name, "id": d.paragraphs[0].style.style_id}))`,
      out
    );
    expect(r.h).toBe("Heading 1");
    expect(r.id).toBe("Heading1");
  });

  test("PowerPoint：書式がレイアウトの標準に戻り、4:3 のスライドが 16:9 になる（図形は比を保って中央へ）", async ({ page }) => {
    const out = await runTool(page, "pptx-format-reset", "reset_sample_43.pptx");
    await expect(page.getByTestId("office-reset-done").last()).toContainText("16:9");
    const r = py(
      `
import json, sys
from pptx import Presentation
p = Presentation(sys.argv[1])
s1, s2 = p.slides[0], p.slides[1]
run = s1.shapes.title.text_frame.paragraphs[0].runs[0]
box = [sh for sh in s2.shapes if sh.has_text_frame and sh.text_frame.text == "四角"][0]
tbl = [sh for sh in s2.shapes if sh.has_table][0]
cell = tbl.table.cell(0, 0)
print(json.dumps({
  "w": p.slide_width, "h": p.slide_height,
  "title": s1.shapes.title.text_frame.text, "size": run.font.size, "bold": run.font.bold,
  "color": run.font.color.type is not None if run.font.color else False,
  "align": s1.shapes.title.text_frame.paragraphs[0].alignment,
  "bg_master": s1.follow_master_background,
  "box_left": box.left, "box_top": box.top, "box_w": box.width, "box_fill": box.fill.type,
  "cell_text": cell.text, "cell_fill": cell.fill.type,
  "tbl_left": tbl.left,
}))`,
      out
    );
    expect(r.w).toBe(12192000);
    expect(r.h).toBe(6858000);
    expect(r.title).toBe("タイトル");
    expect(r.size).toBeNull();
    expect(r.bold).toBeNull();
    expect(r.color).toBe(false);
    expect(r.align).toBeNull();
    expect(r.bg_master).toBe(true);
    // 4:3（9144000×6858000）→ 16:9：縦は同じ大きさ（倍率1）のまま、左右に 1524000 ずつ余白
    expect(r.box_left).toBe(914400 + 1524000);
    expect(r.box_top).toBe(1828800);
    expect(r.box_w).toBe(1828800);
    expect(r.tbl_left).toBe(4572000 + 1524000);
    // テーマの書式を持つ図形の塗りつぶしは、テーマの標準に戻る（直接の指定が無い）
    expect(r.box_fill).toBeNull();
    expect(r.cell_text).toBe("セル");
    expect(r.cell_fill).toBeNull();
    opensInLibreOffice(out);
  });

  test("形式の違うファイル・壊れたファイルは、分かりやすい案内を出す", async ({ page }) => {
    await page.goto("/tools/word-format-reset");
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bad-")), "broken.docx");
    fs.writeFileSync(bad, "これはWordではありません");
    await uploadWhenReady(page, bad, page.getByTestId("office-reset-run"));
    await page.getByTestId("office-reset-run").click();
    await expect(page.getByTestId("office-reset-error")).toContainText("Word文書（.docx）として読み取れませんでした");
    // どちらも外すと、実行できない
    await page.getByTestId("office-reset-format").uncheck();
    await page.getByTestId("office-reset-page").uncheck();
    await expect(page.getByTestId("office-reset-run")).toBeDisabled();
  });
});
