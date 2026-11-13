import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import {
  uploadFixture,
  waitForSuccess,
  clickAndDownload,
  assertDownloadedFile,
  getPngDimensions,
} from "../helpers/tool-runner";

/**
 * 画像一括余白・文字入れツール（Mr.Satto 次工程フェーズ Step 6）のE2Eテスト。
 *
 * 入力（1枚/複数枚/追加/削除/並び替え）、余白（上下左右・元画像サイズ維持）、
 * 背景、文字（入力・サイズ・色・太字・複数行・配置・文字なし）、
 * 共通設定/個別設定（反映・維持）、出力（PNG/JPEG/一括ZIP）、異常系、
 * モバイル表示を検証する。
 *
 * sample.png/sample.jpgは64x64の正方形、landscapeJpgは300x200の横長。
 */

test("image-padding-text: ページが表示され、画像を1枚アップロードすると設定UIが出る", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await expect(page.getByRole("heading", { name: "画像一括文字入れ" })).toBeVisible();

  await uploadFixture(page, [fixtures.png]);

  await expect(page.getByText("1 / 1")).toBeVisible();
  await expect(page.getByText("共通設定（全画像に適用）")).toBeVisible();
  await expect(page.getByRole("button", { name: "この画像だけ保存" })).toBeVisible();
});

test("image-padding-text: 複数枚アップロードすると前へ/次へで切り替えられる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await expect(page.getByText("1 / 2")).toBeVisible();
  const prevButton = page.getByRole("button", { name: "← 前へ" });
  const nextButton = page.getByRole("button", { name: "次へ →" });
  await expect(prevButton).toBeDisabled();
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByText("2 / 2")).toBeVisible();
  await expect(nextButton).toBeDisabled();

  await prevButton.click();
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("image-padding-text: 画像を追加できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);
  await uploadFixture(page, [fixtures.jpg, fixtures.landscapeJpg]);

  await expect(page.getByText("1 / 3")).toBeVisible();
});

test("image-padding-text: 画像を削除できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg, fixtures.landscapeJpg]);

  await page.getByRole("button", { name: /削除/ }).first().click();
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("image-padding-text: 上下ボタンで画像の順序を入れ替えられる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const downButtons = page.getByRole("button", { name: /下へ移動/ });
  await expect(downButtons.first()).toBeEnabled();
  await downButtons.first().click();
  await expect(page.getByRole("button", { name: /下へ移動/ }).nth(1)).toBeDisabled();
});

test("image-padding: 余白を追加しても元画像はリサイズされず、キャンバスだけ拡張される", async ({ page }) => {
  await page.goto("/tools/image-padding"); // 2026-11：余白は「画像一括余白」に分けた
  await uploadFixture(page, [fixtures.png]); // 64x64

  await page.getByRole("spinbutton", { name: /^上/ }).first().fill("10");
  await page.getByRole("spinbutton", { name: /^下/ }).first().fill("20");
  await page.getByRole("spinbutton", { name: /^左/ }).first().fill("5");
  await page.getByRole("spinbutton", { name: /^右/ }).first().fill("5");

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(74); // 64 + 5(左) + 5(右)、元画像幅は変わらない
  expect(dims.height).toBe(94); // 64 + 10(上) + 20(下)
});

test("image-padding: 「4辺を同じ値にする」で上下左右へ一括反映できる", async ({ page }) => {
  await page.goto("/tools/image-padding"); // 2026-11：余白は「画像一括余白」に分けた
  await uploadFixture(page, [fixtures.png]);

  // 「4辺を同じ値にする」ボタンと同じ行にある数値入力を使う
  await page.getByRole("button", { name: "4辺を同じ値にする" }).locator("..").locator('input[type="number"]').fill("15");
  await page.getByRole("button", { name: "4辺を同じ値にする" }).click();

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(94); // 64 + 15 + 15
  expect(dims.height).toBe(94); // 64 + 15 + 15
});

test("image-padding: 背景色を白/黒/カスタムへ切り替えられる", async ({ page }) => {
  await page.goto("/tools/image-padding"); // 2026-11：余白は「画像一括余白」に分けた
  await uploadFixture(page, [fixtures.png]);

  // 「文字の色：黒」の色ボタンと区別するため、名前が「黒」だけのボタン（背景色）を選ぶ
  const blackButton = page.getByRole("button", { name: "黒", exact: true });
  await blackButton.click();
  await expect(blackButton).toHaveClass(/bg-blue-600/);
});

test("image-padding-text: 文字を入力し、サイズ・色・太字・複数行・配置を設定できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByPlaceholder("入れる文字（複数行可）").fill("1行目\n2行目");
  await page.getByLabel("サイズ", { exact: false }).first().fill("18");
  await page.getByRole("button", { name: "太字" }).click();
  // 文字は写真の上に置く（2026-11）。位置は左上
  await page.getByTestId("padding-text-across").getByRole("button", { name: "上", exact: true }).click();
  await page.getByTestId("padding-text-along").getByRole("button", { name: "左", exact: true }).click();

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-padding-text: 特定の画像だけ「文字なし」にできる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("この画像は文字なし").check();
  await expect(page.getByLabel("この画像は文字なし")).toBeChecked();
});

test("image-padding: 個別設定に切り替えると共通設定と独立して変更できる", async ({ page }) => {
  await page.goto("/tools/image-padding"); // 2026-11：余白は「画像一括余白」に分けた
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const toggle = page.getByRole("button", { name: /共通設定を使用中|個別設定を使用中/ });
  await expect(toggle).toHaveText("共通設定を使用中");
  await toggle.click();
  await expect(toggle).toHaveText("個別設定を使用中");

  // 個別設定パネルが表示され、2つ目の「上」余白入力が増えることを確認
  await expect(page.getByRole("spinbutton", { name: /^上/ })).toHaveCount(2);
});

test("image-padding: 共通設定を変更しても個別設定した画像の値は維持される", async ({ page }) => {
  await page.goto("/tools/image-padding"); // 2026-11：余白は「画像一括余白」に分けた
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  // 1枚目を個別設定にし、上余白を100にする
  await page.getByRole("button", { name: "共通設定を使用中" }).click();
  const individualTopInput = page.getByRole("spinbutton", { name: /^上/ }).nth(1);
  await individualTopInput.fill("100");

  // 共通設定（1つ目の「上」入力）を変更しても、個別設定側の値は変わらない
  await page.getByRole("spinbutton", { name: /^上/ }).first().fill("5");
  await expect(individualTopInput).toHaveValue("100");
});

test("image-padding-text: PNGで書き出せる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-padding-text: JPEGで書き出せる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "JPEG", exact: true }).click();
  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
});

test("image-padding-text: 複数画像を一括出力するとZIPになる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: "2件を一括出力" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ZIPをダウンロード");
  await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
});

test("image-padding-text: 画像1枚を一括出力するとZIPにならず直接ダウンロードされる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "1件を一括出力" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  // format:"png"のマジックバイト検証が通ること自体が、ZIP化されていない
  // （PK\x03\x04ではなくPNGシグネチャそのままである）ことの確認になる。
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-padding-text: 未対応ファイル（txt）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.txt]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-padding-text: 破損した画像ファイルが混ざるとエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.corruptedImage]);

  await page.getByRole("button", { name: "2件を一括出力" }).click();
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-padding-text: ファイル未選択時は出力操作が表示されない", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await expect(page.getByRole("button", { name: "この画像だけ保存" })).toHaveCount(0);
  await expect(page.getByText(/件を一括出力/)).toHaveCount(0);
});

test("image-padding-text: モバイル幅(375px)でも横スクロールが発生せず主要要素が操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await expect(page.getByRole("button", { name: "次へ →" })).toBeVisible();
  await expect(page.getByRole("button", { name: "この画像だけ保存" })).toBeVisible();
  await expect(page.getByText(/件を一括出力/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// X/Y のバーと文字の色（次期機能追加 6）
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";

test("image-padding-text: 写真の上の文字を、横・縦の位置（X/Y）のバーで動かし、色を選べる。書き出した画像にも同じ位置・色で入る（余白は付かない）", async ({ page }) => {
  test.setTimeout(90_000);
  const src = test.info().outputPath("gray.png");
  execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB',(300,100),(128,128,128)).save(sys.argv[1])", src]);
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [src]);
  await page.getByPlaceholder("入れる文字（複数行可）").fill("ABC");
  await page.getByLabel("サイズ", { exact: false }).first().fill("30");
  await page.getByTestId("padding-text-color-赤").click();
  await expect(page.getByTestId("padding-text-color-value")).toContainText(/#e53935/i);
  const xy = page.getByTestId("padding-text-xy");
  await xy.getByLabel("横の位置（X）の数値").fill("20");
  await xy.getByLabel("横の位置（X）の数値").blur();
  await xy.getByLabel("縦の位置（Y）の数値").fill("50");
  await xy.getByLabel("縦の位置（Y）の数値").blur();
  await expect(xy.getByRole("slider").first()).toHaveValue("20");

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const out = test.info().outputPath("pad.png");
  await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
  const r = JSON.parse(
    execFileSync("python3", ["-c", `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
sx = sy = n = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 150 and r - g > 60 and r - b > 60:
            sx += x; sy += y; n += 1
print(json.dumps({"w": w, "h": h, "x": sx / n if n else -1, "y": sy / n if n else -1, "n": n}))
`, out], { encoding: "utf8" })
  );
  expect(r.w).toBe(300);
  expect(r.h).toBe(100); // 文字入れでは余白を付けない（元の画像のまま）
  expect(r.n).toBeGreaterThan(50);
  expect(Math.abs(r.x / r.w - 0.2)).toBeLessThan(0.06); // 横20%
  expect(Math.abs(r.y - 50)).toBeLessThan(10); // 写真の縦の真ん中
});

test("image-padding-text: 余白が0pxでも写真に文字を重ねられ、位置を変えられる。縁取りも付けられる（2026-11）", async ({ page }) => {
  test.setTimeout(90_000);
  const src = test.info().outputPath("gray-photo.png");
  execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB',(300,200),(128,128,128)).save(sys.argv[1])", src]);
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [src]);
  await page.getByPlaceholder("入れる文字（複数行可）").fill("ABC");
  await page.getByLabel("サイズ", { exact: false }).first().fill("40");
  // 文字を置く場所の選択は無い（いつも写真の上）。位置のボタンは「左・中央・右」「上・中央・下」
  await expect(page.getByTestId("padding-text-place")).toHaveCount(0);
  await page.getByTestId("padding-text-along").getByRole("button", { name: "右", exact: true }).click();
  await page.getByTestId("padding-text-across").getByRole("button", { name: "上", exact: true }).click();
  await page.getByTestId("padding-text-color-赤").click();
  await page.getByTestId("padding-text-outline").click();
  await expect(page.getByTestId("padding-text-outline")).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const out = test.info().outputPath("on-photo.png");
  await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
  const r = JSON.parse(
    execFileSync("python3", ["-c", `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
sx = sy = n = white = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 150 and r - g > 60 and r - b > 60:
            sx += x; sy += y; n += 1
        if r > 240 and g > 240 and b > 240:
            white += 1
print(json.dumps({"w": w, "h": h, "x": sx / n if n else -1, "y": sy / n if n else -1, "n": n, "white": white}))
`, out], { encoding: "utf8" })
  );
  // 余白0px：画像の大きさは元のまま（文字は写真の上に重なる）
  expect(r.w).toBe(300);
  expect(r.h).toBe(200);
  expect(r.n).toBeGreaterThan(50);
  expect(r.x / r.w).toBeGreaterThan(0.6); // 右寄せ
  expect(r.y / r.h).toBeLessThan(0.35); // 上寄せ
  expect(r.white).toBeGreaterThan(30); // 赤い文字には白い縁取りが付く
});

test("image-padding-text: 位置のバーを動かしている最中（手を止める前）から、プレビューが付いてきて変わる（2026-11）", async ({ page }) => {
  test.setTimeout(90_000);
  const src = test.info().outputPath("gray-live.png");
  execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB',(600,400),(128,128,128)).save(sys.argv[1])", src]);
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [src]);
  await page.getByPlaceholder("入れる文字（複数行可）").fill("ABC");
  const img = page.getByRole("img", { name: "文字入れの結果のプレビュー" });
  await expect(img).toBeVisible();
  // プレビューの画像が変わった回数を数える（ページの中で、src の変化を記録する）
  await page.evaluate(() => {
    const w = window as unknown as { __srcChanges: number };
    w.__srcChanges = 0;
    const el = document.querySelector('img[alt="文字入れの結果のプレビュー"]')!;
    new MutationObserver(() => (w.__srcChanges += 1)).observe(el, { attributes: true, attributeFilter: ["src"] });
  });
  const slider = page.getByTestId("padding-text-xy").getByRole("slider").first();
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  // ボタンを押したまま、少しずつ右へ動かし続ける（途中で止めない）
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(box.x + 4 + ((box.width - 8) * i) / 20, y);
    await page.waitForTimeout(60);
  }
  const duringDrag = await page.evaluate(() => (window as unknown as { __srcChanges: number }).__srcChanges);
  await page.mouse.up();
  // 以前（止まってから作る）は、動かしている間は0回だった。いまは、動かしている間にも何度も変わる
  expect(duringDrag).toBeGreaterThanOrEqual(2);
});

test("image-padding-text: 文字の位置は写真の上だけ（余白に置く選択・長い説明文は出さない）。既定は写真の下の中央に入る（2026-11）", async ({ page }) => {
  test.setTimeout(90_000);
  const src = test.info().outputPath("gray-default.png");
  execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB',(300,200),(128,128,128)).save(sys.argv[1])", src]);
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [src]);
  for (const removed of ["JPEGで保存する場合、透明は白背景", "写真の上の文字の位置を細かく動かせます", "写真の上に文字を重ねます", "配置する余白", "文字を置く場所"]) {
    await expect(page.getByText(removed)).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "写真の上" })).toHaveCount(0);
  await page.getByPlaceholder("入れる文字（複数行可）").fill("ABC");
  await page.getByLabel("サイズ", { exact: false }).first().fill("30");
  await page.getByTestId("padding-text-color-赤").click();
  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const out = test.info().outputPath("default-pos.png");
  await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
  const r = JSON.parse(
    execFileSync("python3", ["-c", `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
sx = sy = n = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 150 and r - g > 60 and r - b > 60:
            sx += x; sy += y; n += 1
print(json.dumps({"w": w, "h": h, "x": sx / n if n else -1, "y": sy / n if n else -1, "n": n}))
`, out], { encoding: "utf8" })
  );
  expect(r.w).toBe(300);
  expect(r.h).toBe(200); // 文字入れでは余白を付けない
  expect(r.n).toBeGreaterThan(50);
  expect(Math.abs(r.x / r.w - 0.5)).toBeLessThan(0.05); // 横は中央
  expect(r.y).toBeGreaterThan(150); // 写真の下のほう
});

test("2つのツールに分けた（2026-11）：画像一括余白は余白・背景だけ、画像一括文字入れは文字だけ。文字はEnterで改行でき、複数行で入る", async ({ page }) => {
  test.setTimeout(90_000);
  // 余白
  await page.goto("/tools/image-padding");
  await expect(page.getByRole("heading", { name: "画像一括余白" })).toBeVisible();
  await uploadFixture(page, [fixtures.png]);
  await expect(page.getByTestId("padding-sliders")).toBeVisible();
  await expect(page.getByPlaceholder("入れる文字（複数行可）")).toHaveCount(0);
  await expect(page.getByTestId("padding-text-xy")).toHaveCount(0);
  await expect(page.getByText("この画像は文字なし")).toHaveCount(0);
  // 文字入れ
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);
  await expect(page.getByTestId("padding-sliders")).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: /^上/ })).toHaveCount(0);
  const ta = page.getByTestId("padding-text-input");
  await expect(ta).toHaveAttribute("rows", "3");
  await expect(page.getByText("Enterキーで改行できます（改行した行は、そのまま複数行で入ります）。")).toBeVisible();
  await ta.click();
  await page.keyboard.type("ABC");
  await page.keyboard.press("Enter");
  await page.keyboard.type("DEF");
  await expect(ta).toHaveValue("ABC\nDEF");
  // 2行で入る：赤い文字の縦の広がりが、1行のときの倍近くになる
  await page.getByLabel("サイズ", { exact: false }).first().fill("30");
  await page.getByTestId("padding-text-color-赤").click();
  const measure = async (name: string) => {
    await page.getByRole("button", { name: "この画像だけ保存" }).click();
    await waitForSuccess(page, "完了");
    const out = test.info().outputPath(name);
    await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
    await page.keyboard.press("Escape");
    return Number(
      execFileSync("python3", ["-c", `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
ys = [y for y in range(h) for x in range(w) if px[x, y][0] > 150 and px[x, y][0] - px[x, y][1] > 60 and px[x, y][0] - px[x, y][2] > 60]
print(max(ys) - min(ys) if ys else 0)
`, out], { encoding: "utf8" })
    );
  };
  const two = await measure("two-lines.png");
  await ta.fill("ABC");
  const one = await measure("one-line.png");
  expect(two).toBeGreaterThan(one * 1.6);
});
