import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";

/**
 * 連番・項目一括生成（/tools/sequence-generator）のE2Eテスト。
 * 計算の細かい規則は tests/sequence/sequence.spec.ts（単体）で確認している。ここでは画面の操作を確認する。
 */

const SLUG = "/tools/sequence-generator";
const SP = "　";

async function open(page: Page) {
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "連番・項目一括生成" })).toBeVisible();
  // Reactの準備(hydration)が終わるまで待つ
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="seq-item"]');
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  });
}

const result = (page: Page) => page.getByTestId("seq-result");
const lines = async (page: Page) => (await result(page).inputValue()).split("\n");

async function goMultiple(page: Page, text: string) {
  await page.getByTestId("seq-mode-multiple").click();
  await page.getByTestId("seq-multi-input").fill(text);
}

test.describe("連番・項目一括生成: 画面", () => {
  test("初期表示（単一項目）: 英語 / 1〜10 / 第○回 / 全角で10行が出る", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("seq-mode-single")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("seq-style-dai-kai")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("seq-width-full")).toHaveAttribute("aria-pressed", "true");
    const got = await lines(page);
    expect(got).toHaveLength(10);
    expect(got[0]).toBe(`第１回${SP}英語`);
    expect(got[9]).toBe(`第１０回${SP}英語`);
    await expect(page.getByTestId("seq-count")).toHaveText("10行");
    await expect(page.getByTestId("tool-preview")).toBeVisible();
  });

  test("単一項目: 項目名・開始・終了が反映される（全角の数字も可）", async ({ page }) => {
    await open(page);
    await page.getByTestId("seq-item").fill("数学");
    await page.getByTestId("seq-start").fill("３");
    await page.getByTestId("seq-end").fill("5");
    expect(await lines(page)).toEqual([`第３回${SP}数学`, `第４回${SP}数学`, `第５回${SP}数学`]);
  });

  test("表示形式と全角・半角の切り替えで、項目・件数・順序は変わらない", async ({ page }) => {
    await open(page);
    await goMultiple(page, "英語\n英語\n国語\n英語");
    await page.getByTestId("seq-width-half").click();
    expect(await lines(page)).toEqual([`第1回${SP}英語`, `第2回${SP}英語`, `第1回${SP}国語`, `第3回${SP}英語`]);
    await page.getByTestId("seq-style-kai-me").click();
    expect(await lines(page)).toEqual([`1回目${SP}英語`, `2回目${SP}英語`, `1回目${SP}国語`, `3回目${SP}英語`]);
    await page.getByTestId("seq-style-plain").click();
    expect(await lines(page)).toEqual([`1${SP}英語`, `2${SP}英語`, `1${SP}国語`, `3${SP}英語`]);
    await page.getByTestId("seq-width-full").click();
    expect(await lines(page)).toEqual([`１${SP}英語`, `２${SP}英語`, `１${SP}国語`, `３${SP}英語`]);
  });

  test("複数項目: 指示書の例どおりに、入力順・項目ごとの連番が出る。空行は無視する", async ({ page }) => {
    await open(page);
    await goMultiple(page, "英語\n英語\n\n国語\n英語\n数学\n国語");
    expect(await lines(page)).toEqual([
      `第１回${SP}英語`,
      `第２回${SP}英語`,
      `第１回${SP}国語`,
      `第３回${SP}英語`,
      `第１回${SP}数学`,
      `第２回${SP}国語`,
    ]);
    await expect(page.getByTestId("seq-blank-note")).toContainText("空行1行");
  });

  test("空入力・不正な数値では、案内を出してコピーできない", async ({ page }) => {
    await open(page);
    await page.getByTestId("seq-mode-multiple").click();
    await expect(page.getByTestId("seq-message")).toContainText("項目を1行に1つずつ入力してください");
    await expect(page.getByTestId("seq-copy")).toBeDisabled();
    await expect(result(page)).toHaveValue("");
    await page.getByTestId("seq-mode-single").click();
    await page.getByTestId("seq-start").fill("abc");
    await expect(page.getByTestId("seq-message")).toContainText("開始番号は、0以上の整数");
    await expect(page.getByTestId("seq-copy")).toBeDisabled();
    await page.getByTestId("seq-start").fill("9");
    await page.getByTestId("seq-end").fill("2");
    await expect(page.getByTestId("seq-message")).toContainText("開始番号は終了番号以下にしてください");
    await page.getByTestId("seq-start").fill("1");
    await page.getByTestId("seq-item").fill("");
    await expect(page.getByTestId("seq-message")).toContainText("項目名を入力してください");
    await page.getByTestId("seq-item").fill("英語");
    await expect(page.getByTestId("seq-message")).toHaveCount(0);
    await expect(page.getByTestId("seq-copy")).toBeEnabled();
  });

  test("コピー: 全結果が1行1項目でコピーされ、「コピーしました」と通知される", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page);
    await page.getByTestId("seq-end").fill("3");
    await page.getByTestId("seq-copy").click();
    await expect(page.getByTestId("seq-copy")).toHaveText("コピーしました");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe([`第１回${SP}英語`, `第２回${SP}英語`, `第３回${SP}英語`].join("\n"));
  });

  test("手動編集: 編集した結果がそのままコピーされ、入力や設定を変えても勝手に上書きされない。作り直しで元に戻せる", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page);
    await goMultiple(page, "英語\n英語\n国語");
    const edited = [`第１回${SP}英語（修正）`, `第２回${SP}英語`, `第９回${SP}国語`, `追加の行`].join("\n");
    await result(page).fill(edited);
    await expect(page.getByTestId("seq-edited-note")).toContainText("手動で編集した結果です");
    await page.getByTestId("seq-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(edited);
    // 表示形式を変えても、入力を変えても、編集した結果は残る（案内が出る）
    await page.getByTestId("seq-style-kai-me").click();
    await page.getByTestId("seq-multi-input").fill("英語\n英語\n国語\n数学");
    await expect(result(page)).toHaveValue(edited);
    await expect(page.getByTestId("seq-edited-note")).toContainText("入力や設定が変わりました");
    await page.getByTestId("seq-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(edited);
    // 単一項目に切り替えても、そちらの結果には影響しない。戻ると編集は残っている
    await page.getByTestId("seq-mode-single").click();
    expect((await lines(page))[0]).toBe(`１回目${SP}英語`);
    await expect(page.getByTestId("seq-edited-note")).toHaveCount(0);
    await page.getByTestId("seq-mode-multiple").click();
    await expect(result(page)).toHaveValue(edited);
    // 「入力から作り直す」で最新の入力から再生成される
    await page.getByTestId("seq-reset").click();
    expect(await lines(page)).toEqual([`１回目${SP}英語`, `２回目${SP}英語`, `１回目${SP}国語`, `１回目${SP}数学`]);
    await expect(page.getByTestId("seq-edited-note")).toHaveCount(0);
  });

  test("手動編集: 編集して自動生成と同じ文字に戻すと、編集済みの扱いではなくなる", async ({ page }) => {
    await open(page);
    const original = await result(page).inputValue();
    await result(page).fill("書き換え");
    await expect(page.getByTestId("seq-edited-note")).toBeVisible();
    await result(page).fill(original);
    await expect(page.getByTestId("seq-edited-note")).toHaveCount(0);
    await page.getByTestId("seq-end").fill("2");
    expect(await lines(page)).toHaveLength(2);
  });

  test("通信: 入力・生成・コピーの間、入力した内容をサーバーや外部へ送らない", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const recorder = new NetworkRecorder(page);
    await open(page);
    const marker = "秘密の項目名ZZ9";
    await page.getByTestId("seq-item").fill(marker);
    await goMultiple(page, `${marker}\n${marker}\n別項目`);
    await page.getByTestId("seq-copy").click();
    await expect(page.getByTestId("seq-copy")).toHaveText("コピーしました");
    const origin = new URL(page.url()).origin;
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
    expect(findSuspiciousApiUploads(recorder, origin, [], 1)).toEqual([]);
    // 入力した文字を含むリクエスト（URL・本文）がない
    expect(recorder.requests.filter((r) => r.url.includes(encodeURIComponent(marker)) || (r.bodyText ?? "").includes(marker))).toEqual([]);
    // 外部サイトへの fetch/XHR/beacon がない
    expect(recorder.requests.filter((r) => !r.url.startsWith(origin) && ["fetch", "xhr", "ping", "websocket", "eventsource"].includes(r.resourceType))).toEqual([]);
  });
});

test.describe("連番・項目一括生成: スマートフォン幅", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("操作でき、結果が多くても画面が横にはみ出さない", async ({ page }) => {
    await open(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);
    // 大量の結果と長い項目名
    await page.getByTestId("seq-item").fill("とても長い項目名".repeat(12));
    await page.getByTestId("seq-end").fill("1000");
    await expect(page.getByTestId("seq-count")).toHaveText("1000行");
    expect(await overflow()).toBeLessThanOrEqual(1);
    await page.getByTestId("seq-mode-multiple").click();
    await page.getByTestId("seq-multi-input").fill(Array.from({ length: 300 }, (_, i) => `項目${i % 7}`).join("\n"));
    await page.getByTestId("seq-style-kai-me").click();
    await page.getByTestId("seq-width-half").click();
    await expect(page.getByTestId("seq-count")).toHaveText("300行");
    expect(await overflow()).toBeLessThanOrEqual(1);
    // 入力欄・結果欄・コピーのボタンが、画面の幅の内側にある
    for (const id of ["seq-multi-input", "seq-result", "seq-copy"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.x, id).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, id).toBeLessThanOrEqual(375 + 1);
    }
    await page.getByTestId("seq-copy").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("seq-copy")).toBeEnabled();
  });
});
