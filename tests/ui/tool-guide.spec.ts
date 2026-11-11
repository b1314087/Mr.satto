import { test, expect, type Page } from "@playwright/test";
import { tools, getToolById } from "@/lib/tools/data";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { toolGuides } from "@/lib/guides/tool-guides";

/**
 * 全ツール共通の「使い方」「よくある質問」の幕（src/components/tools/tool-guide.tsx）。
 * - ボタンは2つ・最初は閉じている・押すとガラス調の幕が画面全体に下りる・「閉じる」／Esc／「わかった」で閉じる・フォーカスが戻る
 * - 使い方は1ページ1手順のスライド（次へ・戻る・←→キー）
 * - 使い方は図（PC・スマホ用）、よくある質問は文字だけで、構造化データ（FAQPage）と同じ内容
 * - 開け閉めしてもツールの入力はそのまま
 */

const availableIds = tools.filter((t) => AVAILABLE_TOOL_IDS.includes(t.id)).map((t) => t.id);
const listedIds = availableIds.filter((id) => !getToolById(id)?.mergedInto);

test.describe("使い方の図のデータ", () => {
  test("公開中の全ツール（統合済みの旧ツールはまとめ先）に、2〜4ステップの図がある", () => {
    for (const id of availableIds) {
      const guideId = getToolById(id)?.mergedInto ?? id;
      const guide = toolGuides[guideId];
      expect(guide, `${id} の図がありません`).toBeTruthy();
      expect(guide.steps.length, `${id} のステップ数`).toBeGreaterThanOrEqual(2);
      expect(guide.steps.length, `${id} のステップ数`).toBeLessThanOrEqual(4);
      for (const step of guide.steps) {
        if (typeof step.focus === "number") {
          expect(step.parts[step.focus], `${id}「${step.title}」の操作する部品`).toBeTruthy();
        }
      }
    }
  });

  test("ツールごとに図が違う（同じ図の使い回しがない）", () => {
    const seen = new Map<string, string>();
    for (const id of listedIds) {
      const key = JSON.stringify(toolGuides[id].steps);
      expect(seen.get(key), `${id} の図が ${seen.get(key)} と同じです`).toBeUndefined();
      seen.set(key, id);
    }
  });
});

async function openTool(page: Page, id: string) {
  await page.goto(`/tools/${id}`);
  // 押せる状態（読み込み後）になるまで待つ
  await expect(page.getByTestId("guide-open-howto")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test.describe("使い方・よくある質問の幕", () => {
  test("最初は閉じていて、使い方を開くと図が出る。「閉じる」で閉じるとボタンにフォーカスが戻る", async ({ page }) => {
    await openTool(page, "image-compress");
    const panel = page.getByTestId("guide-panel");
    await expect(panel).not.toBeInViewport();
    const howtoBtn = page.getByTestId("guide-open-howto");
    await expect(howtoBtn).toHaveAttribute("aria-expanded", "false");

    await howtoBtn.click();
    await expect(panel).toBeInViewport();
    await expect(howtoBtn).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("guide-close")).toBeFocused();
    await expect(page.getByTestId("guide-figures")).toBeVisible();
    await expect(page.getByTestId("guide-step")).toHaveCount(toolGuides["image-compress"].steps.length);
    // よくある質問は同時に出ない
    await expect(page.getByTestId("guide-faq")).toBeHidden();

    await page.getByTestId("guide-close").click();
    await expect(panel).not.toBeInViewport();
    await expect(howtoBtn).toBeFocused();
  });

  test("よくある質問：構造化データと同じ質問が並び、押すと答えが開く（いくつでも開ける）。Escで閉じる", async ({ page }) => {
    await openTool(page, "pdf-compress");
    const faqBtn = page.getByTestId("guide-open-faq");
    await faqBtn.click();
    const faq = page.getByTestId("guide-faq");
    await expect(faq).toBeVisible();
    await expect(page.getByTestId("guide-howto")).toBeHidden();

    const expected = toolSeoContent["pdf-compress"].faq;
    const items = faq.locator("details");
    await expect(items).toHaveCount(expected.length);
    for (let i = 0; i < expected.length; i++) {
      await expect(items.nth(i).locator("summary")).toContainText(expected[i].question);
    }
    // 2つ開く
    await items.nth(0).locator("summary").click();
    await items.nth(1).locator("summary").click();
    await expect(items.nth(0)).toHaveAttribute("open", "");
    await expect(items.nth(1)).toHaveAttribute("open", "");
    await expect(items.nth(0)).toContainText(expected[0].answer);

    // 幕の中で使い方に切り替えられる
    await page.getByTestId("guide-tab-howto").click();
    await expect(page.getByTestId("guide-howto")).toBeVisible();
    await expect(faq).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("guide-panel")).not.toBeInViewport();
    await expect(faqBtn).toBeFocused();
  });

  test("使い方は1ページずつスライドする（次へ・戻る・←→キー）。最後の「わかった」で閉じ、ツールの入力はそのまま", async ({ page }) => {
    await openTool(page, "char-count");
    // 開発サーバーでは、図を初めて開いたときに部品を組み立てるので、先に1回開け閉めしておく
    await page.getByTestId("guide-open-howto").click();
    await expect(page.getByTestId("guide-figures")).toBeVisible();
    await page.keyboard.press("Escape");
    const textarea = page.locator("textarea").first();
    await textarea.fill("Mr.Sattoで文字数を数えます。");

    const total = toolGuides["char-count"].steps.length;
    await page.getByTestId("guide-open-howto").click();
    const panel = page.getByTestId("guide-panel");
    await expect(panel).toBeInViewport();
    // 幕は画面全体を覆う
    const box = await panel.boundingBox();
    const vp = page.viewportSize()!;
    expect(Math.round(box!.height)).toBe(vp.height);
    await expect(page.getByTestId("guide-count")).toHaveText(`1 / ${total}`);
    await expect(page.getByTestId("guide-prev")).toBeDisabled();
    const current = page.locator('[data-testid="guide-step"][data-current]');
    await expect(current).toContainText(toolGuides["char-count"].steps[0].title);

    await page.getByTestId("guide-next").click();
    await expect(page.getByTestId("guide-count")).toHaveText(`2 / ${total}`);
    await expect(current).toContainText(toolGuides["char-count"].steps[1].title);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("guide-count")).toHaveText(`1 / ${total}`);
    for (let i = 1; i < total; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("guide-count")).toHaveText(`${total} / ${total}`);

    await page.getByTestId("guide-done").click();
    await expect(panel).not.toBeInViewport();
    await expect(page.getByTestId("guide-open-howto")).toBeFocused();
    await expect(textarea).toHaveValue("Mr.Sattoで文字数を数えます。");
    // もう一度開くと、1ページ目から
    await page.getByTestId("guide-open-howto").click();
    await expect(page.getByTestId("guide-count")).toHaveText(`1 / ${total}`);
  });

  test("スマホ幅：幕は画面の幅いっぱいで、横にはみ出さない。スマホ用の図が出る", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTool(page, "video-compress");
    await page.getByTestId("guide-open-howto").click();
    await expect(page.getByTestId("guide-figures")).toBeVisible();
    const box = await page.getByTestId("guide-panel").boundingBox();
    // 画面の幅いっぱい（パソコンのブラウザでスマホ幅にしたときは、スクロールバーの分の余白を除く）
    const viewportWidth = await page.evaluate(() => Math.round(document.querySelector(".ms-guide-root")!.getBoundingClientRect().width));
    expect(Math.round(box!.width)).toBe(viewportWidth);
    const overflow = await page.evaluate(() => {
      const panel = document.querySelector(".ms-guide-panel")!;
      return panel.scrollWidth - panel.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.locator(".gd-fig-sp").first()).toBeVisible();
    await expect(page.locator(".gd-fig-pc").first()).toBeHidden();
  });

  test("使い方・よくある質問の文章は、閉じている間もHTMLに含まれる（検索エンジン向け）", async ({ request }) => {
    const res = await request.get("/tools/pdf-compress");
    const html = await res.text();
    const seo = toolSeoContent["pdf-compress"];
    for (const item of seo.faq) expect(html).toContain(item.question);
    for (const s of seo.howTo) expect(html).toContain(s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").slice(0, 20));
  });
});

test.describe("全ツールのページに、使い方・よくある質問のボタンがある", () => {
  for (const id of availableIds) {
    test(`/tools/${id}`, async ({ request }) => {
      const html = await (await request.get(`/tools/${id}`)).text();
      expect(html).toContain('data-testid="guide-open-howto"');
      expect(html).toContain('data-testid="guide-open-faq"');
    });
  }
});
