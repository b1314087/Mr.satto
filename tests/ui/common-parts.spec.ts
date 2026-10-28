import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { clearDevOverrides, setDevAdOutcome } from "../helpers/dev-plan";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";

/**
 * UI刷新・第4工程（共通UI部品: ファイル選択欄・処理中表示・エラー表示・ダイアログ）のテスト。
 * 代表ツール: CSV重複削除（ファイル選択・選択解除・処理中→完了・エラー）、
 *            画像リサイズ（画像・広告確認ダイアログ）、CSV結合（複数ファイル）。
 *  1. ソース: 共通部品の仕様（accept・複数・サイズ制限）が残り、ファイルを送信する処理が無い
 *  2. ファイル選択欄: キーボード、ドラッグ＆ドロップ、形式エラー、選択解除、複数ファイル
 *  3. 処理中・完了・エラーの表示
 *  4. ダイアログ（広告確認）: フォーカス、Tab、Escape、背景クリック、スクロール停止、モバイル
 *  5. ライト／ダークの読みやすさ、視覚効果を減らす設定
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const main = (page: Page) => page.locator("main");
const dropzone = (page: Page) => page.locator('[role="button"][aria-describedby]:has(input[type="file"])').first();

type Rgb = [number, number, number];
const luminance = ([r, g, b]: Rgb) => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
async function colorsOf(page: Page, selector: string): Promise<{ fg: Rgb; bg: Rgb }> {
  return page.locator(selector).first().evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const toRgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    let bg: [number, number, number] = [255, 255, 255];
    const layers: [number, number, number, number][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) layers.push(toRgba(getComputedStyle(n).backgroundColor));
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const [r, g, b] = toRgba(getComputedStyle(el).color);
    return { fg: [r, g, b] as Rgb, bg };
  });
}

/** ファイルをドラッグ中の状態にする／ドロップする（実際のドラッグ操作と同じイベントを送る） */
async function dragEvent(page: Page, type: "dragover" | "dragleave" | "drop", file?: { name: string; mime: string; content: string }) {
  await dropzone(page).evaluate(
    (el, { type, file }) => {
      const dt = new DataTransfer();
      if (file) dt.items.add(new File([file.content], file.name, { type: file.mime }));
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { type, file }
  );
}

async function gotoTool(page: Page, id: string) {
  await page.goto(`/tools/${id}`);
  await expect(dropzone(page)).toBeVisible({ timeout: 30_000 });
  await waitForFileInputHydrated(page);
}

// ===========================================================================
// 1. ソース（仕様が残っていること・ファイルを送信しないこと）
// ===========================================================================
test.describe("共通部品のソース", () => {
  test("FileDropzone: props（accept・multiple・maxSizeMB・label・hint・onFilesSelected・onError）と形式・サイズの検査が残っている", () => {
    const src = read("src/components/common/file-dropzone.tsx");
    for (const p of ["accept?: string", "multiple?: boolean", "maxSizeMB?: number", "label?: string", "hint?: string", "onFilesSelected", "onError?"])
      expect(src).toContain(p);
    expect(src).toContain("maxSizeMB = 50");
    expect(src).toContain("matchesAccept");
    expect(src).toContain("このファイル形式には対応していません");
    expect(src).toContain("ファイルサイズが大きすぎます");
    expect(src).toContain("multiple ? files : [files[0]]");
    // hiddenな<input type="file">を持つ構造（既存のテスト・ヘルパーが前提にしている）
    expect(src).toContain('type="file"');
    expect(src).toContain('className="hidden"');
    // 同じファイルを続けて選び直せる（FilePickButton と同じ、取り出してから入力欄を空に戻す方式）
    expect(src).toContain('e.target.value = ""');
    expect(src.indexOf("Array.from(e.target.files")).toBeLessThan(src.indexOf('e.target.value = ""'));
    // 空に戻したあとに、取り出したファイルを検査・通知する（空に戻すことで選択が失われない）
    expect(src.indexOf('e.target.value = ""')).toBeLessThan(src.indexOf("validateAndEmit(files)"));
  });

  test("共通部品（ファイル選択・Modal・Spinner・処理中表示）にファイルを送信する処理がない", () => {
    for (const f of [
      "src/components/common/file-dropzone.tsx",
      "src/components/common/file-list.tsx",
      "src/components/common/file-preview.tsx",
      "src/components/common/processing-status.tsx",
      "src/components/ui/modal.tsx",
      "src/components/ui/spinner.tsx",
    ])
      expect(read(f), f).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|FormData|WebSocket/);
  });

  test("処理中表示: 進捗率（見せかけの％）を出さず、スクリーンリーダーにも状態が伝わる", () => {
    const src = read("src/components/common/processing-status.tsx");
    expect(src).not.toMatch(/%|progress|percent/i);
    expect(src.match(/<div role="status"/g)).toHaveLength(2);
    expect(src).toContain("<Spinner");
    expect(read("src/components/ui/spinner.tsx")).toContain('aria-hidden="true"');
  });

  test("広告確認ダイアログ: 共通Modalを使い、Escapeは処理中（busy）だけ閉じない。背景クリックでは閉じない", () => {
    const src = read("src/components/ads/download-gate-provider.tsx");
    expect(src).toContain("<Modal");
    expect(src).toContain('onEscape={phase === "busy" ? undefined : close}');
    expect(src).not.toContain("onBackdropClick");
    for (const id of ["download-gate-overlay", "download-gate-dialog", "download-gate-title"]) expect(src).toContain(id);
    // 広告の挙動（要求のタイミング）に関わる処理は残っている
    for (const word of ["handleWatchAd", "requestInFlightRef", "rewardEarnedRef", "queueRef"]) expect(src).toContain(word);
  });
});

// ===========================================================================
// 2. ファイル選択欄
// ===========================================================================
test.describe("ファイル選択欄（CSV重複削除で確認）", () => {
  test("役割・名前・説明が付いている（role=button / aria-label / aria-describedby）。入力欄の accept が維持されている", async ({ page }) => {
    await gotoTool(page, "csv-dedupe");
    const zone = dropzone(page);
    await expect(zone).toHaveAttribute("tabindex", "0");
    await expect(zone).toHaveAttribute("aria-label", "CSVファイルをドラッグ&ドロップ");
    const hintId = await zone.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${hintId}"]`)).toHaveText("またはタップして選択");
    await expect(zone.locator('input[type="file"]')).toHaveAttribute("accept", ".csv,text/csv");
    expect(await zone.locator('input[type="file"]').getAttribute("multiple")).toBeNull();
  });

  test("キーボード: Tabでフォーカス → EnterでもSpaceでも選択画面が開く。Spaceでページがスクロールしない", async ({ page }) => {
    await gotoTool(page, "csv-dedupe");
    const zone = dropzone(page);
    await zone.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(zone).toBeFocused();
    const ring = await zone.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(ring).toEqual({ style: "solid", width: "2px" });

    for (const key of ["Enter", "Space"]) {
      const before = await page.evaluate(() => window.scrollY);
      const chooser = page.waitForEvent("filechooser");
      await page.keyboard.press(key);
      expect(await chooser, `${key}でファイル選択が開かない`).toBeTruthy();
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
    }
  });

  test("ボタン操作: ファイルを選ぶと名前とサイズが出る。選択を解除（×）できる", async ({ page }) => {
    await gotoTool(page, "csv-dedupe");
    await uploadFixture(page, fixtures.csv);
    const item = page.locator("li", { has: page.getByText("sample.csv") });
    await expect(item).toBeVisible();
    await expect(item).toContainText(/\d+(\.\d+)?\s?(B|KB)/);
    const remove = item.getByRole("button", { name: "sample.csv を削除" });
    const box = await remove.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(32);
    expect(box!.height).toBeGreaterThanOrEqual(32);
    await remove.click();
    await expect(page.getByText("sample.csv")).toHaveCount(0);
  });

  test("ドラッグ＆ドロップ: ドラッグ中は枠が実線＋文言が変わり、離れると戻る。ドロップで選択される", async ({ page }) => {
    await gotoTool(page, "csv-dedupe");
    const zone = dropzone(page);
    const csv = { name: "dropped.csv", mime: "text/csv", content: "a,b\n1,2\n1,2\n" };
    await dragEvent(page, "dragover", csv);
    await expect(zone).toHaveAttribute("data-dragging", "true");
    await expect(zone).toContainText("ここでマウスを離すと選択されます");
    expect(await zone.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
    await dragEvent(page, "dragleave");
    await expect(zone).not.toHaveAttribute("data-dragging", "true");
    expect(await zone.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");

    await dragEvent(page, "dragover", csv);
    await dragEvent(page, "drop", csv);
    await expect(zone).not.toHaveAttribute("data-dragging", "true");
    await expect(page.locator("li", { has: page.getByText("dropped.csv") })).toBeVisible();
  });

  test("対応していない形式をドロップすると、ファイルは選ばれず、エラーが表示される（既存のエラー文言）", async ({ page }) => {
    await gotoTool(page, "csv-dedupe");
    await dragEvent(page, "drop", { name: "photo.png", mime: "image/png", content: "x" });
    const alert = main(page).locator('[role="alert"]');
    await expect(alert).toContainText("このファイル形式には対応していません（photo.png）");
    await expect(page.getByText("photo.png", { exact: false }).first()).toBeVisible(); // エラー文中のみ
    await expect(page.locator("li", { has: page.getByText("photo.png") })).toHaveCount(0);
  });

  test("複数ファイル対応のツール（CSV結合）: 入力欄が multiple で、複数のファイルを選べる", async ({ page }) => {
    await gotoTool(page, "csv-merge");
    await expect(dropzone(page).locator('input[type="file"]')).toHaveAttribute("multiple", "");
    await uploadFixture(page, [fixtures.csv, fixtures.csvForMerge]);
    await expect(page.getByText("sample.csv", { exact: true })).toBeVisible();
    await expect(page.getByText("sample-merge.csv", { exact: true })).toBeVisible();
  });
});

// ===========================================================================
// 3. 処理中・完了・エラー
// ===========================================================================
test.describe("処理中・完了・エラーの表示", () => {
  test("実行 → 完了表示（role=status・チェックマーク・文言）。結果と作業ボタンが出る", async ({ page }) => {
    await gotoTool(page, "csv-dedupe");
    await uploadFixture(page, fixtures.csv);
    const run = main(page).getByRole("button", { name: /重複を削除|実行|削除する/ }).first();
    await run.click();
    const status = main(page).locator('[role="status"]', { hasText: "重複削除が完了しました" });
    await expect(status).toBeVisible({ timeout: 30_000 });
    expect(await status.locator("svg").count()).toBe(1); // 色だけでなくチェックマークでも伝える
  });

  test("スピナーは .ms-spinner の1つの見た目に統一され、動きを減らす設定では回らない", async ({ page }) => {
    for (const [motion, expected] of [["no-preference", "ms-spin"], ["reduce", "none"]] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      await page.goto("/");
      const name = await page.evaluate(() => {
        const el = document.createElement("span");
        el.className = "ms-spinner";
        document.body.appendChild(el);
        const out = { anim: getComputedStyle(el).animationName, w: getComputedStyle(el).width };
        el.remove();
        return out;
      });
      expect(name.anim, motion).toBe(expected);
      expect(name.w).not.toBe("0px");
    }
  });
});

// ===========================================================================
// 4. ダイアログ（広告確認）
// ===========================================================================
test.describe("広告確認ダイアログ", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await clearDevOverrides(context);
    await setDevAdOutcome(context, "granted", baseURL!);
  });

  async function openGate(page: Page) {
    await gotoTool(page, "image-resize");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");
    const opener = page.getByRole("button", { name: "ダウンロード" });
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "ダウンロードの前に広告をご覧ください" });
    await expect(dialog).toBeVisible();
    return { opener, dialog };
  }

  test("開く: フォーカスが主要ボタンへ移り、背景がスクロールしない。role・aria-modal・見出しの紐づけがある", async ({ page }) => {
    const { dialog } = await openGate(page);
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", "download-gate-title");
    await expect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeFocused();
    await expect(page.locator("html")).toHaveClass(/ms-scroll-lock/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
  });

  test("Tab / Shift+Tab を繰り返してもダイアログの外へ出ない", async ({ page }) => {
    const { dialog } = await openGate(page);
    const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${i + 1}`).toBe(true);
    }
    await expect(dialog).toBeVisible();
  });

  test("Escapeで閉じ、フォーカスが開いたボタンへ戻り、背景のスクロール停止も解除される", async ({ page }) => {
    const { opener, dialog } = await openGate(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    // 背後の完了ポップアップがまだ開いているので、背景のスクロール停止は続く。それも閉じると解除される
    await expect(page.locator("html")).toHaveClass(/ms-scroll-lock/);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("result-popup")).toBeHidden();
    await expect(page.locator("html")).not.toHaveClass(/ms-scroll-lock/);
  });

  test("背景（暗い部分）のクリックでは閉じない（誤タップで確認画面が消えない）。キャンセルボタンでは閉じる", async ({ page }) => {
    const { dialog } = await openGate(page);
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();
  });

  test("広告視聴 → 「ダウンロードする」まで従来どおり進み、ファイルが保存される", async ({ page }) => {
    const { dialog } = await openGate(page);
    await dialog.getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(page.getByTestId("download-gate-dialog")).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    const dl = page.waitForEvent("download");
    await page.getByTestId("download-gate-dialog").getByRole("button", { name: /ダウンロードする/ }).click();
    expect((await dl).suggestedFilename()).toMatch(/\.png$/i);
    await expect(page.getByTestId("download-gate-dialog")).toHaveCount(0);
  });

  test("スマホ幅: ダイアログが画面内に収まり、横スクロールがなく、ボタンは縦に並んで押しやすい", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const { dialog } = await openGate(page);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    for (const name of ["広告を見てダウンロード", "キャンセル"]) {
      const b = await dialog.getByRole("button", { name }).boundingBox();
      expect(b!.height).toBeGreaterThanOrEqual(36);
      expect(b!.x + b!.width).toBeLessThanOrEqual(360);
    }
  });

  test("サイトメニュー（ハンバーガー）は従来どおり開閉でき、ダイアログとは別に動く", async ({ page }) => {
    await page.goto("/");
    const menuButton = page.getByRole("button", { name: "メニューを開く" });
    const menu = page.getByRole("dialog", { name: "メニュー" });
    await expect(async () => {
      await menuButton.click();
      await expect(menu).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(menuButton).toBeFocused();
  });
});

// ===========================================================================
// 5. ライト／ダーク
// ===========================================================================
for (const scheme of ["light", "dark"] as const) {
  test.describe(`見た目（${scheme}）`, () => {
    test.use({ colorScheme: scheme });

    test("ファイル選択欄・エラー・完了の文字が読め、ファイル選択欄の枠が背景に埋もれない", async ({ page }) => {
      await gotoTool(page, "csv-dedupe");
      for (const sel of ['[role="button"][aria-describedby] p:first-of-type', '[role="button"][aria-describedby] p:last-of-type']) {
        const { fg, bg } = await colorsOf(page, sel);
        expect(contrast(fg, bg), sel).toBeGreaterThanOrEqual(4.5);
      }
      // 枠（破線）と背景の差（UI部品の境界: 目安 1.6 以上）
      const edge = await dropzone(page).evaluate((el) => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
        const rgb = (c: string) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000";
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], d[3] / 255];
        };
        const s = getComputedStyle(el);
        const page = rgb(getComputedStyle(document.body).backgroundColor);
        const b = rgb(s.borderTopColor);
        const over = [0, 1, 2].map((i) => b[i] * b[3] + page[i] * (1 - b[3]));
        return { border: over, page: page.slice(0, 3) };
      });
      expect(contrast(edge.border as Rgb, edge.page as Rgb)).toBeGreaterThanOrEqual(1.6);

      // エラー表示
      await dragEvent(page, "drop", { name: "bad.png", mime: "image/png", content: "x" });
      const alertSel = 'main [role="alert"] span';
      await expect(page.locator(alertSel)).toBeVisible();
      const { fg, bg } = await colorsOf(page, alertSel);
      expect(contrast(fg, bg), "エラー文").toBeGreaterThanOrEqual(4.5);
      expect(await page.locator('main [role="alert"] svg').count()).toBe(1); // アイコンでも伝える（色だけに頼らない）
    });

    test("広告確認ダイアログの文字・ボタンが読める（見出し・説明・主ボタン・副ボタン）", async ({ page, context, baseURL }) => {
      await clearDevOverrides(context);
      await setDevAdOutcome(context, "granted", baseURL!);
      await gotoTool(page, "image-resize");
      await uploadFixture(page, fixtures.png);
      await page.getByRole("button", { name: "リサイズする" }).click();
      await waitForSuccess(page, "完了");
      await page.getByRole("button", { name: "ダウンロード" }).click();
      await expect(page.getByTestId("download-gate-dialog")).toBeVisible();
      for (const sel of [
        '[data-testid="download-gate-dialog"] h2',
        '[data-testid="download-gate-dialog"] p',
        '[data-testid="download-gate-dialog"] button:has-text("広告を見てダウンロード")',
        '[data-testid="download-gate-dialog"] button:has-text("キャンセル")',
      ]) {
        const { fg, bg } = await colorsOf(page, sel);
        expect(contrast(fg, bg), sel).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}
