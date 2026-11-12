import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getListedTools, getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { TOOL_HANDOFF } from "@/lib/handoff/config";
import { adjustFormula, remapRange, remapSqref, mapRuns } from "@/lib/excel/xlsx-column-edit";
import { mmToTwips } from "@/lib/word/columns";
import { uploadFixture, clickAndDownload, closeResultPopup, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";

/**
 * 工程3（既存機能の統合・拡張）のテスト。
 *  3-1 PDF修正（ページ番号・透かし）とPDF編集（ページの構成）の役割分担・旧URL
 *  3-2 画像色調補正（グレースケール＋明るさ・コントラスト）
 *  3-3 画像リサイズ・圧縮（それぞれ単独・同時）
 *  3-4 画像トリミング（SNSサイズ・自由トリミング・証明写真）
 *  3-5 CSV・Excel列編集（Excelのシート・行・列）
 *  3-6 Word段落整理・段組み（1・2・3段、文書全体・選んだ範囲、段の間隔、段区切り）
 */

const MERGED = [
  { id: "pdf-add-page-numbers", to: "/tools/pdf-fix?mode=page-numbers", hub: "pdf-fix" },
  { id: "pdf-watermark", to: "/tools/pdf-fix?mode=watermark", hub: "pdf-fix" },
  // PDF黒塗り・墨消しは、PDF修正の「墨消し」に統合
  { id: "pdf-redact", to: "/tools/pdf-fix?mode=redact", hub: "pdf-fix" },
  { id: "image-grayscale", to: "/tools/image-adjust?mode=grayscale", hub: "image-adjust" },
  { id: "image-resize", to: "/tools/image-compress?mode=resize", hub: "image-compress" },
  { id: "image-sns-size", to: "/tools/image-crop?mode=sns", hub: "image-crop" },
  { id: "image-passport-photo", to: "/tools/image-crop?mode=passport", hub: "image-crop" },
];

function py(script: string, args: string[] = []): string {
  return execFileSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** ダウンロードしたPNG・JPGの画素（RGBA）と大きさを ffmpeg / ffprobe で読む */
function imageInfo(file: string): { width: number; height: number; codec: string } {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name", "-of", "json", file], { encoding: "utf8" });
  const s = JSON.parse(out).streams[0];
  return { width: s.width, height: s.height, codec: s.codec_name };
}
function pixels(file: string): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// 1. 登録・SEO・検索・受け渡し（ブラウザ不要）
// ---------------------------------------------------------------------------
plainTest("統合した旧ツールは、一覧・登録・SEO・受け渡し・関連ツールに残っていない。統合先は使える", () => {
  for (const m of MERGED) {
    plainExpect(getToolById(m.id), m.id).toBeUndefined();
    plainExpect(getListedTools().some((t) => t.id === m.id), m.id).toBe(false);
    plainExpect((toolSeoContent as Record<string, unknown>)[m.id], m.id).toBeUndefined();
    plainExpect((TOOL_HANDOFF as Record<string, unknown>)[m.id], m.id).toBeUndefined();
    plainExpect(tools.some((t) => (t.relatedToolIds ?? []).includes(m.id)), m.id).toBe(false);
    plainExpect(getToolById(m.hub)?.status, m.hub).toBe("available");
  }
  plainExpect(getToolById("image-adjust")?.name).toBe("画像色調補正（明るさ・コントラスト・白黒）");
  plainExpect(getToolById("image-compress")?.name).toBe("画像リサイズ・圧縮");
  plainExpect(getToolById("image-crop")?.name).toBe("画像トリミング（SNSサイズ・証明写真）");
  plainExpect(getToolById("csv-column-editor")?.name).toBe("CSV・Excel行列編集");
  plainExpect(getToolById("word-paragraph-cleanup")?.name).toBe("Word段落整理・段組み");
  // 旧ツールの名前で探すと、統合先が出る
  const top = (q: string) => searchTools(getListedTools(), q)[0]?.id;
  plainExpect(top("PDFページ番号追加")).toBe("pdf-fix");
  plainExpect(top("PDF透かし")).toBe("pdf-fix");
  plainExpect(top("PDF黒塗り")).toBe("pdf-fix");
  plainExpect(top("墨消し")).toBe("pdf-fix");
  plainExpect(top("画像リサイズ")).toBe("image-compress");
  plainExpect(top("SNSサイズ変換")).toBe("image-crop");
  plainExpect(top("証明写真")).toBe("image-crop");
  plainExpect(top("グレースケール")).toBe("image-adjust");
  plainExpect(searchTools(getListedTools(), "Excel列編集").some((t) => t.id === "csv-column-editor")).toBe(true);
  plainExpect(searchTools(getListedTools(), "段組み").some((t) => t.id === "word-paragraph-cleanup")).toBe(true);
  // 受け渡し：グレースケールの受け取りは統合先（複数枚対応）へ、列編集はExcelも
  plainExpect(TOOL_HANDOFF["image-adjust"]?.receive?.maxFiles).toBeGreaterThan(1);
  plainExpect(TOOL_HANDOFF["csv-column-editor"]?.receive?.kinds).toEqual(["csv", "xlsx"]);
});

plainTest("Excelの範囲の付け替え：削除・並び替えで、範囲が新しい位置の連続した区間に分かれる", () => {
  // 元のB・C・D列のうちCを削除し、D→B、B→C の順にした場合
  const colOf = new Map([
    [2, 3],
    [4, 2],
    [1, 1],
  ]);
  const maps = { row: (r: number) => r, col: (c: number) => colOf.get(c) ?? null };
  plainExpect(mapRuns(1, 4, maps.col)).toEqual([[1, 3]]);
  plainExpect(remapRange("B2:D5", maps)).toEqual(["B2:C5"]);
  plainExpect(remapRange("C1", maps)).toEqual([]);
  plainExpect(remapSqref("A1:A3 C2 D4", maps)).toEqual("A1:A3 B4");
  // 行の範囲（3〜5行目だけを残す）
  const rows = { row: (r: number) => (r >= 3 && r <= 5 ? r - 2 : null), col: (c: number) => c };
  plainExpect(remapRange("A1:B4", rows)).toEqual(["A1:B2"]);
  plainExpect(mmToTwips(12.7)).toBe(720);
});

plainTest("数式の参照の書き直し：ずれるだけの参照は合わせて残し、安全に合わせられない数式は ok: false（値に置き換える）", () => {
  // 列：A を削除し、B→A、C→B、D→C（行はそのまま）
  const colMap = (c: number) => (c === 1 ? null : c - 1);
  const ctx = { maps: { row: (r: number) => r, col: colMap }, sheetName: "名簿", localIsEdited: true };
  plainExpect(adjustFormula("D2*12", ctx)).toEqual({ ok: true, text: "C2*12" });
  plainExpect(adjustFormula("SUM($B$2:D10)+B$1", ctx)).toEqual({ ok: true, text: "SUM($A$2:C10)+A$1" });
  // 文字列の中・ほかのシートへの参照は変えない。このシートへの参照（シート名付き）は合わせる
  plainExpect(adjustFormula('"D2"&集計!D2&名簿!D2', ctx)).toEqual({ ok: true, text: '"D2"&集計!D2&名簿!C2' });
  plainExpect(adjustFormula("SUM('名簿'!B:D)", ctx)).toEqual({ ok: true, text: "SUM('名簿'!A:C)" });
  // 削除した列を参照する・範囲の中身が変わる・位置に依存する関数・テーブル参照は、書き直さない
  plainExpect(adjustFormula("A2+1", ctx).ok).toBe(false);
  plainExpect(adjustFormula("SUM(A2:C2)", ctx).ok).toBe(false);
  plainExpect(adjustFormula("INDIRECT(\"B2\")", ctx).ok).toBe(false);
  plainExpect(adjustFormula("ROW()", ctx).ok).toBe(false);
  plainExpect(adjustFormula("SUM(表1[金額])", ctx).ok).toBe(false);
  // 並び替えで範囲の中の順番が変わる（B と C を入れ替え）と、VLOOKUP の列番号などが変わるため書き直さない
  const swap = { maps: { row: (r: number) => r, col: (c: number) => (c === 2 ? 3 : c === 3 ? 2 : c) }, sheetName: "名簿", localIsEdited: true };
  plainExpect(adjustFormula("VLOOKUP(A1,A1:D9,3,FALSE)", swap).ok).toBe(false);
  plainExpect(adjustFormula("B1*2", swap)).toEqual({ ok: true, text: "C1*2" });
  // 共有数式を戻すとき：相対参照だけを1行ずらしてから合わせる
  plainExpect(adjustFormula("D2*$D$1", { ...ctx, shift: { rows: 1, cols: 0 } })).toEqual({ ok: true, text: "C3*$C$1" });
  // ほかのシートの数式では、シート名のない参照はそのシート自身を指すので変えない
  plainExpect(adjustFormula("D2+名簿!D2", { ...ctx, localIsEdited: false })).toEqual({ ok: true, text: "D2+名簿!C2" });
  // 行の範囲（3〜5行目だけを残す）：範囲の外の行への参照は書き直さない
  const rows = { maps: { row: (r: number) => (r >= 3 && r <= 5 ? r - 2 : null), col: (c: number) => c }, sheetName: "名簿", localIsEdited: true };
  plainExpect(adjustFormula("SUM(B3:B5)", rows)).toEqual({ ok: true, text: "SUM(B1:B3)" });
  plainExpect(adjustFormula("B2", rows).ok).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. 旧URLの転送・sitemap
// ---------------------------------------------------------------------------
test.describe("工程3：旧アドレスの転送・sitemap", () => {
  for (const m of MERGED) {
    test(`/tools/${m.id} は ${m.to} へ恒久的に転送される`, async ({ request }) => {
      const res = await request.get(`/tools/${m.id}`, { maxRedirects: 0 });
      expect(res.status()).toBe(308);
      const loc = new URL(res.headers()["location"], "http://x");
      expect(loc.pathname + loc.search).toBe(m.to);
    });
  }

  test("sitemap.xml に統合した旧ツールが無く、統合先は載っている", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    for (const m of MERGED) expect(xml).not.toContain(`/tools/${m.id}<`);
    for (const id of ["pdf-fix", "pdf-edit", "image-adjust", "image-compress", "image-crop", "csv-column-editor", "word-paragraph-cleanup"]) {
      expect(xml).toContain(`/tools/${id}<`);
    }
  });

  test("画像・PDFのカテゴリページ、トップページに、統合した旧ツールへのリンクが無い", async ({ page }) => {
    for (const url of ["/tools/image", "/tools/pdf", "/tools", "/"]) {
      await page.goto(url);
      for (const m of MERGED) await expect(page.locator(`a[href="/tools/${m.id}"]`), `${url}: ${m.id}`).toHaveCount(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 画像
// ---------------------------------------------------------------------------
test.describe("工程3：画像色調補正（グレースケールの統合）", () => {
  test("旧URLから開くとグレースケールが選ばれ、グレースケールだけで書き出すと白黒（R=G=B）になる", async ({ page }) => {
    await page.goto("/tools/image-grayscale");
    await expect(page).toHaveURL(/\/tools\/image-adjust\?mode=grayscale$/);
    await uploadFixture(page, fixtures.jpg);
    await expect(page.getByTestId("adjust-grayscale")).toBeChecked({ timeout: 20_000 });
    await page.getByRole("button", { name: "適用する" }).click();
    await waitForSuccess(page, "調整が完了しました");
    const download = await clickAndDownload(page, "ダウンロード");
    const file = test.info().outputPath("gray.jpg");
    await download.saveAs(file);
    const px = pixels(file);
    let maxDiff = 0;
    for (let i = 0; i < px.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(px[i] - px[i + 1]), Math.abs(px[i + 1] - px[i + 2]));
    // JPEGの圧縮による誤差だけを許す
    expect(maxDiff).toBeLessThanOrEqual(6);
  });

  test("グレースケールと明るさを組み合わせられ、直接開いたときはグレースケールは選ばれていない", async ({ page }) => {
    await page.goto("/tools/image-adjust");
    await uploadFixture(page, fixtures.png);
    await expect(page.getByTestId("adjust-preview")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("adjust-grayscale")).not.toBeChecked();
    await page.getByTestId("adjust-grayscale").check();
    await page.getByLabel("明るさの数値").fill("40");
    await page.getByLabel("明るさの数値").blur();
    await page.getByRole("button", { name: "適用する" }).click();
    await waitForSuccess(page, "調整が完了しました");
    const download = await clickAndDownload(page, "ダウンロード");
    const file = test.info().outputPath("gray-bright.png");
    await download.saveAs(file);
    const px = pixels(file);
    for (let i = 0; i < px.length; i += 4) {
      expect(px[i]).toBe(px[i + 1]);
      expect(px[i + 1]).toBe(px[i + 2]);
    }
  });
});

test.describe("工程3：画像リサイズ・圧縮", () => {
  test("旧URLからはサイズの変更だけで開き、指定した大きさ・元の形式（PNG）で書き出せる", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await expect(page).toHaveURL(/\/tools\/image-compress\?mode=resize$/);
    await uploadFixture(page, fixtures.landscapeJpg);
    await expect(page.getByTestId("image-op-resize")).toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("image-op-compress")).not.toBeChecked();
    await page.getByLabel("幅 (px)").fill("150");
    await expect(page.getByLabel("高さ (px)")).toHaveValue("100");
    await page.getByRole("button", { name: "リサイズする", exact: true }).click();
    await waitForSuccess(page, "完了");
    const file = test.info().outputPath("resized.jpg");
    await (await clickAndDownload(page, "ダウンロード")).saveAs(file);
    const info = imageInfo(file);
    expect([info.width, info.height]).toEqual([150, 100]);
  });

  test("総合改修 27：「サイズを変更」と「容量を圧縮」はどちらか一方だけ。片方を選ぶと、もう片方は自動で外れる", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await uploadFixture(page, fixtures.landscapeJpg);
    await expect(page.getByTestId("image-op-resize")).toBeChecked();
    await expect(page.getByTestId("image-op-compress")).not.toBeChecked();
    await page.getByTestId("image-op-compress").click();
    await expect(page.getByTestId("image-op-compress")).toBeChecked();
    await expect(page.getByTestId("image-op-resize")).not.toBeChecked();
    await expect(page.getByRole("button", { name: "リサイズして圧縮する" })).toHaveCount(0);
    await page.getByTestId("image-op-resize").click();
    await expect(page.getByTestId("image-op-resize")).toBeChecked();
    await expect(page.getByTestId("image-op-compress")).not.toBeChecked();
    // もう一度同じ方を押しても、両方とも外れた状態にはならない
    await page.getByTestId("image-op-resize").click();
    await expect(page.getByTestId("image-op-resize")).toBeChecked();
    await expect(page.getByTestId("image-ops").getByRole("radio", { checked: true })).toHaveCount(1);
  });

  test("圧縮だけのときは元の大きさのまま", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await uploadFixture(page, fixtures.landscapeJpg);
    await page.getByTestId("image-op-compress").click();
    await page.getByRole("button", { name: "圧縮する" }).click();
    await waitForSuccess(page, "完了");
    const file = test.info().outputPath("compressed.jpg");
    await (await clickAndDownload(page, "ダウンロード")).saveAs(file);
    const info = imageInfo(file);
    expect([info.width, info.height]).toEqual([300, 200]);
  });
});

test.describe("工程3：画像トリミング（SNSサイズ・自由トリミング・証明写真）", () => {
  test("目的のボタンで切り替えられ、目的ごとに必要な設定だけが出る（プリセットは以前のまま）", async ({ page }) => {
    await page.goto("/tools/image-crop");
    await expect(page.getByTestId("image-trim-mode-crop")).toHaveAttribute("aria-pressed", "true");
    await uploadFixture(page, fixtures.png);
    for (const label of ["自由", "1:1", "4:3", "16:9"]) await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    await expect(async () => {
      await page.getByTestId("image-trim-mode-sns").click();
      await expect(page.getByTestId("image-trim-mode-sns")).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await uploadFixture(page, fixtures.landscapeJpg);
    for (const label of ["正方形 1:1", "縦長 4:5", "横長 16:9", "ストーリー 9:16"]) await expect(page.getByText(label).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "16:9", exact: true })).toHaveCount(0);
    // 切り替えると、前の目的で選んだ画像はリセットされる
    await page.getByTestId("image-trim-mode-passport").click();
    await expect(page.getByText("landscape.jpg")).toHaveCount(0);
    await uploadFixture(page, fixtures.landscapeJpg);
    for (const label of ["30×40mm", "35×45mm", "40×50mm"]) await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  });

  test("旧URLは、それぞれの目的を選んだ状態で開く", async ({ page }) => {
    await page.goto("/tools/image-sns-size");
    await expect(page.getByTestId("image-trim-mode-sns")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await page.goto("/tools/image-passport-photo");
    await expect(page.getByTestId("image-trim-mode-passport")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect(page.locator("h1")).toHaveText("画像トリミング（SNSサイズ・証明写真）");
  });
});

// ---------------------------------------------------------------------------
// 4. CSV・Excel列編集
// ---------------------------------------------------------------------------
const MAKE_XLSX = `
import sys, datetime
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "名簿"
ws.append(["番号", "氏名", "入社日", "給与", "合計"])
ws.append([1, "山田", datetime.date(2024, 4, 1), 300000, "=D2*12"])
ws.append([2, "佐藤", datetime.date(2023, 10, 15), 280000, "=D3*12"])
ws.append([3, "鈴木", datetime.date(2022, 1, 5), 0, "=A4*2"])
for r in (2, 3, 4):
    ws.cell(r, 3).number_format = "yyyy/mm/dd"
ws.column_dimensions["B"].width = 20
ws.column_dimensions["D"].width = 15
ws.merge_cells("A6:B6")
ws["A6"] = "備考"
other = wb.create_sheet("集計")
other["A1"] = "別シート"
other["B2"] = 12345
other["C3"] = "=SUM(名簿!D2:D4)"
other.column_dimensions["A"].width = 30
wb.save(sys.argv[1])
# E2:E3 を、Excelが下へのコピーで作るのと同じ「共有数式」の形にする（E3 は E2 の数式を1行ずらして使う）
import zipfile, shutil, os
tmp = sys.argv[1] + ".tmp"
with zipfile.ZipFile(sys.argv[1]) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "xl/worksheets/sheet1.xml":
            text = data.decode("utf-8")
            text = text.replace("<f>D2*12</f>", '<f t="shared" ref="E2:E3" si="0">D2*12</f>').replace("<f>D3*12</f>", '<f t="shared" si="0"/>')
            assert 'si="0"/>' in text
            data = text.encode("utf-8")
        zout.writestr(item, data)
shutil.move(tmp, sys.argv[1])
`;

const READ_XLSX = `
import sys, json, datetime
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
out = {"sheets": wb.sheetnames, "data": {}, "merged": {}, "widths": {}, "types": {}}
for ws in wb.worksheets:
    rows = []
    for row in ws.iter_rows():
        rows.append([c.value.isoformat() if isinstance(c.value, (datetime.date, datetime.datetime)) else c.value for c in row])
    out["data"][ws.title] = rows
    out["merged"][ws.title] = [str(m) for m in ws.merged_cells.ranges]
    out["widths"][ws.title] = {k: v.width for k, v in ws.column_dimensions.items() if v.width}
ws = wb.worksheets[0]
out["types"] = [[type(c.value).__name__ for c in row] for row in ws.iter_rows()]
print(json.dumps(out, ensure_ascii=False, default=str))
`;

test.describe("工程3：CSV・Excel行列編集（旧 CSV・Excel列編集）", () => {
  test("Excel：列の削除・並び替え・列名の変更を、選んだシートだけに行い、値の種類・幅・結合・ほかのシートを保つ", async ({ page }) => {
    const src = test.info().outputPath("roster.xlsx");
    py(MAKE_XLSX, [src]);
    await page.goto("/tools/csv-column-editor");
    await uploadFixture(page, src);
    await expect(page.getByTestId("column-editor-kind")).toContainText("Excelファイル", { timeout: 20_000 });
    await expect(page.getByLabel("編集するシート")).toBeVisible();
    await expect(page.getByTestId("column-editor-formula-note")).toContainText("数式が3個");
    // 番号を外し、入社日を上へ（氏名・入社日→入社日・氏名）、給与を「月給」に
    await page.getByLabel("番号を含める").uncheck();
    await page.getByLabel("入社日を上へ移動").click();
    await page.getByRole("textbox").nth(3).fill("月給");
    await page.getByRole("button", { name: "この内容で保存する" }).click();
    await waitForSuccess(page, "Excelの生成が完了しました");
    // 数式の扱い：参照を合わせて残した数と、削除した列（番号）を参照していたため値にした数を、はっきり表示する
    const formulas = page.getByTestId("column-editor-formulas");
    await expect(formulas).toContainText("このシートの数式2個は、数式のまま残しました");
    await expect(formulas).toContainText("このシートの数式1個は、参照先を安全に合わせられないため、計算結果の値に置き換えました");
    await expect(formulas).toContainText("数式が残っていません");
    // テスト用のファイル（openpyxlで作成）には数式の計算結果が保存されていないため、その旨も知らせる
    await expect(formulas).toContainText("1個は、計算結果がファイルに保存されていなかったため空欄");
    await expect(formulas).toContainText("ほかのシートの数式1個の、このシートへの参照を、新しい位置に合わせました");
    await expect(formulas).toHaveAttribute("data-converted", "1");
    const out = test.info().outputPath("roster-edited.xlsx");
    await (await clickAndDownload(page, "Excelでダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ_XLSX, [out]));
    expect(r.sheets).toEqual(["名簿", "集計"]);
    // 列：番号を削除 → 入社日・氏名・月給（給与）・合計
    expect(r.data["名簿"][0]).toEqual(["入社日", "氏名", "月給", "合計"]);
    // 数式は、参照を新しい位置に合わせて残る（給与は D列→C列。共有数式だった E3 も、1つずつの数式に戻して合わせる）
    expect(r.data["名簿"][1]).toEqual(["2024-04-01T00:00:00", "山田", 300000, "=C2*12"]);
    expect(r.data["名簿"][2][3]).toBe("=C3*12");
    // 削除した列（番号）を参照していた数式は、計算結果の値（保存されていないため空欄）に置き換わる
    expect(r.data["名簿"][3][3]).toBeNull();
    // 日付は日付、数値は数値のまま（文字にしない）
    expect(r.types[1]).toEqual(["datetime", "str", "int", "str"]);
    // 元のA6:B6の結合は、Aを削除したため1つの範囲にならず外れる（Bだけになる）
    expect(r.merged["名簿"]).toEqual([]);
    // 列の幅は、列と一緒に移る（氏名の幅20は、新しいB列へ。給与の幅15は、新しいC列へ）
    expect(r.widths["名簿"]["B"]).toBe(20);
    expect(r.widths["名簿"]["C"]).toBe(15);
    // ほかのシートの値・幅は変わらない。このシートを参照する数式は、新しい位置（給与＝C列）に合わせて残る
    expect(r.data["集計"][0][0]).toBe("別シート");
    expect(r.data["集計"][1][1]).toBe(12345);
    expect(r.data["集計"][2][2]).toBe("=SUM(名簿!C2:C4)");
    expect(r.widths["集計"]["A"]).toBe(30);
  });

  test("Excel：行の範囲（2〜3行目）を指定すると、範囲の行だけが出力され、見出しなしでも列記号で選べる。列名の変更だけなら数式は残る", async ({ page }) => {
    const src = test.info().outputPath("roster2.xlsx");
    py(MAKE_XLSX, [src]);
    await page.goto("/tools/csv-column-editor");
    await uploadFixture(page, src);
    await expect(page.getByTestId("column-editor-kind")).toContainText("Excelファイル", { timeout: 20_000 });
    // 列名の変更だけ → 数式はそのまま
    await page.getByRole("textbox").nth(1).fill("名前");
    await page.getByRole("button", { name: "この内容で保存する" }).click();
    await waitForSuccess(page, "Excelの生成が完了しました");
    let out = test.info().outputPath("rename-only.xlsx");
    await (await clickAndDownload(page, "Excelでダウンロード")).saveAs(out);
    let r = JSON.parse(py(READ_XLSX, [out]));
    expect(r.data["名簿"][0][1]).toBe("名前");
    expect(r.data["名簿"][1][4]).toBe("=D2*12");
    expect(r.merged["名簿"]).toEqual(["A6:B6"]);
    // 行の範囲
    await closeResultPopup(page);
    await openAdvanced(page, "column-editor-read-settings");
    await page.getByLabel("対象にする行の開始行").fill("2");
    await page.getByLabel("対象にする行の終了行").fill("3");
    await page.getByText("対象の範囲の1行目を見出し（列名）として扱う").click();
    await expect(page.getByLabel("A列を含める")).toBeVisible();
    await page.getByRole("button", { name: "この内容で保存する" }).click();
    await waitForSuccess(page, "Excelの生成が完了しました");
    out = test.info().outputPath("rows.xlsx");
    await (await clickAndDownload(page, "Excelでダウンロード")).saveAs(out);
    r = JSON.parse(py(READ_XLSX, [out]));
    expect(r.data["名簿"].length).toBe(2);
    expect(r.data["名簿"][0][1]).toBe("山田");
    expect(r.data["名簿"][1][1]).toBe("佐藤");
  });

  test("CSV：これまでどおりCSVで書き出せ、行の範囲と「すべての列を外す／選ぶ」も使える", async ({ page }) => {
    await page.goto("/tools/csv-column-editor");
    await uploadFixture(page, fixtures.csv);
    await expect(page.getByTestId("column-editor-kind")).toContainText("CSVファイル", { timeout: 20_000 });
    await page.getByRole("button", { name: "すべての列を外す" }).click();
    await expect(page.getByRole("button", { name: "この内容で保存する" })).toBeDisabled();
    await page.getByRole("button", { name: "すべての列を選ぶ" }).click();
    await openAdvanced(page, "column-editor-read-settings");
    await page.getByLabel("対象にする行の終了行").fill("2");
    await page.getByRole("button", { name: "この内容で保存する" }).click();
    await waitForSuccess(page, "CSVの生成が完了しました");
    const out = test.info().outputPath("edited.csv");
    await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
    const lines = fs.readFileSync(out, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines.length).toBe(2);
  });

  test("古い形式（.xls）は、理由を表示して読み込まない", async ({ page }) => {
    const xls = test.info().outputPath("old.xls");
    fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await page.goto("/tools/csv-column-editor");
    await page.locator('input[type="file"]').first().setInputFiles(xls);
    // ツール本体のエラー表示（同じ言葉が、閉じている「よくある質問」の幕にもあるため、ツールの枠の中に絞る）
    await expect(page.locator(".ms-tool-panel").getByText(/このファイル形式には対応していません|古い形式（\.xls）/).first()).toBeVisible({ timeout: 20_000 });
  });
});

// ---------------------------------------------------------------------------
// 5. Word段組み
// ---------------------------------------------------------------------------
const MAKE_DOCX = `
import sys
from docx import Document
from docx.shared import Pt
doc = Document()
section = doc.sections[0]
section.header.paragraphs[0].text = "ヘッダーの文字"
for i in range(1, 13):
    doc.add_paragraph(f"段落{i}：" + "これは段組みの確認のための本文です。" * 6)
table = doc.add_table(rows=1, cols=2)
table.cell(0, 0).text = "表の中"
doc.add_paragraph("最後の段落")
doc.save(sys.argv[1])
`;

const READ_DOCX = `
import sys, json, zipfile, re
z = zipfile.ZipFile(sys.argv[1])
xml = z.read("word/document.xml").decode("utf-8")
from docx import Document
d = Document(sys.argv[1])
sects = re.findall(r"<w:sectPr\\b.*?</w:sectPr>", xml, re.S)
info = []
for s in sects:
    cols = re.search(r"<w:cols\\b[^>]*/?>", s)
    typ = re.search(r'<w:type w:val="([a-zA-Z]+)"', s)
    info.append({"cols": cols.group(0) if cols else None, "type": typ.group(1) if typ else None, "header": "headerReference" in s})
paras = [p.text for p in d.paragraphs]
print(json.dumps({"sections": info, "paragraphs": paras, "breaks": xml.count('w:type="column"'), "tables": len(d.tables), "headerText": d.sections[0].header.paragraphs[0].text, "names": z.namelist()}, ensure_ascii=False))
`;
import { openAdvanced } from "../helpers/advanced-settings";

test.describe("工程3：Word段落整理・段組み", () => {
  test("文書全体を2段組み（間隔10mm）にでき、本文・表・ヘッダーは変わらない", async ({ page }) => {
    const src = test.info().outputPath("doc.docx");
    py(MAKE_DOCX, [src]);
    await page.goto("/tools/word-paragraph-cleanup");
    await uploadFixture(page, src);
    // 整理はしない（段組みだけ）
    for (const name of ["連続するスペースを1つにまとめる", "連続する空白行を1行にまとめる"]) await page.getByRole("checkbox", { name }).uncheck();
    await page.getByTestId("word-columns-enable").check();
    await page.getByLabel("段の間隔（mm）").fill("10");
    await page.getByRole("button", { name: "段組みを変更する" }).click();
    await waitForSuccess(page, "段組みの変更が完了しました");
    const out = test.info().outputPath("doc-2col.docx");
    await (await clickAndDownload(page, "Wordファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ_DOCX, [out]));
    const before = JSON.parse(py(READ_DOCX, [src]));
    expect(r.sections.length).toBe(1);
    expect(r.sections[0].cols).toContain('w:num="2"');
    expect(r.sections[0].cols).toContain('w:space="567"');
    expect(r.sections[0].header).toBe(true);
    expect(r.paragraphs).toEqual(before.paragraphs);
    expect(r.tables).toBe(1);
    expect(r.headerText).toBe("ヘッダーの文字");
    expect(r.names.sort()).toEqual(before.names.sort());
  });

  test("選んだ範囲（3〜8段落目）だけを3段組みにし、段区切りを入れると、範囲の前後に「現在の位置から」のセクション区切りが入る（LibreOfficeで開いて段に分かれることも確認）", async ({ page }) => {
    const src = test.info().outputPath("doc2.docx");
    py(MAKE_DOCX, [src]);
    await page.goto("/tools/word-paragraph-cleanup");
    await uploadFixture(page, src);
    for (const name of ["連続するスペースを1つにまとめる", "連続する空白行を1行にまとめる"]) await page.getByRole("checkbox", { name }).uncheck();
    await page.getByTestId("word-columns-enable").check();
    await page.getByTestId("word-columns-count-3").click();
    await page.getByTestId("word-columns-scope-range").click();
    await page.getByLabel("段組みにする範囲の最初の段落").fill("3");
    await page.getByLabel("段組みにする範囲の最後の段落").fill("8");
    await page.getByLabel("段区切りを入れる段落の番号").fill("6");
    await expect(page.locator('[data-testid="word-paragraph-numbers"] li[data-in-range]')).toHaveCount(6);
    // 範囲の外の段区切りは、理由を表示して実行できない
    await page.getByLabel("段区切りを入れる段落の番号").fill("10");
    await expect(page.getByTestId("word-columns-error")).toContainText("範囲（3〜8段落）の中");
    await expect(page.getByRole("button", { name: "段組みを変更する" })).toBeDisabled();
    await page.getByLabel("段区切りを入れる段落の番号").fill("6");
    await page.getByRole("button", { name: "段組みを変更する" }).click();
    await waitForSuccess(page, "段組みの変更が完了しました");
    const out = test.info().outputPath("doc-range.docx");
    await (await clickAndDownload(page, "Wordファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ_DOCX, [out]));
    // 範囲の前（1〜2段落目）・範囲（3〜8段落目）・範囲の後ろ（元の最後のセクション）の3つ
    expect(r.sections.length).toBe(3);
    expect(r.sections[0].cols ?? "").not.toContain('w:num="3"');
    expect(r.sections[1].cols).toContain('w:num="3"');
    expect(r.sections[1].type).toBe("continuous");
    expect(r.sections[2].type).toBe("continuous");
    expect(r.sections[2].cols ?? "").not.toContain('w:num="3"');
    expect(r.breaks).toBe(1);
    // LibreOffice で PDF にして、範囲の段落が横に並ぶ（同じ高さに複数の段落がある）ことを確かめる
    const dir = path.dirname(out);
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, out], { timeout: 120_000, stdio: "ignore" });
    const pdf = out.replace(/\.docx$/, ".pdf");
    expect(fs.existsSync(pdf)).toBe(true);
    const bbox = execFileSync("pdftotext", ["-bbox", "-f", "1", "-l", "2", pdf, "-"], { encoding: "utf8" });
    // 「段落」と番号は別の語として出るため、番号の語（「3：…」）の位置で見る
    const words = [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)"[^>]*>(\d+)：/g)].map((m) => ({ xMin: Number(m[1]), xMax: Number(m[2]), n: Number(m[3]) }));
    const inRange = words.filter((w) => w.n >= 3 && w.n <= 8);
    const outside = words.filter((w) => w.n <= 2 || w.n >= 9);
    expect(inRange.length).toBe(6);
    // 範囲の段落は、複数の段（左右の違う位置）に分かれ、どれも本文の幅より狭い
    expect(new Set(inRange.map((w) => Math.round(w.xMin / 50))).size).toBeGreaterThan(1);
    for (const w of inRange) expect(w.xMax - w.xMin, `段落${w.n}`).toBeLessThan(200);
    // 範囲の外の段落は、これまでどおり本文の幅いっぱい
    for (const w of outside) expect(w.xMax - w.xMin, `段落${w.n}`).toBeGreaterThan(300);
  });
});
