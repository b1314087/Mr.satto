import fs from "node:fs";
import path from "node:path";
import { resolveObjectURL } from "node:buffer";
import { test, expect, type Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { uploadFixture } from "../helpers/tool-runner";
import { acquireObjectUrl, releaseObjectUrl, retainObjectUrl } from "../../src/lib/utils/use-object-url";

/**
 * UI刷新・第5工程のテスト。
 *  A. ソース: 共通のファイル選択ボタン（FilePickButton）と、Object URLの共通フックの方針
 *  B. Object URL の寿命管理（Strict Mode の「後始末→再セットアップ」を再現）
 *  C. 画像プレビューがブラウザ（開発モード＝Strict Mode）で壊れない・切り替わる・解放される
 *  D. 独自ファイル入力だった3ツール: QR作成（マーク画像）／電子印鑑（フォント）／年度カレンダー（予定表）
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// A. ソース
// ===========================================================================
test.describe("A. ソース", () => {
  test("FilePickButton: 共通Buttonを使い、ファイルを送信する処理を持たず、検査は呼び出し側に任せる", () => {
    const src = read("src/components/common/file-pick-button.tsx");
    expect(src).toContain('from "@/components/ui/button"');
    expect(src).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|FormData|WebSocket/);
    expect(src).toContain('e.target.value = ""'); // 同じファイルを選び直せる
    expect(src).toContain("onFilesSelected");
  });

  test("3ツールは独自の <input type=\"file\"> を持たず、共通のFilePickButton／FileDropzoneを使う", () => {
    for (const f of [
      "src/components/tools/implementations/qr-generator-tool.tsx",
      "src/components/tools/implementations/electronic-stamp-generator-tool.tsx",
      "src/components/tools/implementations/shared/fiscal-calendar-events-import.tsx",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/<input[^>]*type="file"/);
    }
    expect(read("src/components/tools/implementations/qr-generator-tool.tsx")).toContain("<FilePickButton");
    expect(read("src/components/tools/implementations/electronic-stamp-generator-tool.tsx")).toContain("<FilePickButton");
    expect(read("src/components/tools/implementations/shared/fiscal-calendar-events-import.tsx")).toContain("<FilePickButton");
  });

  test("既存仕様（受け付ける形式・複数可否・検査）が維持されている", () => {
    expect(read("src/components/tools/implementations/qr-generator-tool.tsx")).toContain('accept="image/*"');
    expect(read("src/components/tools/implementations/electronic-stamp-generator-tool.tsx")).toContain(
      'accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"'
    );
    const fiscal = read("src/components/tools/implementations/shared/fiscal-calendar-events-import.tsx");
    expect(fiscal).toContain("accept={EVENT_FILE_ACCEPT}");
    expect(fiscal).toMatch(/<FilePickButton[\s\S]*?multiple/);
    // 既存の検査・エラー文言が残っている
    for (const w of ["LEGACY_EXCEL_MESSAGE", "UNSUPPORTED_FILE_MESSAGE", "一度に選べるのは", "10MBまで", "30MBまで"]) expect(fiscal).toContain(w);
    // 送信処理を持ち込んでいない（AI読み取りの既存の同意フローは別ファイル）
    expect(fiscal).not.toMatch(/fetch\(|FormData/);
    for (const f of ["qr-generator-tool.tsx", "electronic-stamp-generator-tool.tsx"]) {
      expect(read(`src/components/tools/implementations/${f}`), f).not.toMatch(/fetch\(\s*[^)d]|FormData/);
    }
  });

  test("Object URLを「レンダー中に作り、Effectの後始末で破棄」する壊れやすい書き方が、共通フックに置き換わっている", () => {
    const files = [
      "src/components/common/file-preview.tsx",
      "src/components/tools/implementations/shared/image-live-preview.ts",
      "src/components/tools/implementations/image-adjust-tool.tsx",
      "src/components/tools/implementations/background-remover-tool.tsx",
      "src/components/tools/implementations/image-canvas-tool.tsx",
      "src/components/tools/implementations/pptx-invert-tool.tsx",
      "src/components/tools/implementations/file-unzip-tool.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/useMemo\([^)]*createObjectURL/);
      expect(src, f).not.toMatch(/useEffect\([\s\S]{0,80}revokeObjectURL\(\s*(url|originalUrl)\s*\)/);
    }
    for (const f of ["src/components/common/file-preview.tsx", "src/components/tools/implementations/shared/image-live-preview.ts", "src/components/tools/implementations/file-unzip-tool.tsx", "src/components/tools/implementations/pptx-invert-tool.tsx"]) {
      expect(read(f), f).not.toContain("revokeObjectURL");
    }
    const hook = read("src/lib/utils/use-object-url.ts");
    expect(hook).toContain("revokeObjectURL"); // 解放は共通フックだけが担当する
    expect(hook).not.toMatch(/fetch\(|FormData|reactStrictMode/);
  });

  test("Strict Modeは無効化されていない", () => {
    expect(read("next.config.ts")).not.toMatch(/reactStrictMode\s*:\s*false/);
  });
});

// ===========================================================================
// B. Object URL の寿命管理
// ===========================================================================
test.describe("B. Object URLの寿命管理（フックの中核ロジック）", () => {
  const blob = (s: string) => new Blob([s], { type: "text/plain" });
  const alive = (url: string) => resolveObjectURL(url) !== undefined;

  test("同じBlobには同じURL、違うBlobには違うURLを返す（レンダーが二重に走っても作りすぎない）", () => {
    const a = blob("a");
    const u1 = acquireObjectUrl(a);
    expect(acquireObjectUrl(a)).toBe(u1);
    expect(acquireObjectUrl(blob("b"))).not.toBe(u1);
    retainObjectUrl(a);
    releaseObjectUrl(a);
  });

  test("Strict Modeの「後始末→再セットアップ」では破棄されず、使い続けられる", async () => {
    const a = blob("strict");
    const url = acquireObjectUrl(a);
    retainObjectUrl(a); // 1回目のセットアップ
    releaseObjectUrl(a); // Strict Modeの後始末
    retainObjectUrl(a); // 再セットアップ
    await tick();
    expect(alive(url)).toBe(true);
    expect(acquireObjectUrl(a)).toBe(url);
    releaseObjectUrl(a);
    await tick();
    expect(alive(url)).toBe(false); // 本当に使い終わったら解放される
  });

  test("使い終わったURLは必ず解放される。同じBlobを後でまた使えば、新しいURLが作られる", async () => {
    const a = blob("done");
    const url = acquireObjectUrl(a);
    retainObjectUrl(a);
    expect(alive(url)).toBe(true);
    releaseObjectUrl(a);
    await tick();
    expect(alive(url)).toBe(false);
    const again = acquireObjectUrl(a);
    expect(again).not.toBe(url);
    expect(alive(again)).toBe(true);
    retainObjectUrl(a);
    releaseObjectUrl(a);
    await tick();
    expect(alive(again)).toBe(false);
  });

  test("2か所で使っている間は、片方が外れても解放されない", async () => {
    const a = blob("shared");
    const url = acquireObjectUrl(a);
    retainObjectUrl(a);
    retainObjectUrl(a);
    releaseObjectUrl(a);
    await tick();
    expect(alive(url)).toBe(true);
    releaseObjectUrl(a);
    await tick();
    expect(alive(url)).toBe(false);
  });

  test("余計な解放（使っていないBlobのrelease）で例外にならず、使用数がマイナスにならない", async () => {
    const a = blob("extra");
    releaseObjectUrl(a); // 未登録
    const url = acquireObjectUrl(a);
    releaseObjectUrl(a);
    releaseObjectUrl(a);
    retainObjectUrl(a);
    await tick();
    expect(alive(url)).toBe(true);
    releaseObjectUrl(a);
    await tick();
  });
});

// ===========================================================================
// C. ブラウザ（開発モード＝Strict Mode）での画像プレビュー
// ===========================================================================
async function gotoTool(page: Page, id: string) {
  await page.goto(`/tools/${id}`);
  await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
  await waitForFileInputHydrated(page);
}
/** 「自分の画像」を選ぶまでファイル入力が出ないツール（QR作成）用 */
async function gotoToolWithButton(page: Page, id: string, buttonName: string) {
  await page.goto(`/tools/${id}`);
  const button = page.getByRole("button", { name: buttonName });
  await expect(async () => {
    await button.click();
    await expect(page.getByRole("button", { name: /画像を選ぶ/ })).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 30_000 });
}
const thumb = (page: Page, name: string) => page.locator(`img[alt="${name}"]`);
async function expectImageLoaded(img: ReturnType<typeof thumb>) {
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { timeout: 15_000 })
    .toBe(true);
}
// blob: への fetch はCSP（connect-src）で止まるため、画像として読み込めるかで「まだ有効なURLか」を調べる
const urlAlive = (page: Page, src: string) =>
  page.evaluate(
    (u) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = u;
      }),
    src
  );
const appAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
/** Tabキーでフォーカスを当てる（プログラムからの focus() ではフォーカス表示が出ない場合があるため） */
async function focusByKeyboard(locator: ReturnType<Page["locator"]>, page: Page) {
  await locator.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(locator).toBeFocused();
}
const hasFocusIndicator = (locator: ReturnType<Page["locator"]>) =>
  locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
  });

test.describe("C. 画像プレビュー（開発モード）", () => {
  test("ファイル選択直後にサムネイルが表示される（壊れた画像にならない）", async ({ page }) => {
    await gotoTool(page, "image-resize");
    await uploadFixture(page, fixtures.png);
    await expectImageLoaded(thumb(page, "sample.png"));
  });

  test("ファイルを替えると新しいプレビューに切り替わり、古い画像は表示されず、古いURLは解放される", async ({ page }) => {
    await gotoTool(page, "image-resize");
    await uploadFixture(page, fixtures.png);
    const first = thumb(page, "sample.png");
    await expectImageLoaded(first);
    const oldSrc = (await first.getAttribute("src"))!;
    expect(oldSrc).toMatch(/^blob:/);
    expect(await urlAlive(page, oldSrc)).toBe(true);

    await uploadFixture(page, fixtures.jpg);
    const second = thumb(page, "sample.jpg");
    await expectImageLoaded(second);
    await expect(thumb(page, "sample.png")).toHaveCount(0);
    const newSrc = (await second.getAttribute("src"))!;
    expect(newSrc).not.toBe(oldSrc);
    await expect.poll(() => urlAlive(page, oldSrc), { timeout: 10_000 }).toBe(false);
    expect(await urlAlive(page, newSrc)).toBe(true);
  });

  test("選択を解除（×）するとプレビューが消え、URLが解放される", async ({ page }) => {
    await gotoTool(page, "image-resize");
    await uploadFixture(page, fixtures.png);
    const img = thumb(page, "sample.png");
    await expectImageLoaded(img);
    const src = (await img.getAttribute("src"))!;
    await page.getByRole("button", { name: "sample.png を削除" }).click();
    await expect(img).toHaveCount(0);
    await expect.poll(() => urlAlive(page, src), { timeout: 10_000 }).toBe(false);
  });

  test("別のページへ移動してもURLの解放で例外が出ない（コンソールエラーなし）", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await gotoTool(page, "image-resize");
    await uploadFixture(page, fixtures.png);
    await expectImageLoaded(thumb(page, "sample.png"));
    await page.getByRole("link", { name: /ツール一覧|すべてのツール/ }).first().click().catch(() => page.goto("/tools"));
    await page.waitForURL(/\/tools/);
    expect(errors).toEqual([]);
  });

  test("同じ共通フックを使う画像ツール（明るさ調整）の「元の画像」も表示される", async ({ page }) => {
    await gotoTool(page, "image-adjust");
    await uploadFixture(page, fixtures.png);
    const img = page.locator('img[alt="元の画像"]').first();
    await expect(img).toBeVisible({ timeout: 20_000 });
    await expectImageLoaded(img);
  });
});

// ===========================================================================
// D. 独自ファイル入力だった3ツール
// ===========================================================================
test.describe("D-1. QR作成: マーク画像", () => {
  async function openCustomMark(page: Page) {
    await gotoToolWithButton(page, "qr-generator", "自分の画像");
    return page.getByRole("button", { name: "画像を選ぶ" });
  }

  test("キーボードで操作できる（Tabでフォーカス → Enter／Spaceで選択画面が開く）。フォーカスが見える", async ({ page }) => {
    const pick = await openCustomMark(page);
    await focusByKeyboard(pick, page);
    expect(await hasFocusIndicator(pick)).toBe(true);
    for (const key of ["Enter", "Space"]) {
      const chooser = page.waitForEvent("filechooser");
      await page.keyboard.press(key);
      expect(await chooser, key).toBeTruthy();
    }
  });

  test("画像を選ぶと二次元コードに反映され、ボタンの文言が「別の画像を選ぶ」になる。同じ画像を選び直せる", async ({ page }) => {
    await openCustomMark(page);
    await page.locator("textarea").fill("https://example.com/");
    await expect(page.getByText("画像を選ぶと二次元コードに表示されます。")).toBeVisible();
    await page.getByLabel("マークにする画像").setInputFiles(fixtures.png);
    await expect(page.getByText("画像を選ぶと二次元コードに表示されます。")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "別の画像を選ぶ" })).toBeVisible();
    await expect(page.getByRole("button", { name: "画像を選ぶ", exact: true })).toHaveCount(0);
    // 同じ画像をもう一度選んでもエラーにならない（入力欄が空に戻っている）
    expect(await page.locator('input[type="file"]').evaluate((el) => (el as HTMLInputElement).value)).toBe("");
    await page.getByLabel("マークにする画像").setInputFiles(fixtures.png);
    await expect(appAlert(page)).toHaveCount(0);
  });

  test("画像として読めないファイルを選ぶと、既存のエラー表示（role=alert）が出る。選択欄は壊れない", async ({ page }) => {
    await openCustomMark(page);
    await page.locator("textarea").fill("https://example.com/");
    await page.getByLabel("マークにする画像").setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await expect(appAlert(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /画像を選ぶ/ })).toBeVisible();
  });

  test("選んだ画像の中身はサーバーへ送られない", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.postData()) bodies.push(r.url());
    });
    await openCustomMark(page);
    await page.getByLabel("マークにする画像").setInputFiles(fixtures.png);
    await expect(page.getByRole("button", { name: "別の画像を選ぶ" })).toBeVisible();
    expect(bodies.filter((u) => !/\/_next\/|hot-update|__nextjs/.test(u))).toEqual([]);
  });
});

test.describe("D-2. 電子印鑑: フォントファイル", () => {
  test("キーボードで選択画面が開く（以前は入力欄が非表示で、キーボードでは選べなかった）", async ({ page }) => {
    await gotoTool(page, "electronic-stamp-generator");
    const pick = page.getByRole("button", { name: "フォントファイルを選択" });
    await focusByKeyboard(pick, page);
    expect(await hasFocusIndicator(pick)).toBe(true);
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    const fc = await chooser;
    expect(fc.isMultiple()).toBe(false);
  });

  test("受け付ける形式（.ttf/.otf/.woff/.woff2）が維持されている", async ({ page }) => {
    await gotoTool(page, "electronic-stamp-generator");
    const accept = await page.getByLabel("フォントファイルを選択", { exact: true }).evaluate((el) => (el as HTMLInputElement).accept);
    expect(accept).toBe(".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2");
  });

  test("フォントとして読めないファイルを選ぶと、既存の文言のエラーが role=alert で出る。ボタンは使えるまま", async ({ page }) => {
    await gotoTool(page, "electronic-stamp-generator");
    await page.getByLabel("フォントファイルを選択", { exact: true }).setInputFiles({
      name: "broken.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("this is not a font"),
    });
    const alert = appAlert(page).filter({ hasText: "フォント" });
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "フォントファイルを選択" })).toBeEnabled();
    await expect(page.getByText("使用中:")).toHaveCount(0);
  });

  test("フォントファイルはサーバーへ送られない", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.postData()) bodies.push(r.url());
    });
    await gotoTool(page, "electronic-stamp-generator");
    await page.getByLabel("フォントファイルを選択", { exact: true }).setInputFiles({ name: "x.ttf", mimeType: "font/ttf", buffer: Buffer.from("zzz") });
    await expect(appAlert(page).filter({ hasText: "フォント" })).toBeVisible({ timeout: 15_000 });
    expect(bodies.filter((u) => !/\/_next\/|hot-update|__nextjs/.test(u))).toEqual([]);
  });
});

test.describe("D-3. 年度カレンダー: 予定表の取り込み", () => {
  async function open(page: Page) {
    await page.goto("/tools/fiscal-calendar");
    await expect(page.getByTestId("events-dropzone")).toBeVisible({ timeout: 30_000 });
    await waitForFileInputHydrated(page);
  }

  test("入力欄の仕様（複数可・形式）が維持され、ボタンはキーボードで選択画面を開ける", async ({ page }) => {
    await open(page);
    const input = page.getByTestId("events-file");
    await expect(input).toHaveAttribute("multiple", "");
    const accept = await input.getAttribute("accept");
    expect(accept).toContain(".xlsx");
    expect(accept).toContain(".csv");
    expect(accept).toContain(".pdf");
    const pick = page.getByRole("button", { name: "ファイルを選ぶ" });
    await pick.focus();
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Space");
    expect((await chooser).isMultiple()).toBe(true);
  });

  test("ドラッグ中は共通の見た目（実線の枠）になり、離れると戻る。枠そのものはクリックしても何も起きない", async ({ page }) => {
    await open(page);
    const zone = page.getByTestId("events-dropzone");
    expect(await zone.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
    expect(await zone.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
    await zone.evaluate((el) => el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
    await expect(zone).toHaveAttribute("data-dragging", "true");
    expect(await zone.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
    await expect(page.getByTestId("events-drop-label")).toContainText("ここで手を離すと読み込みます");
    await zone.evaluate((el) => el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
    await expect(zone).toHaveAttribute("data-dragging", "false");
  });

  test("対応していない形式は、既存の文言のエラー（role=alert・アイコン付き）になる", async ({ page }) => {
    await open(page);
    await page.getByTestId("events-file").setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    const err = page.getByTestId("events-file-error");
    await expect(err).toHaveAttribute("role", "alert");
    await expect(err).toContainText("このファイル形式には対応していません");
    await expect(err.locator("svg")).toHaveCount(1);
  });

  test("古い形式（.xls）には既存の案内が出る", async ({ page }) => {
    await open(page);
    await page.getByTestId("events-file").setInputFiles({ name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("dummy") });
    await expect(page.getByTestId("events-file-error")).toContainText(".xlsx");
  });

  test("CSVを読み込むと、ファイル名が出て、ボタンが「別のファイルを選ぶ」になり、取り消せる", async ({ page }) => {
    await open(page);
    const csv = "日付,予定\n2026/04/01,入社式\n2026/04/10,朝会\n";
    await page.getByTestId("events-file").setInputFiles({ name: "予定.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.getByTestId("events-file-name")).toHaveText("予定.csv", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "別のファイルを選ぶ" })).toBeVisible();
    await page.getByTestId("events-clear").click();
    await expect(page.getByTestId("events-file-name")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ファイルを選ぶ" })).toBeVisible();
  });

  test("予定表ファイルはサーバーへ送られない（Excel・CSVはブラウザ内で処理）", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && r.postData()) bodies.push(r.url());
    });
    await open(page);
    await page.getByTestId("events-file").setInputFiles({ name: "予定.csv", mimeType: "text/csv", buffer: Buffer.from("日付,予定\n2026/04/01,入社式\n") });
    await expect(page.getByTestId("events-file-name")).toBeVisible({ timeout: 30_000 });
    expect(bodies.filter((u) => !/\/_next\/|hot-update|__nextjs/.test(u))).toEqual([]);
  });
});

// ===========================================================================
// E. ライト／ダーク・スマホ幅
// ===========================================================================
for (const scheme of ["light", "dark"] as const) {
  test.describe(`E. 見た目（${scheme}）`, () => {
    test.use({ colorScheme: scheme });

    test("3ツールの選択ボタンと取り込み枠が、はみ出さず、文字が読める", async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      for (const [id, pickName] of [
        ["electronic-stamp-generator", "フォントファイルを選択"],
        ["fiscal-calendar", "ファイルを選ぶ"],
      ] as const) {
        await gotoTool(page, id);
        const pick = page.getByRole("button", { name: pickName });
        await expect(pick).toBeVisible();
        const box = (await pick.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(360);
        expect(box.height).toBeGreaterThanOrEqual(36);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      }
      // 共通ボタンと同じ見た目クラス（.ms-btn）を使っている
      await gotoTool(page, "fiscal-calendar");
      await expect(page.getByRole("button", { name: "ファイルを選ぶ" })).toHaveClass(/ms-btn/);
    });
  });
}
