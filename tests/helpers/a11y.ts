import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * 最小限のアクセシビリティチェック（Phase 14）。
 *
 * これは専門的な包括監査（axe-core等の導入）ではなく、
 * 「壊れたら気づける」レベルの最小限のチェックである:
 * - すべてのボタンにアクセシブルな名前がある
 * - すべてのテキスト系input/textareaにラベル（label/aria-label/aria-labelledby）がある
 * - Tabキーでのフォーカス移動が機能する（キーボード操作可能性の最低限の確認）
 */
export async function checkBasicAccessibility(page: Page) {
  const buttonsWithoutName = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons
      .filter((btn) => {
        const visible = btn.offsetParent !== null || btn.getClientRects().length > 0;
        if (!visible) return false;
        const accessibleName =
          btn.getAttribute("aria-label") ||
          btn.textContent?.trim() ||
          btn.getAttribute("title") ||
          "";
        return accessibleName.length === 0;
      })
      .map((btn) => btn.outerHTML.slice(0, 120));
  });
  expect(buttonsWithoutName, `名前のないボタンが見つかりました: ${buttonsWithoutName.join(" | ")}`).toEqual([]);

  const unlabeledInputs = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    return controls
      .filter((el) => {
        const type = (el as HTMLInputElement).type;
        if (type === "hidden") return false;
        const id = el.getAttribute("id");
        const hasLabelFor = id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false;
        const wrappedInLabel = !!el.closest("label");
        const hasAriaLabel = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        return !hasLabelFor && !wrappedInLabel && !hasAriaLabel;
      })
      .map((el) => el.outerHTML.slice(0, 120));
  });
  expect(unlabeledInputs, `ラベルのない入力欄が見つかりました: ${unlabeledInputs.join(" | ")}`).toEqual([]);
}

/** Tabキーでフォーカス可能な要素が最低1つ以上あることを確認する簡易チェック */
export async function checkKeyboardFocusable(page: Page) {
  await page.keyboard.press("Tab");
  const hasFocus = await page.evaluate(() => document.activeElement !== document.body);
  expect(hasFocus, "Tabキーでフォーカスできる要素が見つかりませんでした").toBeTruthy();
}
