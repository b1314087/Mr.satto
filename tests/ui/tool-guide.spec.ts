import { test, expect, type Page } from "@playwright/test";
import { tools, getToolById } from "@/lib/tools/data";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { toolGuides, guideModes, pageGuides, initialGuideId } from "@/lib/guides/tool-guides";

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
  test("公開中の全ツール（統合済みの旧アドレスは、そのアドレスで開くモードの図）に、2〜4ステップの図がある", () => {
    for (const id of availableIds) {
      const guideId = initialGuideId(id, getToolById(id)?.mergedInto ?? id);
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

  test("モードごとの図・統合済みの旧アドレスの図が、すべて用意されていて、モードごとに違う", () => {
    for (const [hub, modes] of Object.entries(guideModes)) {
      const keys = new Set<string>();
      for (const m of modes) {
        expect(toolGuides[m.guideId], `${hub} の ${m.mode} の図`).toBeTruthy();
        keys.add(JSON.stringify(toolGuides[m.guideId].steps));
      }
      expect(keys.size, `${hub} のモードの図が使い回されています`).toBe(modes.length);
    }
    // 統合済みの旧アドレスは、すべて行き先の図がある（まとめ先の既定モードの図を流用していない）
    const merged = availableIds.filter((id) => getToolById(id)?.mergedInto);
    for (const id of merged) {
      expect(pageGuides[id], `${id} の最初に出す図が決まっていません`).toBeTruthy();
      expect(toolGuides[pageGuides[id]], `${id} の図`).toBeTruthy();
    }
    expect(pageGuides["pdf-split"]).toBe("pdf-edit@split");
    expect(pageGuides["image-flip"]).toBe("image-rotate-flip@flip");
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

  test("閉じている幕はモーダル扱いにしない（role=dialog・aria-modal は開いている間だけ）。背景を押すと閉じ、中身を押しても閉じない", async ({ page }) => {
    await openTool(page, "image-compress");
    const panel = page.getByTestId("guide-panel");
    // 閉じている間：ページ全体へのドロップ（isModalOpen）が止まらないよう、モーダルの属性を付けない
    await expect(panel).not.toHaveAttribute("role", "dialog");
    await expect(panel).not.toHaveAttribute("aria-modal", "true");
    expect(await page.evaluate(() => document.querySelectorAll('[role="dialog"][aria-modal="true"]').length)).toBe(0);

    await page.getByTestId("guide-open-faq").click();
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    // 中身（質問）を押しても閉じない
    await page.getByTestId("guide-faq").locator("summary").first().click();
    await expect(panel).toBeInViewport();
    // 背景（ガラスだけの所：見出しの行の余白）を押すと閉じ、ボタンにフォーカスが戻る
    const head = page.locator(".ms-guide-head");
    const box = (await head.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 4);
    await expect(panel).not.toBeInViewport();
    await expect(page.getByTestId("guide-open-faq")).toBeFocused();
    await expect(panel).not.toHaveAttribute("aria-modal", "true");

    // 使い方を開いた状態でも、背景（スライドの下の余白）で閉じる
    await page.getByTestId("guide-open-howto").click();
    await expect(page.getByTestId("guide-figures")).toBeVisible();
    await page.locator(".ms-guide-panel").click({ position: { x: 4, y: (page.viewportSize()!.height) - 4 } });
    await expect(panel).not.toBeInViewport();
  });

  test("統合済みの旧アドレスは、そのモードの図から始まり、ツールでモードを切り替えると図も切り替わる", async ({ page }) => {
    await openTool(page, "pdf-split");
    await page.getByTestId("guide-open-howto").click();
    await expect(page.locator('[data-testid="guide-step"][data-current]')).toContainText(toolGuides["pdf-edit@split"].steps[0].title);
    await expect(page.getByTestId("guide-mode-split")).toHaveAttribute("aria-pressed", "true");
    // 幕の中で、ほかのモードの使い方も見られる
    await page.getByTestId("guide-mode-rotate").click();
    await expect(page.locator('[data-testid="guide-step"][data-current]')).toContainText(toolGuides["pdf-edit@rotate"].steps[0].title);
    await page.getByTestId("guide-close").click();

    // ツールの画面で「ページ削除」に切り替えてから開くと、ページ削除の図
    await page.getByTestId("pdf-edit-mode-delete").click();
    await page.getByTestId("guide-open-howto").click();
    await expect(page.locator('[data-testid="guide-step"][data-current]')).toContainText(toolGuides["pdf-edit@delete"].steps[0].title);
    await expect(page.getByTestId("guide-count")).toHaveText(`1 / ${toolGuides["pdf-edit@delete"].steps.length}`);
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
