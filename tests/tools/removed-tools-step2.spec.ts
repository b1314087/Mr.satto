import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { getFeaturedTools, getListedTools, getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { categorySeoContent } from "@/lib/seo/category-content";
import { TOOL_HANDOFF } from "@/lib/handoff/config";
import { PDF_FIX_MODES } from "@/lib/tools/pdf-fix-modes";
import { uploadFixture, clickAndDownload, closeResultPopup, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";

/**
 * 工程2（既存ツールの整理・削除・名称変更）のテスト。
 *  - 2-1 背景透過：AIのモードが無く、色指定だけが動く（AIの設定・説明・依存関係が残っていない）
 *  - 2-2 Excel横セル結合・中央揃え：単独ツールとして削除し、旧URLはCSV・Excelツールの一覧へ転送
 *  - 2-3 PDF差し込み印刷：表示名・見出し・SEOが新しい名前になり、URL・機能はそのまま
 *  - 2-4 PDF記入・注釈：独立したページを廃止し、旧URLはPDF修正へ転送（機能はPDF修正の最初の機能として使える）
 *  - 2-5 CSV結合：Excelファイル結合に統合し、名前を「Excel・CSV結合」に。旧URLは「CSVファイルを結合」の状態へ転送
 */

const REMOVED = [
  { id: "excel-merge-center", name: "Excel横セル結合・中央揃え", to: "/tools/csv-excel", words: ["セル結合", "中央揃え"] },
  { id: "pdf-fill-annotate", name: "PDF記入・注釈", to: "/tools/pdf-fix", words: [] as string[] },
  { id: "csv-merge", name: "CSV結合", to: "/tools/excel-merge?mode=csv", words: [] as string[] },
];

plainTest("削除・統合したツールは、一覧・おすすめ・関連ツール・受け渡し・SEOの情報に残っていない", () => {
  for (const r of REMOVED) {
    plainExpect(getToolById(r.id), r.id).toBeUndefined();
    plainExpect(getListedTools().some((t) => t.id === r.id), r.id).toBe(false);
    plainExpect(getFeaturedTools().some((t) => t.id === r.id), r.id).toBe(false);
    plainExpect(tools.some((t) => (t.relatedToolIds ?? []).includes(r.id)), `${r.id} を関連ツールにしているツールがある`).toBe(false);
    plainExpect(tools.some((t) => t.mergedInto === r.id), r.id).toBe(false);
    plainExpect((TOOL_HANDOFF as Record<string, unknown>)[r.id], r.id).toBeUndefined();
    plainExpect((toolSeoContent as Record<string, unknown>)[r.id], r.id).toBeUndefined();
  }
  // セル結合・中央揃えで探しても、削除したツールは出ない
  for (const q of ["Excel横セル結合・中央揃え", "セル結合", "中央揃え"]) {
    plainExpect(searchTools(getListedTools(), q).some((t) => t.id === "excel-merge-center"), q).toBe(false);
  }
  // 旧名で探すと、統合先が出る
  plainExpect(searchTools(getListedTools(), "CSV結合")[0]?.id).toBe("excel-merge");
  plainExpect(searchTools(getListedTools(), "PDF記入・注釈").some((t) => t.id === "pdf-fix")).toBe(true);
  plainExpect(searchTools(getListedTools(), "フォーム回答から個別PDF").some((t) => t.id === "form-to-individual-pdfs")).toBe(true);
  // 専用のコードは消し、統合先で使う画面（PDF記入・注釈・CSV結合）は残っている
  const root = path.join(__dirname, "..", "..", "src");
  for (const f of ["components/tools/implementations/excel-merge-center-tool.tsx", "lib/processors/browser/excel-merge-center.ts"]) {
    plainExpect(fs.existsSync(path.join(root, f)), f).toBe(false);
  }
  for (const f of [
    "components/tools/implementations/pdf-fill-annotate-tool.tsx",
    "components/tools/implementations/csv-merge-tool.tsx",
    "components/tools/implementations/excel-merge-tool.tsx",
    "lib/processors/browser/csv-ops.ts",
    "lib/utils/csv-encoding.ts",
  ]) {
    plainExpect(fs.existsSync(path.join(root, f)), f).toBe(true);
  }
  plainExpect(PDF_FIX_MODES[0].mode).toBe("annotate");
});

plainTest("2-1 背景透過：AIの印・説明・キーワードが無い（色指定の説明になっている）", () => {
  const t = getToolById("background-remover")!;
  plainExpect(t.status).toBe("available");
  plainExpect(t.hasAi).toBeUndefined();
  plainExpect(t.description).not.toMatch(/AI/);
  plainExpect((t.keywords ?? []).map((k) => k.toLowerCase())).not.toContain("ai");
  const seo = JSON.stringify(toolSeoContent["background-remover"]);
  plainExpect(seo).not.toMatch(/AI|モデル|19MB/);
  plainExpect(seo).toContain("色");
});

plainTest("2-3 PDF差し込み印刷：名前・SEOが新しい名前で、URL（ID）はそのまま", () => {
  const t = getToolById("form-to-individual-pdfs")!;
  plainExpect(t.name).toBe("PDF差し込み印刷");
  plainExpect(t.status).toBe("available");
  plainExpect(t.category).toBe("pdf");
  const seo = toolSeoContent["form-to-individual-pdfs"];
  plainExpect(seo.metaTitle.startsWith("PDF差し込み印刷｜")).toBe(true);
  plainExpect(seo.metaDescription).toContain("PDF差し込み印刷");
  plainExpect(categorySeoContent.pdf.metaDescription + categorySeoContent.pdf.intro).not.toContain("フォーム回答からの個別PDF一括作成");
});

plainTest("2-5 Excel・CSV結合：名前・SEOが新しい名前で、URL（ID）はそのまま", () => {
  const t = getToolById("excel-merge")!;
  plainExpect(t.name).toBe("Excel・CSV結合");
  plainExpect(t.status).toBe("available");
  const seo = toolSeoContent["excel-merge"];
  plainExpect(seo.metaTitle.startsWith("Excel・CSV結合｜")).toBe(true);
  plainExpect(JSON.stringify(seo.faq)).toContain("CSVファイルを結合");
});

test.describe("工程2：旧アドレスの転送・sitemap・リンク", () => {
  for (const r of REMOVED) {
    test(`${r.name}(/tools/${r.id})は、${r.to} へ恒久的に転送される`, async ({ page, request }) => {
      const res = await request.get(`/tools/${r.id}`, { maxRedirects: 0 });
      expect(res.status(), "恒久的な転送(308)").toBe(308);
      const loc = new URL(res.headers()["location"], "http://x");
      expect(loc.pathname + loc.search).toBe(r.to);
      await page.goto(`/tools/${r.id}`);
      await expect(page).toHaveURL(new RegExp(`${r.to.replace(/[/?]/g, "\\$&")}$`));
      await expect(page.locator("h1")).toHaveCount(1);
    });
  }

  test("sitemap.xml に削除・統合したツールが無く、統合先・名前を変えたツールは載っている", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    for (const r of REMOVED) expect(xml).not.toContain(`/tools/${r.id}<`);
    for (const id of ["pdf-fix", "excel-merge", "form-to-individual-pdfs", "background-remover"]) expect(xml).toContain(`/tools/${id}<`);
  });

  test("カテゴリページ・トップページに、削除・統合したツールへのリンクが無い", async ({ page }) => {
    for (const url of ["/tools/csv-excel", "/tools/pdf", "/tools", "/"]) {
      await page.goto(url);
      for (const r of REMOVED) await expect(page.locator(`a[href="/tools/${r.id}"]`), `${url}: ${r.id}`).toHaveCount(0);
    }
  });
});

test.describe("工程2：画面", () => {
  test("2-1 背景透過：AIのモードの切り替え・説明が無く、色指定のスライダーだけが出る", async ({ page }) => {
    await page.goto("/tools/background-remover");
    await uploadFixture(page, fixtures.png);
    await expect(page.getByTestId("bg-preview")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /AIで自動/ })).toHaveCount(0);
    await expect(page.getByText("切り抜きの強さ")).toHaveCount(0);
    await expect(page.getByText(/AIで背景を解析/)).toHaveCount(0);
    await expect(page.getByRole("slider", { name: /許容する色の差/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "背景を透明にする" })).toBeEnabled();
    // AIのモデル・実行ファイルを読み込まない
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.getByRole("button", { name: "背景を透明にする" }).click();
    await expect(page.getByRole("button", { name: /ダウンロード/ })).toBeVisible({ timeout: 30_000 });
    expect(requested.filter((u) => /\/models\/|\/ort\/|onnx/.test(u))).toEqual([]);
  });

  test("2-3 PDF差し込み印刷：見出し・パンくず・タイトルが新しい名前で、これまでの画面（テンプレートの読み込み）が出る", async ({ page }) => {
    const res = await page.goto("/tools/form-to-individual-pdfs");
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("PDF差し込み印刷");
    await expect(page).toHaveTitle(/^PDF差し込み印刷｜/);
    await expect(page.getByText("1. 帳票テンプレートPDFをアップロード")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("フォーム回答から個別PDFを一括作成");
  });

  test("2-5 Excel・CSV結合：最初は「Excelファイルを結合」で、これまでのExcelファイル結合の画面が出る。切り替えるとCSV結合の画面になる", async ({ page }) => {
    await page.goto("/tools/excel-merge");
    await expect(page.locator("h1")).toHaveText("Excel・CSV結合");
    const excel = page.getByTestId("excel-csv-merge-mode-excel");
    const csv = page.getByTestId("excel-csv-merge-mode-csv");
    await expect(excel).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Excel（.xlsx）・CSVをドラッグ&ドロップ（2〜20件）")).toBeVisible();
    await expect(page.getByTestId("excel-csv-merge-mode-description")).toContainText("見出しの名前で列を揃えて");
    // CSVに切り替えると、CSV結合の入力欄（CSVだけ）になる
    await expect(async () => {
      await csv.click();
      await expect(csv).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByText("CSVをドラッグ&ドロップ（複数可）")).toBeVisible();
    await expect(page.locator('input[type="file"]').first()).toHaveAttribute("accept", ".csv,text/csv");
    await expect(page.getByTestId("excel-csv-merge-mode-description")).toContainText("選んだ順に縦につない");
  });

  test("2-5 Excel・CSV結合：「CSVファイルを結合」でファイルを選んでから切り替えると、選んだファイル・結果はリセットされる", async ({ page }) => {
    await page.goto("/tools/excel-merge?mode=csv");
    await expect(page.getByTestId("excel-csv-merge-mode-csv")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await uploadFixture(page, [fixtures.csv, fixtures.csvForMerge]);
    await page.getByRole("button", { name: /件のCSVを結合する$/ }).click();
    await waitForSuccess(page, "完了");
    await closeResultPopup(page);
    await page.getByTestId("excel-csv-merge-mode-excel").click();
    await expect(page.getByTestId("excel-csv-merge-mode-excel")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("sample.csv", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /ダウンロード/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /結果を表示/ })).toHaveCount(0);
  });

  test("2-5 Excel・CSV結合：「Excelファイルを結合」で、これまでどおりExcelに結合してダウンロードできる", async ({ page }) => {
    await page.goto("/tools/excel-merge");
    await uploadFixture(page, [fixtures.csv, fixtures.csvForMerge]);
    await page.getByRole("button", { name: /件を結合する$/ }).click();
    await waitForSuccess(page, "結合が完了しました");
    const download = await clickAndDownload(page, "Excelでダウンロード");
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });
});
