import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { tools, getToolById } from "@/lib/tools/data";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { DOCUMENT_SUITE_MODES, DOCUMENT_SUITE_TOOL_ID } from "@/lib/tools/document-suite-modes";

/**
 * 見積書・注文書・請求書作成（総合改修 10）：4つの帳票ツールを1つに統合した。
 * - 登録：総合ツール（document-suite）と、旧4ツールの mergedInto・モードの対応が一致する。旧URLとSEOは残る
 * - 画面：書類を選ぶと、その書類の入力欄が出る。切り替えても共通の入力は引き継ぐ。旧URLはその書類を選んだ状態で開く
 */

plainTest("登録：旧4ツールは document-suite にまとめられ（一覧には出さない）、それぞれのページ・SEO情報は残る", () => {
  const hub = getToolById(DOCUMENT_SUITE_TOOL_ID)!;
  plainExpect(hub.name).toBe("見積書・注文書・請求書作成");
  plainExpect(hub.mergedInto).toBeUndefined();
  const members = tools.filter((t) => t.mergedInto === DOCUMENT_SUITE_TOOL_ID).map((t) => t.id).sort();
  plainExpect(members).toEqual(DOCUMENT_SUITE_MODES.map((m) => m.toolId).sort());
  for (const m of DOCUMENT_SUITE_MODES) {
    plainExpect(getToolSeoContent(m.toolId)?.metaTitle, m.toolId).toBeTruthy();
  }
  plainExpect(getToolSeoContent(DOCUMENT_SUITE_TOOL_ID)?.faq.length).toBeGreaterThan(2);
});

test.describe("見積書・注文書・請求書作成の画面", () => {
  test("書類を切り替えると、その書類の入力欄が出る。宛先・明細の入力は引き継ぐ", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tools/document-suite");
    const mode = page.getByTestId("document-suite-mode");
    await expect(mode.getByRole("radio", { name: "見積書", exact: true })).toHaveAttribute("aria-checked", "true");
    // 宛先と明細を入れる
    await page.getByTestId("document-settings").getByLabel("会社名・屋号").first().fill("株式会社サンプル");
    await page.getByLabel("明細1 品名").fill("作業費");
    await page.getByLabel("明細1 単価").fill("50000");
    await expect(page.getByTestId("tool-preview")).toContainText("株式会社サンプル");
    await expect(page.getByTestId("tool-preview")).toContainText("見積書");
    await expect(page.getByTestId("bank-account-settings")).toHaveCount(0);

    // 請求書：振込先の欄が出て、宛先・明細は引き継ぐ
    await mode.getByRole("radio", { name: "請求書", exact: true }).click();
    await expect(page.getByTestId("bank-account-settings")).toBeVisible();
    await expect(page.getByTestId("tool-preview")).toContainText("請求書");
    await expect(page.getByTestId("tool-preview")).toContainText("株式会社サンプル");
    await expect(page.getByLabel("明細1 品名")).toHaveValue("作業費");

    // 見積書・注文書の一体作成：上下に見積書と注文書。宛先は引き継ぐ
    await mode.getByRole("radio", { name: "見積書・注文書の一体作成" }).click();
    await expect(page.getByText("A4の1枚に「上=見積書」「下=注文書」を作ります。")).toBeVisible();
    await expect(page.getByTestId("tool-preview").locator("svg")).toContainText("株式会社サンプル");
    await expect(page.getByLabel("注文書に入れる納期（任意）")).toBeVisible();

    // 注文書
    await mode.getByRole("radio", { name: "注文書", exact: true }).click();
    await expect(page.getByTestId("tool-preview")).toContainText("注文書");
    await expect(page.getByLabel("明細1 品名")).toHaveValue("作業費");
  });

  for (const m of DOCUMENT_SUITE_MODES) {
    test(`旧URL /tools/${m.toolId} は、「${m.label}」を選んだ状態の総合ツールが開く（URL・title はそのページのまま）`, async ({ page }) => {
      await page.goto(`/tools/${m.toolId}`);
      await expect(page.getByTestId("document-suite-mode").getByRole("radio", { name: m.label, exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(page).toHaveURL(new RegExp(`/tools/${m.toolId}$`));
      await expect(page).toHaveTitle(new RegExp(getToolSeoContent(m.toolId)!.metaTitle.split("｜")[0]));
    });
  }

  test("設定は見出しを押して開閉できる（折りたたみ式）", async ({ page }) => {
    await page.goto("/tools/document-suite");
    const section = page.getByTestId("document-settings").locator("details").filter({ hasText: "明細" }).first();
    await expect(section).toHaveAttribute("open", "");
    await section.locator("summary").click();
    await expect(section).not.toHaveAttribute("open", "");
    await section.locator("summary").click();
    await expect(section).toHaveAttribute("open", "");
  });
});
