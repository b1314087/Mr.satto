import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

/**
 * 既存ツールの機能追加(大文字小文字+数字の全角半角 / パスワードの文字指定 / ポモドーロの時間設定 /
 * 二次元コードのマーク)と、ファイル情報確認ツールの削除のテスト。
 */

/** ツール本体(動的読み込み)の水和が終わるまで待つ */
async function openTool(page: Page, id: string, anyButton: RegExp) {
  await page.goto(`/tools/${id}`);
  await page.waitForFunction((src) => {
    const re = new RegExp(src);
    const el = Array.from(document.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""));
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
  }, anyButton.source);
}

test.describe("ファイル情報確認の削除", () => {
  test("ツールページは存在せず、ツール一覧にも出ない", async ({ page }) => {
    const res = await page.goto("/tools/file-inspector");
    expect(res?.status()).toBe(404);
    await page.goto("/tools");
    await expect(page.getByText("ファイル情報確認")).toHaveCount(0);
  });
});

test.describe("大文字・小文字・数字の全角半角変換", () => {
  test("数字だけを全角⇄半角に変換できる(英字は変換しない設定)", async ({ page }) => {
    await openTool(page, "text-case-converter", /英字は変換しない/);
    const input = page.getByPlaceholder("変換したい文章を入力または貼り付けてください");
    const output = page.getByPlaceholder("入力すると、変換後のテキストがここに表示されます");
    await input.fill("ａｂｃ１２３ abc 456 〒100-0001 一二三");
    await page.getByRole("button", { name: /英字は変換しない/ }).click();
    await page.getByRole("button", { name: /数字を半角にする/ }).click();
    await expect(output).toHaveValue("ａｂｃ123 abc 456 〒100-0001 一二三");
    await page.getByRole("button", { name: /数字を全角にする/ }).click();
    await expect(output).toHaveValue("ａｂｃ１２３ abc ４５６ 〒１００-０００１ 一二三");
    await page.getByRole("button", { name: /数字は変換しない/ }).click();
    await expect(output).toHaveValue("ａｂｃ１２３ abc 456 〒100-0001 一二三");
  });

  test("大文字変換と数字の半角化を同時にできる", async ({ page }) => {
    await openTool(page, "text-case-converter", /英字は変換しない/);
    await page.getByPlaceholder("変換したい文章を入力または貼り付けてください").fill("order１２ no.３");
    await page.getByRole("button", { name: /すべて大文字/ }).click();
    await page.getByRole("button", { name: /数字を半角にする/ }).click();
    await expect(page.getByPlaceholder("入力すると、変換後のテキストがここに表示されます")).toHaveValue("ORDER12 NO.3");
  });
});

test.describe("パスワード生成の文字指定", () => {
  async function password(page: Page): Promise<string> {
    return ((await page.locator("code").first().textContent()) ?? "").trim();
  }

  test("英字のみ・数字のみ・英数字のみのワンタッチ指定", async ({ page }) => {
    await openTool(page, "password-generator", /パスワードを生成する/);
    await page.getByRole("button", { name: "英字のみ", exact: true }).click();
    await expect.poll(() => password(page)).toMatch(/^[A-Za-z]{16}$/);
    await page.getByRole("button", { name: "数字のみ", exact: true }).click();
    await expect.poll(() => password(page)).toMatch(/^[0-9]{16}$/);
    await page.getByRole("button", { name: "英数字のみ", exact: true }).click();
    await expect.poll(() => password(page)).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  test("使う文字を自分で指定すると、その文字だけで作られる", async ({ page }) => {
    await openTool(page, "password-generator", /パスワードを生成する/);
    await page.getByLabel("使う文字を指定").fill("abcxyz789");
    await expect.poll(() => password(page)).toMatch(/^[abcxyz789]{16}$/);
    await expect(page.getByRole("checkbox").first()).toBeDisabled();
    // 1種類だけではエラー
    await page.getByLabel("使う文字を指定").fill("aaaa");
    await expect(page.getByText("使う文字は2種類以上指定してください")).toBeVisible();
    // 日本語の文字も使える
    await page.getByLabel("使う文字を指定").fill("あいうえお");
    await expect.poll(() => password(page)).toMatch(/^[あいうえお]{16}$/);
  });
});

test.describe("ポモドーロタイマーの時間設定", () => {
  test("集中・休憩の時間を決められ、表示に反映される", async ({ page }) => {
    await openTool(page, "pomodoro-timer", /スタート/);
    const time = page.getByTestId("pomodoro-time");
    await expect(time).toHaveText("25:00");
    const focus = page.getByRole("spinbutton", { name: "集中の時間（分）" });
    await focus.fill("50");
    await focus.press("Enter");
    await expect(time).toHaveText("50:00");
    await expect(page.getByRole("button", { name: /集中 \(50分\)/ })).toBeVisible();

    await page.getByRole("spinbutton", { name: "小休憩の時間（分）" }).fill("3");
    await page.getByRole("spinbutton", { name: "小休憩の時間（分）" }).press("Enter");
    await page.getByRole("button", { name: /小休憩/ }).click();
    await expect(time).toHaveText("03:00");

    // 範囲外は1〜180分に丸められる
    const longBreak = page.getByRole("spinbutton", { name: "長休憩の時間（分）" });
    await longBreak.fill("999");
    await longBreak.press("Enter");
    await expect(page.getByRole("button", { name: /長休憩 \(180分\)/ })).toBeVisible();
  });

  test("動いている間は時間を変更できない", async ({ page }) => {
    await openTool(page, "pomodoro-timer", /スタート/);
    await page.getByRole("button", { name: "スタート" }).click();
    await expect(page.getByRole("spinbutton", { name: "集中の時間（分）" })).toBeDisabled();
    await page.getByRole("button", { name: "一時停止" }).click();
    await expect(page.getByRole("spinbutton", { name: "集中の時間（分）" })).toBeEnabled();
  });
});

/** OpenCVで二次元コードを読み取る(クラウド環境の検証用。python3+cv2が無ければnull) */
function decodeQr(filePath: string): string | null {
  try {
    const out = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import sys,cv2\nimg=cv2.imread(sys.argv[1])\nd=cv2.QRCodeDetector()\nv,_,_=d.detectAndDecode(img)\nprint(v)",
        filePath,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    return out.trim();
  } catch {
    return null;
  }
}

test.describe("二次元コードのマーク", () => {
  const URL_TEXT = "https://example.com/mr-satto/qr-test?id=12345";

  async function downloadPng(page: Page): Promise<string> {
    const download = await clickAndDownload(page, /画像としてダウンロード/);
    const tmp = path.join(os.tmpdir(), `qr-test-${Date.now()}-${Math.floor(Math.random() * 1e5)}.png`);
    fs.copyFileSync((await download.path())!, tmp);
    // 目視確認用: QR_DUMP_DIR を指定すると、生成したPNGをそのフォルダへ保存する
    if (process.env.QR_DUMP_DIR) fs.copyFileSync(tmp, path.join(process.env.QR_DUMP_DIR, path.basename(tmp)));
    return tmp;
  }

  test("既定ではMr.Sattoのアイコンが真ん中に入り、誤り訂正はHになり、読み取れる", async ({ page }) => {
    await openTool(page, "qr-generator", /二次元コードを生成する/);
    await page.locator("textarea").fill(URL_TEXT);
    await expect(page.getByRole("button", { name: "Mr.Sattoのアイコン" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "真ん中" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/誤り訂正: H（マーク付きのため自動）/)).toBeVisible();
    const file = await downloadPng(page);
    const decoded = decodeQr(file);
    if (decoded === null) test.info().annotations.push({ type: "skip-decode", description: "python3+cv2が無いため読み取り確認を省略" });
    else expect(decoded).toBe(URL_TEXT);
    // PNGであること
    expect(fs.readFileSync(file).subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  test("マークの有無・位置・大きさ・自分の画像を切り替えられ、どれも読み取れる", async ({ page }) => {
    await openTool(page, "qr-generator", /二次元コードを生成する/);
    await page.locator("textarea").fill(URL_TEXT);

    // 右下 + 大きさ30%
    await page.getByRole("button", { name: "右下" }).click();
    await page.getByRole("spinbutton", { name: "マークの大きさの数値" }).fill("30");
    await page.getByRole("spinbutton", { name: "マークの大きさの数値" }).blur();
    const bottomRight = await downloadPng(page);
    // 自分の画像
    await page.getByRole("button", { name: "自分の画像" }).click();
    await page.getByLabel("マークにする画像").setInputFiles(fixtures.png);
    await expect(page.getByText("画像を選ぶと二次元コードに表示されます。")).toHaveCount(0);
    await page.getByRole("button", { name: "真ん中" }).click();
    const custom = await downloadPng(page);
    // マークなし: 誤り訂正を選べる
    await page.getByRole("button", { name: "マークなし" }).click();
    await expect(page.getByLabel("誤り訂正レベル")).toBeEnabled();
    const none = await downloadPng(page);

    // 3つの画像は互いに違う
    const sizes = [bottomRight, custom, none].map((f) => fs.readFileSync(f).toString("base64"));
    expect(new Set(sizes).size).toBe(3);
    for (const f of [bottomRight, custom, none]) {
      const decoded = decodeQr(f);
      if (decoded !== null) expect(decoded, f).toBe(URL_TEXT);
    }
  });
});
