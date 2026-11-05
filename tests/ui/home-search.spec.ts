import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { searchTools } from "@/lib/tools/search";
import { getListedTools } from "@/lib/tools/data";

/**
 * トップページの検索改善の工程：「何をしたいですか？」の検索欄・検索候補・キーボード操作・該当なしの案内と、
 * やりたい作業の言い方で目的のツールが上位に出ること（検索品質）を確かめる。
 */

const available = () => getListedTools().filter((t) => t.status === "available");

plainTest.describe("検索品質（やりたい作業の言い方で探す）", () => {
  // 期待するツール（統合済みのツールは、統合先の総合ツールで出る：PDF結合 → PDF編集、CSV→Excel → Excel・CSV変換）
  const CASES: [string, string][] = [
    ["PDFを小さく", "pdf-compress"],
    ["PDFまとめる", "pdf-edit"],
    ["PDFを画像に", "pdf-to-image"],
    ["写真の背景を消す", "background-remover"],
    ["動画を短くする", "video-convert"],
    ["動画の容量を減らす", "video-compress"],
    ["Excelを比較", "office-compare"],
    ["Wordを比較", "office-compare"],
    ["CSVをExcelに", "excel-csv-convert"],
    ["画像のサイズ変更", "image-resize"],
    ["画像を軽くする", "image-compress"],
    ["請求書を作る", "invoice-generator"],
    // 入力欄の例
    ["PDFを圧縮したい", "pdf-compress"],
    ["画像の背景を消したい", "background-remover"],
    ["動画を短くしたい", "video-convert"],
    ["Excelを比較したい", "office-compare"],
  ];
  for (const [q, id] of CASES) {
    plainTest(`「${q}」→ ${id} がいちばん上`, () => {
      plainExpect(searchTools(available(), q)[0]?.id).toBe(id);
    });
  }
  plainTest("「ファイル形式を変換したい」は、変換のツールが並ぶ", () => {
    const r = searchTools(available(), "ファイル形式を変換したい");
    plainExpect(r.length).toBeGreaterThan(3);
    plainExpect(r.slice(0, 5).every((t) => /変換|→/.test(t.name + t.description))).toBe(true);
  });
});

test.describe("トップページの検索欄", () => {
  test("「何をしたいですか？」の見出しと例が出る。入力すると上位5件の候補とツールの説明・カテゴリが出て、候補を押すとそのツールへ移る", async ({ page }) => {
    await page.goto("/");
    const input = page.getByRole("combobox", { name: "何をしたいですか？" });
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "例：PDFを圧縮したい");
    await expect(page.getByTestId("home-search-example")).toHaveCount(5);
    await input.fill("PDF");
    const options = page.getByTestId("home-search-option");
    await expect(options).toHaveCount(5);
    await expect(options.first()).toContainText("PDF");
    await expect(page.getByTestId("home-search-all")).toContainText("「PDF」の検索結果をすべて見る");
    await page.getByTestId("home-search-option").filter({ hasText: "PDF圧縮" }).click();
    await expect(page).toHaveURL(/\/tools\/pdf-compress$/);
  });

  test("上下キーで候補を選び、Enter でそのツールへ。Escape で候補を閉じる。選ばずに Enter・検索ボタンでは一覧の検索結果へ", async ({ page }) => {
    await page.goto("/");
    const input = page.getByTestId("home-search-input");
    await input.fill("画像を軽くする");
    await expect(page.getByTestId("home-search-option").first()).toHaveAttribute("data-tool-id", "image-compress");
    await input.press("Escape");
    await expect(page.getByTestId("home-search-panel")).toHaveCount(0);
    await input.press("ArrowDown");
    await expect(page.getByTestId("home-search-option").first()).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveAttribute("aria-activedescendant", /opt-0$/);
    await input.press("Enter");
    await expect(page).toHaveURL(/\/tools\/image-compress$/);

    await page.goto("/");
    await page.getByTestId("home-search-input").fill("PDF 結合");
    await page.getByTestId("home-search-input").press("Enter");
    await expect(page).toHaveURL(/\/tools\?q=PDF/);

    await page.goto("/");
    await page.getByTestId("home-search-input").fill("動画");
    await page.getByTestId("home-search-submit").click();
    await expect(page).toHaveURL(/\/tools\?q=%E5%8B%95%E7%94%BB/);
  });

  test("×で入力を消せる。当てはまるツールがないときは、別の言葉を勧め、カテゴリへの入口を出す。例を押すと検索する", async ({ page }) => {
    await page.goto("/");
    const input = page.getByTestId("home-search-input");
    await input.fill("あいうえおかきくけこ");
    await expect(page.getByTestId("home-search-empty")).toContainText("別の言葉でも検索してみてください");
    await expect(page.getByTestId("home-search-empty").getByRole("link", { name: "PDF" })).toHaveAttribute("href", "/tools/pdf");
    await page.getByTestId("home-search-clear").click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(page.getByTestId("home-search-panel")).toHaveCount(0);
    await page.getByTestId("home-search-example").first().click();
    await expect(page).toHaveURL(/\/tools\?q=/);
  });

  test("スマホ幅：検索欄と候補が画面の中に収まり、候補を押せる", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/");
    const input = page.getByTestId("home-search-input");
    const ib = (await input.boundingBox())!;
    plainExpect(ib.x).toBeGreaterThanOrEqual(0);
    plainExpect(ib.x + ib.width).toBeLessThanOrEqual(375);
    plainExpect(ib.height).toBeGreaterThanOrEqual(44);
    await input.fill("PDF");
    const panel = (await page.getByTestId("home-search-panel").boundingBox())!;
    plainExpect(panel.x).toBeGreaterThanOrEqual(0);
    plainExpect(panel.x + panel.width).toBeLessThanOrEqual(375);
    const opt = (await page.getByTestId("home-search-option").first().boundingBox())!;
    plainExpect(opt.height).toBeGreaterThanOrEqual(40);
    await page.getByTestId("home-search-option").first().click();
    await expect(page).toHaveURL(/\/tools\/[a-z0-9-]+$/);
  });

  test("検索しても通信は増えない（候補はブラウザの中だけで出す）", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const requests: string[] = [];
    page.on("request", (r) => {
      if (!r.url().includes("/_next/static/") && !r.url().includes("webpack") && !r.url().includes("hmr")) requests.push(r.url());
    });
    await page.getByTestId("home-search-input").fill("PDFを圧縮したい");
    await expect(page.getByTestId("home-search-option").first()).toBeVisible();
    await page.getByTestId("home-search-input").fill("動画");
    await page.waitForTimeout(500);
    plainExpect(requests.filter((u) => !/\/api\/analytics|__nextjs|_rsc|\.hot-update/.test(u))).toEqual([]);
  });
});
