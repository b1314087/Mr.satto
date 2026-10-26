import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";

/**
 * 工程27：予期しない実行時エラーが起きたときの画面（src/app/error.tsx、src/app/global-error.tsx）のテスト。
 *
 * 本番の障害を起こすわけではない。React の開発用ビルドが、ブラウザ拡張の「React DevTools」向けに用意している
 * 仕組み（エラー境界を「エラーが起きた状態」に切り替える。DevToolsの「エラー境界の切り替え」と同じもの）を、
 * テストから使う。そのため、アプリ側にテスト専用の部品や入口は一切ない。
 * 開発サーバー（next dev）で動かす前提（playwright.config.ts のとおり）。
 */

/** React が読み込まれる前に、DevTools の入口だけを用意して、React の内部の操作口を受け取る */
async function installReactHook(page: Page) {
  await page.addInitScript(() => {
    type Fiber = { type?: { name?: string } | null; child: Fiber | null; sibling: Fiber | null };
    type Renderer = { setErrorHandler?: (fn: (fiber: Fiber) => boolean | undefined) => void; scheduleUpdate?: (fiber: Fiber) => void };
    const state: { renderer: Renderer | null; roots: Set<{ current: Fiber }> } = { renderer: null, roots: new Set() };
    (window as unknown as { __MS_TEST: typeof state }).__MS_TEST = state;
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject(renderer: Renderer) {
        // 登録は複数ある（画面を作る本体と、それ以外）。エラーの操作口を持つ本体だけを使う
        if (renderer.setErrorHandler && renderer.scheduleUpdate) state.renderer = renderer;
        return 1;
      },
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        state.roots.add(root);
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
      on() {},
      off() {},
      emit() {},
      sub() {
        return () => {};
      },
    };
  });
}

/**
 * Next.js のエラー境界（エラーを受け止めて代替の画面を出す部品）のうち、代替画面の部品の名前が一致するものを、
 * 「エラーが起きた状態」に切り替える（React DevTools の「エラー境界の切り替え」と同じ操作）。
 * componentName: src/app/error.tsx の部品は "Error"、src/app/global-error.tsx の部品は "GlobalError"。
 */
async function breakBoundary(page: Page, componentName: "Error" | "GlobalError") {
  const ok = await page.evaluate((name) => {
    type Fiber = {
      tag: number;
      stateNode: { props?: { errorComponent?: { name?: string }; globalError?: [{ name?: string }?] } } | null;
      child: Fiber | null;
      sibling: Fiber | null;
    };
    type Hook = {
      renderer: { setErrorHandler: (fn: (f: Fiber) => boolean | undefined) => void; scheduleUpdate: (f: Fiber) => void } | null;
      roots: Set<{ current: Fiber }>;
    };
    const w = window as unknown as { __MS_TEST: Hook; __MS_BREAK: unknown };
    const hook = w.__MS_TEST;
    const renderer = hook.renderer;
    if (!renderer) return "no-renderer";
    // クラス部品（tag 1）で、代替画面の部品の名前が一致するものを探す。
    // 通常のページの境界は errorComponent に、サイト全体の境界（global-error.tsx）は globalError（部品と装飾の組）に持っている
    function find(fiber: Fiber | null): Fiber | null {
      for (let f = fiber; f; f = f.sibling) {
        const props = f.tag === 1 ? f.stateNode?.props : undefined;
        if (props && (props.errorComponent?.name === name || props.globalError?.[0]?.name === name)) return f;
        const found = find(f.child);
        if (found) return found;
      }
      return null;
    }
    for (const root of hook.roots) {
      const target = find(root.current);
      if (target) {
        // 同じ部品かどうかは、作り直しで入れ替わる画面の控え（fiber）ではなく、実体（stateNode）で見分ける
        w.__MS_BREAK = target.stateNode;
        renderer.setErrorHandler((f) => (w.__MS_BREAK && f.stateNode === w.__MS_BREAK ? true : undefined));
        renderer.scheduleUpdate(target);
        return "scheduled";
      }
    }
    return "not-found";
  }, componentName);
  expect(ok, `エラー境界「${componentName}」を切り替えられる`).toBe("scheduled");
}

/** エラーにするのをやめる（もう一度試したときに、正常に表示できる状態に戻す） */
async function repair(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __MS_BREAK: unknown }).__MS_BREAK = null;
  });
}

test.describe("予期しないエラーの画面（工程27）", () => {
  test("ページの表示中にエラーが起きても、ヘッダーとフッターは残り、再試行できる案内が出る。「もう一度試す」で元に戻る", async ({ page }) => {
    await installReactHook(page);
    await page.goto("/tools/pdf-fill-annotate");
    await expect(page.getByRole("heading", { name: "PDF記入・注釈" })).toBeVisible();
    await expect(page.getByTestId("pdf-fix-modes")).toHaveCount(0);

    await breakBoundary(page, "Error");

    const alert = page.getByRole("alert").filter({ hasText: "問題が発生しました" });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert.getByRole("heading", { name: "問題が発生しました" })).toBeVisible();
    // 技術的な内容は見せない
    const text = (await alert.innerText()).toLowerCase();
    for (const secret of ["stack", "at ", "node_modules", "next_public", "process.env", "pdffillannotatetool"]) {
      expect(text, `画面に「${secret}」を含まない`).not.toContain(secret);
    }
    // ヘッダー・フッター（ルートのレイアウト）はそのまま
    await expect(page.locator("header").first()).toBeVisible();
    await expect(page.locator("footer").first()).toBeVisible();
    // 逃げ道（ツール一覧・トップページ）がある
    await expect(alert.getByRole("link", { name: "ツール一覧へ戻る" })).toHaveAttribute("href", "/tools");
    await expect(alert.getByRole("link", { name: "トップページ" })).toHaveAttribute("href", "/");

    // 原因が取り除かれた状態で「もう一度試す」と、元の画面に戻る
    await repair(page);
    await alert.getByRole("button", { name: "もう一度試す" }).click();
    await expect(page.getByRole("heading", { name: "PDF記入・注釈" })).toBeVisible({ timeout: 20_000 });
    await expect(alert).toHaveCount(0);
  });

  test("ヘッダー・フッターなど、サイト全体のレイアウトでエラーが起きたときも、最後の受け皿の画面が出る", async ({ page }) => {
    await installReactHook(page);
    await page.goto("/tools");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

    await breakBoundary(page, "GlobalError");

    const alert = page.getByRole("alert").filter({ hasText: "問題が発生しました" });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert.getByRole("button", { name: "もう一度試す" })).toBeVisible();
    await expect(alert.getByRole("link", { name: "トップページへ戻る" })).toHaveAttribute("href", "/");
    // この画面は、サイト全体のレイアウトを使わない（自分で <html> を持つ）
    await expect(page.locator("header")).toHaveCount(0);

    await repair(page);
    // 開発サーバーだけが出すエラー表示（nextjs-portal）がボタンの上に重なってクリックを受け取るため、キーボード（Enter）で押す
    await alert.getByRole("button", { name: "もう一度試す" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("header").first()).toBeVisible({ timeout: 20_000 });
    await expect(alert).toHaveCount(0);
  });
});
