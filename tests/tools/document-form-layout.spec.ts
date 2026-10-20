import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";

/**
 * 帳票作成（見積書・請求書・注文書・見積書/注文書）の入力フォームの見切れ防止テスト。
 *
 * 不具合: PCでは「入力欄｜プレビュー」の2列配置のため、画面が広くてもフォームの幅は約440pxしかない。
 * 画面全体の幅でレイアウトを切り替えていたため、書類番号の入力欄と「自動採番」ボタンが列に収まらず、
 * ボタンが枠の外に隠れていた。明細表も、単価・金額・削除ボタンが枠の外に隠れていた。
 * フォーム自身の幅（コンテナクエリ）で切り替える修正後、どの画面幅でも見切れないことを確かめる。
 */

const SLUGS = ["estimate-generator", "invoice-generator", "order-generator", "quote-order-generator"] as const;
const WIDTHS = [360, 480, 700, 768, 1024, 1280, 1440];

async function open(page: Page, slug: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/tools/${slug}`);
  await page.getByRole("button", { name: "自動採番" }).first().waitFor({ timeout: 60_000 });
}

/** 要素が、指定した外枠の内側に、全体が収まっていること */
async function expectInside(inner: Locator, outer: Locator, label: string) {
  const [i, o] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(i, `${label}: 表示されていない`).toBeTruthy();
  expect(o, `${label}: 外枠が表示されていない`).toBeTruthy();
  expect(i!.x, `${label}: 左にはみ出し`).toBeGreaterThanOrEqual(o!.x - 0.5);
  expect(i!.x + i!.width, `${label}: 右にはみ出し (${Math.round(i!.x + i!.width)} > ${Math.round(o!.x + o!.width)})`).toBeLessThanOrEqual(o!.x + o!.width + 0.5);
}

for (const slug of SLUGS) {
  test.describe(`${slug}: 書類番号・自動採番`, () => {
    for (const width of WIDTHS) {
      test(`幅${width}px: 入力欄とボタンが枠内に収まり、ボタンの文字が切れない`, async ({ page }) => {
        test.setTimeout(120_000);
        await open(page, slug, width);
        const button = page.getByRole("button", { name: "自動採番" }).first();
        const card = button.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]");
        const field = button.locator("xpath=ancestor::label[1]");
        const input = field.locator("input").first();
        await expectInside(button, card, "自動採番ボタン（フォームの枠）");
        await expectInside(button, field, "自動採番ボタン（項目の枠）");
        await expectInside(input, card, "書類番号の入力欄");
        // ボタンは折り返さず、文字が切れない（1行・文字幅が収まっている）
        const m = await button.evaluate((b) => ({ sw: b.scrollWidth, cw: b.clientWidth, h: b.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(b).lineHeight) || 16 }));
        expect(m.sw).toBeLessThanOrEqual(m.cw + 1);
        expect(m.h, "ボタンが2行に折り返している").toBeLessThan(m.lh * 2 + 8);
        // 入力欄が押しつぶされない（書類番号が読める幅）
        const box = await input.boundingBox();
        expect(box!.width, "書類番号の入力欄が狭すぎる").toBeGreaterThanOrEqual(120);
        // ページ全体の横スクロールが出ない
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      });
    }

    test("自動採番ボタンを押すと、書類番号が入る（既存の動作）", async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, slug, 1280);
      const button = page.getByRole("button", { name: "自動採番" }).first();
      const input = button.locator("xpath=ancestor::label[1]").locator("input").first();
      await expect(input).toHaveValue("");
      await expect(async () => {
        await button.click();
        await expect(input).not.toHaveValue("", { timeout: 1_500 });
      }).toPass({ timeout: 20_000 });
      expect(await input.inputValue()).toMatch(/\d{4}/);
    });

    for (const width of [360, 700, 820, 900, 1024, 1280]) {
      test(`幅${width}px: 明細の入力欄・金額・削除ボタンが枠内に収まる`, async ({ page }) => {
        test.setTimeout(120_000);
        await open(page, slug, width);
        const addBtn = page.getByRole("button", { name: "＋ 明細を追加" });
        const editor = addBtn.locator("xpath=..");
        await editor.scrollIntoViewIfNeeded();
        // 明細が2行になるまで（画面の準備ができるまで）押す
        await expect(async () => {
          if ((await editor.locator("input:visible").count()) < 8) await addBtn.click();
          expect(await editor.locator("input:visible").count()).toBeGreaterThanOrEqual(8);
        }).toPass({ timeout: 20_000 });
        // 表示されている（テーブル形式かカード形式の）入力欄・削除ボタンをすべて調べる
        const controls = editor.locator("input:visible, button:visible");
        const n = await controls.count();
        expect(n).toBeGreaterThan(8);
        const eb = (await editor.boundingBox())!;
        for (let i = 0; i < n; i++) {
          const b = await controls.nth(i).boundingBox();
          if (!b) continue;
          expect(b.x + b.width, `明細の${i}番目の部品が右にはみ出し`).toBeLessThanOrEqual(eb.x + eb.width + 1);
          expect(b.x, `明細の${i}番目の部品が左にはみ出し`).toBeGreaterThanOrEqual(eb.x - 1);
        }
        // 横スクロール領域が必要な状態になっていない
        const scrolls = await editor.evaluate((e) => [...e.querySelectorAll<HTMLElement>("*")].filter((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflowX !== "visible" && x.getBoundingClientRect().width > 0).length);
        expect(scrolls, "明細に横スクロールが必要").toBe(0);
        // 編集欄に十分な幅があるとき（画面が1列になる820〜900px）は、品名・単価・金額が1行に並ぶ表形式になる
        const rowInputs = editor.getByPlaceholder("商品名・作業内容");
        const priceInputs = editor.getByPlaceholder("0", { exact: true });
        const [nb, pb] = await Promise.all([rowInputs.first().boundingBox(), priceInputs.first().boundingBox()]);
        const tableLayout = Math.abs(nb!.y - pb!.y) < 4;
        expect(tableLayout, `幅${width}px の明細の並び（表形式=${tableLayout}）`).toBe(width === 820 || width === 900);
        // 削除できる（既存の動作）
        const before = await editor.locator("input:visible").count();
        await editor.getByRole("button", { name: /削除/ }).first().click();
        expect(await editor.locator("input:visible").count()).toBeLessThan(before);
      });
    }
  });
}
