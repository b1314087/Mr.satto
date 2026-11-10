import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { assertDownloadedFile, clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { extractPdfContent } from "../helpers/pdf-inspect";
import { fixtures } from "../fixtures/paths";
import { openSeatPanel } from "../helpers/seating-panel";
import { applyRowOrder } from "@/lib/processors/browser/csv-ops";
import { planShift, rangeLabel, remapRefForShift, shiftedPosition, validateShiftRange } from "@/lib/excel/xlsx-shift-cells";
import { buildBaseLayout, buildLayout, DEFAULT_PARAMS, newDesk, normalizeDesks, supportsDesks, withDesks } from "@/lib/seating/layouts";
import { bothViewsPagePlan, composeHalves, composeViews, usesRedNumbers, type SeatingChartModel } from "@/lib/processors/browser/seating-export";
import { getToolById } from "@/lib/tools/data";
import { toolSeoContent } from "@/lib/seo/tool-content";

/**
 * 新工程1のテスト（1つの作業単位として追加・変更した機能）。
 * - 1 画像リサイズ・圧縮の初期状態
 * - 3 CSV・Excel列編集の「行を編集」
 * - 6 PDF差し込み印刷の説明
 * - 8 Word段落整理・段組みの見つけやすさ
 * - 9 座席表（前後を1ページに：用紙のちょうど半分ずつ／会議の卓・カスタムの机／出席番号の赤）
 * - 10 Excel空白行・空白列削除の「左に詰める」「上に詰める」
 * （2 PDF修正は tests/tools/pdf-fix.spec.ts、4 領収書は tests/tools/receipt-accounting.spec.ts で確かめる）
 */

function py(script: string, args: string[] = []): string {
  return execFileSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ===========================================================================
// 規則（純粋な関数）
// ===========================================================================

plainTest("3：行の削除・並び替え（applyRowOrder）。含めなかった行は削除し、指定が正しくなければ理由つきのエラー", () => {
  plainExpect(applyRowOrder(["h", "a", "b", "c"], [0, 3, 1])).toEqual(["h", "c", "a"]);
  plainExpect(applyRowOrder(["h", "a"], undefined)).toEqual(["h", "a"]);
  plainExpect(() => applyRowOrder(["h", "a"], [])).toThrow("残す行を1つ以上");
  plainExpect(() => applyRowOrder(["h", "a"], [0, 0])).toThrow("行の指定が正しくありません");
  plainExpect(() => applyRowOrder(["h", "a"], [5])).toThrow("行の指定が正しくありません");
});

plainTest("6・8・10：ツール一覧の説明が、実際の機能と合っている（名前・URLは変えない）", () => {
  const merge = getToolById("form-to-individual-pdfs")!;
  plainExpect(merge.name).toBe("PDF差し込み印刷");
  plainExpect(merge.description).toContain("1件ずつのPDF");
  plainExpect(merge.description).toContain("写真");
  const word = getToolById("word-paragraph-cleanup")!;
  plainExpect(word.keywords).toEqual(plainExpect.arrayContaining(["段組", "2列"]));
  const blank = getToolById("excel-blank-remove")!;
  plainExpect(blank.description).toContain("左・上に詰める");
  plainExpect(toolSeoContent["excel-blank-remove"].faq.map((f) => f.question).join("")).toContain("左に詰める");
});

plainTest.describe("10：範囲の中で空白のセルを詰める（planShift・数式の参照）", () => {
  // 値のあるセル：B2・D2・C3・E3・D5
  const filled = new Set(["2,2", "2,4", "3,3", "3,5", "5,4"]);
  const isFilled = (r: number, c: number) => filled.has(`${r},${c}`);
  const range = { r1: 2, r2: 5, c1: 2, c2: 5 };

  plainTest("左に詰める：各行で値のあるセルを左へ（並びは変えない）。範囲の外は動かない。結合がかかる行は詰めない", () => {
    const plan = planShift(isFilled, [{ r1: 4, r2: 4, c1: 3, c2: 4 }], range, "left");
    plainExpect(shiftedPosition(plan, 2, 4)).toEqual({ row: 2, col: 3 }); // D2 → C2
    plainExpect(shiftedPosition(plan, 3, 3)).toEqual({ row: 3, col: 2 }); // C3 → B3
    plainExpect(shiftedPosition(plan, 3, 5)).toEqual({ row: 3, col: 3 }); // E3 → C3
    plainExpect(shiftedPosition(plan, 5, 4)).toEqual({ row: 5, col: 2 }); // D5 → B5
    plainExpect(shiftedPosition(plan, 2, 2)).toEqual({ row: 2, col: 2 }); // B2 はそのまま
    plainExpect(shiftedPosition(plan, 1, 4)).toEqual({ row: 1, col: 4 }); // 範囲の外
    plainExpect(shiftedPosition(plan, 2, 6)).toEqual({ row: 2, col: 6 }); // 範囲の外
    plainExpect(plan.skippedLines).toEqual([4]);
    plainExpect(plan.movedCells).toBe(4);
  });

  plainTest("上に詰める：各列で値のあるセルを上へ", () => {
    const plan = planShift(isFilled, [], range, "up");
    plainExpect(shiftedPosition(plan, 3, 3)).toEqual({ row: 2, col: 3 }); // C3 → C2
    plainExpect(shiftedPosition(plan, 5, 4)).toEqual({ row: 3, col: 4 }); // D5 → D3（D2 の下）
    plainExpect(shiftedPosition(plan, 3, 5)).toEqual({ row: 2, col: 5 }); // E3 → E2
  });

  plainTest("数式の参照：移ったセルへの参照は移った先へ。範囲の中だけで並びが変わる参照はそのまま。一部だけ動く参照は直せない", () => {
    const plan = planShift(isFilled, [], range, "left");
    plainExpect(remapRefForShift(plan, { r1: 2, r2: 2, c1: 4, c2: 4 })).toEqual({ rows: 0, cols: -1 }); // D2 → C2
    plainExpect(remapRefForShift(plan, { r1: 1, r2: 1, c1: 1, c2: 9 })).toEqual({ rows: 0, cols: 0 }); // 範囲にかからない
    plainExpect(remapRefForShift(plan, { r1: 2, r2: 2, c1: 2, c2: 5 })).toEqual({ rows: 0, cols: 0 }); // B2:E2（行の範囲をまるごと）
    plainExpect(remapRefForShift(plan, { r1: 2, r2: 2, c1: 4, c2: 5 })).toBeNull(); // D2:E2（D2 が外へ出る）
    plainExpect(remapRefForShift(plan, { r1: 2, r2: 2, c1: null, c2: null })).toEqual({ rows: 0, cols: 0 }); // 2:2（行全体）
  });

  plainTest("範囲の表記と検証", () => {
    plainExpect(rangeLabel(range)).toBe("B2:E5");
    plainExpect(validateShiftRange(range)).toBeNull();
    plainExpect(validateShiftRange({ r1: 3, r2: 2, c1: 1, c2: 1 })).toContain("以下");
    plainExpect(validateShiftRange({ r1: 0, r2: 2, c1: 1, c2: 1 })).toContain("1以上");
  });
});

plainTest.describe("9：座席表", () => {
  const model = (purpose: "classroom" | "meeting", cols = 6, rows = 2): SeatingChartModel => {
    const geometry = buildLayout(purpose, { ...DEFAULT_PARAMS, cols, rows });
    return { title: "座席表", geometry, assignment: geometry.seats.map(() => null), unseated: [] };
  };

  plainTest("9-1：前後を1ページに：用紙を真ん中でちょうど半分に分け、2つの図はそれぞれの半分の中だけに収まる（重ならない・線をまたがない）", () => {
    for (const m of [model("classroom", 6, 2), model("classroom", 2, 8), model("meeting")]) {
      for (const [W, H] of [[595.28, 841.89], [841.89, 595.28], [362.8, 515.9]]) {
        for (const stacked of [true, false]) {
          const layout = composeHalves(m, W, H, stacked, 20);
          plainExpect(layout.divider).toEqual({ stacked, at: stacked ? H / 2 : W / 2 });
          const [a, b] = layout.views;
          const w = m.geometry.width * a.scale;
          const h = (m.geometry.height + 64 + 30) * a.scale;
          plainExpect(a.scale).toBeCloseTo(b.scale, 9);
          if (stacked) {
            plainExpect(a.dy + h).toBeLessThanOrEqual(H / 2 + 1e-6);
            plainExpect(b.dy).toBeGreaterThanOrEqual(H / 2 - 1e-6);
            plainExpect(b.dy + h).toBeLessThanOrEqual(H + 1e-6);
          } else {
            plainExpect(a.dx + w).toBeLessThanOrEqual(W / 2 + 1e-6);
            plainExpect(b.dx).toBeGreaterThanOrEqual(W / 2 - 1e-6);
            plainExpect(b.dx + w).toBeLessThanOrEqual(W + 1e-6);
          }
          plainExpect(a.dx).toBeGreaterThanOrEqual(0);
          plainExpect(a.dy).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // 画像：全体の大きさは、半分の大きさのちょうど2倍（真ん中の線が全体の半分）
    const img = composeViews(model("classroom", 6, 2), true);
    plainExpect(img.divider!.at * 2).toBeCloseTo(img.divider!.stacked ? img.height : img.width, 9);
    plainExpect(composeViews(model("classroom"), false).divider).toBeNull();
  });

  plainTest("9-1：用紙の向きを選んだときは、その向きのまま（自動のときは、大きく入る向き・分け方）", () => {
    const m = model("classroom", 6, 2);
    const portrait = bothViewsPagePlan(m, "A4", "portrait");
    plainExpect([Math.round(portrait.pageW), Math.round(portrait.pageH)]).toEqual([595, 842]);
    const landscape = bothViewsPagePlan(m, "B5", "landscape");
    plainExpect(landscape.pageW).toBeGreaterThan(landscape.pageH);
    const auto = bothViewsPagePlan(m, "A4", "auto");
    const scaleOf = (p: ReturnType<typeof bothViewsPagePlan>) => composeHalves(m, p.pageW, p.pageH, p.stacked, p.margin).views[0].scale;
    plainExpect(scaleOf(auto)).toBeGreaterThanOrEqual(scaleOf(portrait) - 1e-9);
  });

  plainTest("9-2・9-3：卓・机は、会議（対面・コの字）とカスタムで同じ仕組み。席の位置は変えず、範囲の外の値は直す", () => {
    plainExpect(["meeting", "meeting-u", "custom"].every((p) => supportsDesks(p as never))).toBe(true);
    plainExpect(supportsDesks("classroom")).toBe(false);
    for (const purpose of ["meeting", "custom"] as const) {
      const base = buildBaseLayout(purpose, DEFAULT_PARAMS);
      const d1 = newDesk(purpose, base, [], "d1");
      plainExpect(d1.label).toBe(purpose === "custom" ? "机1" : "卓1");
      plainExpect(d1.y).toBeGreaterThan(base.height - 28); // 座席表の下に置く
      const d2 = newDesk(purpose, base, [d1], "d2");
      plainExpect(d2.y).toBeGreaterThanOrEqual(d1.y + d1.h); // 重ならない
      const g = buildLayout(purpose, { ...DEFAULT_PARAMS, desks: [d1, { ...d2, x: 300, w: 500 }] });
      plainExpect(g.seats.map((s) => [s.x, s.y])).toEqual(base.seats.map((s) => [s.x, s.y]));
      plainExpect(g.shapes.length).toBe(base.shapes.length + 2);
      const last = g.shapes[g.shapes.length - 1];
      plainExpect(last).toMatchObject({ kind: "rect", x: 300, w: 500, label: d2.label });
      plainExpect(g.height).toBeGreaterThan(base.height);
    }
    // 授業では、卓・机の値があっても使わない
    const cls = buildLayout("classroom", { ...DEFAULT_PARAMS, desks: [{ id: "x", x: 0, y: 0, w: 100, h: 50, label: "x" }] });
    plainExpect(cls.shapes).toHaveLength(0);
    // 左にはみ出す卓は、全体をずらして入れる（席どうしの位置関係は変わらない）
    const base = buildBaseLayout("custom", DEFAULT_PARAMS);
    const g = withDesks(base, [{ id: "l", x: -100, y: 40, w: 60, h: 40, label: "" }]);
    plainExpect(g.seats[0].x - base.seats[0].x).toBe(128); // 卓が余白（28）の位置に来るよう、全体を 100＋28 ずらす
    plainExpect(normalizeDesks([{ id: "a", x: 1e9, y: -1e9, w: 1, h: 1e9, label: "あ".repeat(50) }])[0]).toEqual({ id: "a", x: 6000, y: -2000, w: 30, h: 1200, label: "あ".repeat(20) });
  });

  plainTest("9-4：出席番号を赤くするのは、授業とカスタムだけ", () => {
    plainExpect(["classroom", "custom"].map(usesRedNumbers)).toEqual([true, true]);
    plainExpect(["meeting", "meeting-u", "group", "round", null].map(usesRedNumbers)).toEqual([false, false, false, false, false]);
  });
});

// ===========================================================================
// 画面
// ===========================================================================

test.describe("1：画像リサイズ・圧縮の初期状態", () => {
  test("最初は「サイズを変更する」がオン・「圧縮する」がオフ。圧縮だけ・両方も選べる", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await uploadFixture(page, fixtures.landscapeJpg);
    await expect(page.getByTestId("image-op-resize")).toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId("image-op-compress")).not.toBeChecked();
    await expect(page.getByRole("button", { name: "リサイズする", exact: true })).toBeVisible();
    await page.getByTestId("image-op-compress").check();
    await expect(page.getByRole("button", { name: "リサイズして圧縮する" })).toBeVisible();
    await page.getByTestId("image-op-resize").uncheck();
    await expect(page.getByRole("button", { name: "圧縮する", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "圧縮する", exact: true }).click();
    await waitForSuccess(page, "完了");
  });
});

test.describe("3：CSV・Excel列編集の「行を編集」", () => {
  async function openWith(page: Page, file: string) {
    await page.goto("/tools/csv-column-editor");
    await uploadFixture(page, file);
    await expect(page.getByTestId("column-editor-target")).toBeVisible({ timeout: 20_000 });
  }

  test("CSV：行を外す・並び替えると、出力に反映する。列の編集と切り替えても、両方の設定が残る", async ({ page }) => {
    const src = test.info().outputPath("rows.csv");
    fs.writeFileSync(src, "名前,点数,クラス\n山田,80,A\n佐藤,70,B\n鈴木,90,A\n");
    await openWith(page, src);
    await expect(page.getByTestId("column-editor-target-columns")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("column-editor-target-rows").click();
    const rows = page.getByTestId("row-editor-row");
    await expect(rows).toHaveCount(3); // 見出しの行は、いつも先頭に残す（一覧に出さない）
    await page.getByLabel("3行目を含める").uncheck(); // 佐藤を削除
    await page.getByLabel("4行目を上へ移動").click(); // 鈴木を山田の前へ（3行目を外したので2つ上へ）
    await page.getByLabel("4行目を上へ移動").click();
    await expect(page.getByTestId("column-editor-summary")).toContainText("残す行：2行");
    // 列の編集へ切り替えて、クラスの列を外す。行の設定は残る
    await page.getByTestId("column-editor-target-columns").click();
    await page.getByLabel("クラスを含める").uncheck();
    await page.getByTestId("column-editor-target-rows").click();
    await expect(page.getByLabel("3行目を含める")).not.toBeChecked();
    await page.getByRole("button", { name: "この内容で保存する" }).click();
    await waitForSuccess(page, "CSVの生成が完了しました");
    const out = test.info().outputPath("rows-out.csv");
    await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
    expect(fs.readFileSync(out, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/)).toEqual(["名前,点数", "鈴木,90", "山田,80"]);
  });

  test("Excel：選んだシートの行を並び替え・削除でき、数式は参照を合わせて残り、ほかのシートは変わらない", async ({ page }) => {
    const src = test.info().outputPath("rows.xlsx");
    py(
      `
import sys
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "名簿"
ws.append(["名前", "点数", "倍"])
ws.append(["山田", 80, "=B2*2"])
ws.append(["佐藤", 70, "=B3*2"])
ws.append(["鈴木", 90, "=B4*2"])
wb.create_sheet("別")["A1"] = "そのまま"
wb.save(sys.argv[1])
`,
      [src],
    );
    await openWith(page, src);
    await page.getByTestId("column-editor-target-rows").click();
    await page.getByLabel("2行目を含める").uncheck(); // 山田を削除
    await page.getByLabel("4行目を上へ移動").click(); // 鈴木を佐藤の前へ
    await page.getByRole("button", { name: "この内容で保存する" }).click();
    await waitForSuccess(page, "Excelの生成が完了しました");
    const out = test.info().outputPath("rows-out.xlsx");
    await (await clickAndDownload(page, "Excelでダウンロード")).saveAs(out);
    const r = JSON.parse(
      py(
        `
import sys, json
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
print(json.dumps({"rows": [[c.value for c in row] for row in wb["名簿"].iter_rows()], "other": wb["別"]["A1"].value}, ensure_ascii=False))
`,
        [out],
      ),
    );
    expect(r.rows).toEqual([
      ["名前", "点数", "倍"],
      ["鈴木", 90, "=B2*2"],
      ["佐藤", 70, "=B3*2"],
    ]);
    expect(r.other).toBe("そのまま");
  });
});

test.describe("8：Word段落整理・段組み", () => {
  test("段組みができることが最初に分かり、「段組みだけを変更する」で整理を外して段組みの設定を開ける", async ({ page }) => {
    const src = test.info().outputPath("doc.docx");
    py(
      `
import sys
from docx import Document
d = Document()
for i in range(6):
    d.add_paragraph(f"段落{i}　本文です。")
d.save(sys.argv[1])
`,
      [src],
    );
    await page.goto("/tools/word-paragraph-cleanup");
    await expect(page.getByTestId("word-tool-guide")).toContainText("段組みの変更（1段・2段・3段");
    await uploadFixture(page, src);
    await page.getByTestId("word-columns-only").click();
    await expect(page.getByTestId("word-columns-enable")).toBeChecked();
    await expect(page.getByTestId("word-columns-count-2")).toBeVisible();
    await expect(page.getByRole("button", { name: "段組みを変更する" })).toBeEnabled();
  });
});

test.describe("9：座席表", () => {
  async function openSeating(page: Page) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/tools/seating-chart");
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="seat-purpose-meeting"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    }, null, { timeout: 60_000 });
  }
  const desks = (page: Page) => page.getByTestId("seat-desk");

  test("9-2：会議（対面）で卓を増やし、位置・大きさを変えられる。プレビュー・PDFに出る", async ({ page }) => {
    test.setTimeout(120_000);
    await openSeating(page);
    await openSeatPanel(page, "purpose");
    await page.getByTestId("seat-purpose-meeting").click();
    await openSeatPanel(page, "names");
    await page.getByTestId("seat-names").fill(["議長", "A", "B", "C"].join("\n"));
    await openSeatPanel(page, "layout");
    await expect(page.getByTestId("seat-desks")).toContainText("卓を置く");
    await openSeatPanel(page, "layout");
    await page.getByTestId("seat-desk-add").click();
    await openSeatPanel(page, "layout");
    await page.getByTestId("seat-desk-add").click();
    await expect(desks(page)).toHaveCount(2);
    const first = desks(page).first();
    await openSeatPanel(page, "layout");
    await expect(first.getByTestId("seat-desk-label")).toHaveValue("卓1");
    await openSeatPanel(page, "layout");
    await first.getByTestId("seat-desk-label").fill("司会卓");
    const x0 = Number(await first.getByTestId("seat-desk-x").inputValue());
    await openSeatPanel(page, "layout");
    await first.getByTestId("seat-desk-right").click();
    await openSeatPanel(page, "layout");
    await expect(first.getByTestId("seat-desk-x")).toHaveValue(String(x0 + 20));
    await openSeatPanel(page, "layout");
    await first.getByTestId("seat-desk-w").fill("320");
    const preview = page.getByTestId("tool-preview");
    const shape = preview.getByText("司会卓", { exact: true });
    await expect(shape).toBeVisible();
    // 席の位置は変わらない（卓を置く前と同じ）
    await openSeatPanel(page, "layout");
    await desks(page).nth(1).getByTestId("seat-desk-delete").click();
    await expect(desks(page)).toHaveCount(1);
    await page.getByTestId("seat-format-pdf").click();
    const pdf = await clickAndDownload(page, "PDFでダウンロード");
    const content = await extractPdfContent((await assertDownloadedFile(pdf, { format: "pdf" })).path);
    expect(content.text).toContain("司会卓");
    expect(content.text).not.toContain("卓2");
  });

  test("9-3：カスタムで机を自由に置ける（会議と同じ部品）。9-4：出席番号は授業・カスタムで赤、会議では赤くしない", async ({ page }) => {
    await openSeating(page);
    await openSeatPanel(page, "purpose");
    await page.getByTestId("seat-purpose-custom").click();
    await openSeatPanel(page, "names");
    await page.getByTestId("seat-names").fill(["1 山田", "2 佐藤", "3 鈴木"].join("\n"));
    await openSeatPanel(page, "layout");
    await expect(page.getByTestId("seat-desks")).toContainText("机を置く");
    await openSeatPanel(page, "layout");
    await page.getByTestId("seat-desk-add").click();
    await openSeatPanel(page, "layout");
    await expect(desks(page).first().getByTestId("seat-desk-label")).toHaveValue("机1");
    await openSeatPanel(page, "layout");
    await desks(page).first().getByTestId("seat-desk-down").click();
    await openSeatPanel(page, "layout");
    await desks(page).first().getByTestId("seat-desk-h").fill("90");
    await expect(page.getByTestId("tool-preview").getByText("机1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("seat-number").first()).toHaveAttribute("data-red", "true");
    await expect(page.getByTestId("seat-number").first()).toHaveClass(/text-red-600/);
    // 授業も赤
    await openSeatPanel(page, "purpose");
    await page.getByTestId("seat-purpose-classroom").click();
    await openSeatPanel(page, "layout");
    await expect(page.getByTestId("seat-desks")).toHaveCount(0); // 授業には卓・机の設定は出さない
    await expect(page.getByTestId("seat-number").first()).toHaveAttribute("data-red", "true");
    // 会議では赤くしない
    await openSeatPanel(page, "purpose");
    await page.getByTestId("seat-purpose-meeting").click();
    await openSeatPanel(page, "names");
    await page.getByTestId("seat-numbers").check();
    await expect(page.getByTestId("seat-number").first()).toBeVisible();
    await expect(page.getByTestId("seat-number").first()).not.toHaveAttribute("data-red", "true");
    await expect(page.getByTestId("seat-number").first()).not.toHaveClass(/text-red/);
  });

  test("9-1：前後を1ページに：PDFの上半分に前が上の図、下半分に前が下の図が、真ん中の線をまたがずに入る（A4縦・A5横）", async ({ page }) => {
    test.setTimeout(120_000);
    await openSeating(page);
    await openSeatPanel(page, "purpose");
    await page.getByTestId("seat-purpose-classroom").click();
    // PDFの文字の読み取り（pdf.js）で英数字が崩れることがあるため、名前は日本語にする
    const people = ["一郎", "二郎", "三郎", "四郎", "五郎", "六郎", "七郎", "八郎", "九郎", "十郎", "百合", "千代"];
    await openSeatPanel(page, "names");
    await page.getByTestId("seat-names").fill(people.join("\n"));
    await page.getByTestId("seat-format-pdf").click();
    await page.getByTestId("seat-both-views").check();
    for (const [paper, orient] of [["A4", "portrait"], ["A5", "landscape"]] as const) {
      await page.getByTestId("seat-paper").selectOption(paper);
      await page.getByTestId("seat-paper-orientation").selectOption(orient);
      const pdf = await clickAndDownload(page, "PDFでダウンロード");
      const c = await extractPdfContent((await assertDownloadedFile(pdf, { format: "pdf" })).path);
      const p = c.pages[0];
      expect(c.pageCount).toBe(1);
      expect(p.width > p.height).toBe(orient === "landscape");
      const upCaption = p.items.find((it) => it.str.includes("前が上の向き"))!;
      const downCaption = p.items.find((it) => it.str.includes("前が下の向き"))!;
      // 2つの図が、それぞれ別の半分にある（上下に分けたときは y、左右に分けたときは x で分かれる）
      const stacked = Math.abs(upCaption.y - downCaption.y) > Math.abs(upCaption.x - downCaption.x);
      const half = stacked ? p.height / 2 : p.width / 2;
      const pos = (it: { x: number; y: number }) => (stacked ? it.y : it.x);
      const firstIsHigh = stacked ? pos(upCaption) > half : pos(upCaption) < half;
      expect(firstIsHigh).toBe(true);
      const n1 = p.items.filter((it) => it.str === "一郎").map(pos);
      expect(n1).toHaveLength(2);
      // 同じ名前の2つが、真ん中の線の両側に1つずつ
      expect(n1.filter((v) => v > half).length).toBe(1);
      expect(n1.filter((v) => v < half).length).toBe(1);
    }
  });
});

test.describe("10：Excel空白行・空白列削除の「左に詰める」「上に詰める」", () => {
  const MAKE = `
import sys, datetime
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook()
ws = wb.active
ws.title = "データ"
ws["A1"] = "外"
ws["G1"] = "=SUM(B2:E2)"
ws["H1"] = "=SUM(D2:E2)"
ws["B2"] = "a"
ws["D2"] = "b"
ws["F2"] = '=D2&"!"'
ws["C3"] = datetime.date(2024, 1, 2)
ws["C3"].number_format = "yyyy/mm/dd"
ws["E3"] = 5
ws["E3"].font = Font(bold=True)
ws.merge_cells("C4:D4")
ws["C4"] = "結合"
ws["E4"] = "x"
ws["D5"] = 10
ws["E5"] = "=D5*2"
wb.create_sheet("参照")["A1"] = "=データ!E3"
wb.save(sys.argv[1])
`;
  const READ = `
import sys, json, datetime
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
ws = wb["データ"]
def v(c):
    x = ws[c].value
    return x.isoformat()[:10] if isinstance(x, (datetime.date, datetime.datetime)) else x
cells = ["A1","G1","H1","B2","C2","D2","E2","F2","B3","C3","D3","E3","B4","C4","E4","B5","C5","D5","E5"]
print(json.dumps({"v": {c: v(c) for c in cells}, "boldC3": bool(ws["C3"].font.b), "fmtB3": ws["B3"].number_format, "merged": [str(m) for m in ws.merged_cells.ranges], "other": wb["参照"]["A1"].value}, ensure_ascii=False))
`;

  test("左に詰める：範囲と向きを確かめてから実行し、範囲の中だけを詰める。値の型・書式・数式（参照の調整）を保ち、結合がかかる行は詰めない", async ({ page }) => {
    test.setTimeout(120_000);
    const src = test.info().outputPath("shift.xlsx");
    py(MAKE, [src]);
    await page.goto("/tools/excel-blank-remove");
    await uploadFixture(page, src);
    // これまでの削除の機能も残っている
    await expect(page.getByTestId("blank-remove-modes").getByRole("button", { name: "空白行のみ" })).toBeVisible();
    await page.getByTestId("blank-shift-left").click();
    await page.getByTestId("blank-range-start-row").fill("2");
    await page.getByTestId("blank-range-end-row").fill("5");
    await page.getByTestId("blank-range-start-col").fill("2");
    await page.getByTestId("blank-range-end-col").fill("5");
    await expect(page.getByTestId("blank-shift-confirm")).toContainText("シート「データ」の B2:E5 を、左に詰める");
    await expect(page.getByTestId("blank-shift-summary")).toContainText("動くセル：5個");
    await expect(page.getByTestId("blank-shift-summary")).toContainText("詰めない行：1");
    await page.getByTestId("blank-remove-run").click();
    await waitForSuccess(page, "詰めました");
    const result = page.getByTestId("blank-shift-result");
    await expect(result).toContainText("動かしたセル 5個");
    await expect(result).toContainText("結合したセルがかかる行（4行目）は、詰めずにそのまま残しました");
    await expect(result).toContainText("計算結果の値に置き換えた 1個");
    const out = test.info().outputPath("shift-out.xlsx");
    await (await clickAndDownload(page, "Excelファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ, [out]));
    expect(r.v).toEqual({
      A1: "外", // 範囲の外は変わらない
      G1: "=SUM(B2:E2)", // 範囲の中だけで並びが変わる参照はそのまま
      H1: null, // 一部だけ動く参照は、計算結果の値に置き換える（テスト用のファイルには計算結果が無いため空欄）
      B2: "a",
      C2: "b",
      D2: null,
      E2: null,
      F2: '=C2&"!"', // 移ったセル（D2→C2）への参照は、移った先へ
      B3: "2024-01-02", // 日付は日付のまま
      C3: 5,
      D3: null,
      E3: null,
      B4: null, // 結合がかかる行は詰めない
      C4: "結合",
      E4: "x",
      B5: 10,
      C5: "=B5*2", // 数式も一緒に移り、参照も合わせる
      D5: null,
      E5: null,
    });
    expect(r.boldC3).toBe(true); // 書式もセルと一緒に移る
    expect(r.fmtB3).toBe("yyyy/mm/dd");
    expect(r.merged).toEqual(["C4:D4"]);
    expect(r.other).toBe("=データ!C3"); // ほかのシートの参照も合わせる
  });

  test("上に詰める：各列で値のあるセルを上へ寄せる", async ({ page }) => {
    const src = test.info().outputPath("shift-up.xlsx");
    py(
      `
import sys
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws["A1"] = 1
ws["A3"] = 3
ws["B2"] = "b"
ws["C5"] = "外"
wb.save(sys.argv[1])
`,
      [src],
    );
    await page.goto("/tools/excel-blank-remove");
    await uploadFixture(page, src);
    await page.getByTestId("blank-shift-up").click();
    await page.getByTestId("blank-range-start-row").fill("1");
    await page.getByTestId("blank-range-end-row").fill("4");
    await page.getByTestId("blank-range-start-col").fill("1");
    await page.getByTestId("blank-range-end-col").fill("2");
    await expect(page.getByTestId("blank-shift-confirm")).toContainText("A1:B4 を、上に詰める");
    await page.getByTestId("blank-remove-run").click();
    await waitForSuccess(page, "詰めました");
    const out = test.info().outputPath("shift-up-out.xlsx");
    await (await clickAndDownload(page, "Excelファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(
      py(
        `
import sys, json
from openpyxl import load_workbook
ws = load_workbook(sys.argv[1]).active
print(json.dumps({c: ws[c].value for c in ["A1","A2","A3","B1","B2","C5"]}))
`,
        [out],
      ),
    );
    expect(r).toEqual({ A1: 1, A2: 3, A3: null, B1: "b", B2: null, C5: "外" });
  });
});
