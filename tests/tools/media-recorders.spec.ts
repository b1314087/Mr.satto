import fs from "node:fs";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { waitHydrated } from "../helpers/hydrated";

/**
 * 録音・画面録画の画面（2026-11-18）。
 * マイク・カメラは Chromium の「偽物の機器」（--use-fake-device-for-media-stream）を使う（ブラウザの起動の設定のため、このファイルだけ別にしている）。
 * 画面の共有は、テストの中では選ぶ画面を出せないため、動く絵（canvas）を返す偽物に差し替える。
 */
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone", "camera"],
});

// ---------------------------------------------------------------------------
// 4. 録音・画面録画（偽物のマイク・カメラを使う）
// ---------------------------------------------------------------------------
test.describe("録音・画面録画", () => {
  test("録音：録音して止め、MP3で保存できる（一時停止のあいだは時間が進まない）", async ({ page }) => {
    await page.goto("/tools/voice-recorder");
    await waitHydrated(page.getByTestId("recorder-start"));
    await page.getByTestId("recorder-start").click();
    await expect(page.getByTestId("recorder-phase")).toHaveAttribute("data-phase", "recording", { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("recorder-pause").click();
    await expect(page.getByTestId("recorder-phase")).toHaveAttribute("data-phase", "paused");
    const pausedAt = await page.getByTestId("recorder-time").textContent();
    await page.waitForTimeout(1200);
    expect(await page.getByTestId("recorder-time").textContent()).toBe(pausedAt);
    await page.getByTestId("recorder-resume").click();
    await page.waitForTimeout(1000);
    await page.getByTestId("recorder-stop").click();
    await expect(page.getByTestId("recorder-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("recorder-preview")).toBeVisible();

    await page.getByRole("radio", { name: /MP3/ }).check();
    await page.getByRole("button", { name: "保存用のファイルを作る" }).click();
    await expect(page.getByText("保存用のファイルができました")).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toMatch(/^録音_\d{8}-\d{4}\.mp3$/);
    const file = await download.path();
    const head = fs.readFileSync(file!).subarray(0, 3);
    // MP3（ID3 か、フレームの始まり）
    expect(head.toString("latin1") === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)).toBe(true);
    expect(fs.statSync(file!).size).toBeGreaterThan(2000);
  });

  test("画面録画：画面にカメラを重ねて録画し、動画を保存できる（共有を止めると録画も終わる）", async ({ page }) => {
    // 画面の共有の代わりに、動く絵（canvas）を返す
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext("2d")!;
        let n = 0;
        setInterval(() => {
          ctx.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`;
          ctx.fillRect(0, 0, 640, 360);
        }, 33);
        const stream = canvas.captureStream(30);
        (window as unknown as { __displayStream: MediaStream }).__displayStream = stream;
        return stream;
      };
    });
    await page.goto("/tools/screen-recorder");
    await waitHydrated(page.getByTestId("screen-start"));
    await page.getByTestId("screen-camera").click();
    await page.getByTestId("screen-start").click();
    await expect(page.getByTestId("screen-phase")).toHaveAttribute("data-phase", "recording", { timeout: 15_000 });
    await page.waitForTimeout(2000);
    // 共有を止める（ブラウザの「共有を停止」と同じ）→ 録画が終わる
    await page.evaluate(() => {
      const s = (window as unknown as { __displayStream: MediaStream }).__displayStream;
      s.getVideoTracks().forEach((t) => {
        t.stop();
        t.dispatchEvent(new Event("ended"));
      });
    });
    await expect(page.getByTestId("screen-result")).toBeVisible({ timeout: 15_000 });
    // 録画した動画は再生できる長さがある
    await expect
      .poll(() => page.getByTestId("screen-preview").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const download = await clickAndDownload(page, /ダウンロード（\.(webm|mp4)）/);
    expect(download.suggestedFilename()).toMatch(/^画面録画_\d{8}-\d{4}\.(webm|mp4)$/);
    expect(fs.statSync((await download.path())!).size).toBeGreaterThan(10_000);
  });

  test("画面の録画に対応していないブラウザ（スマホなど）では、案内を出す", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: undefined, configurable: true });
    });
    await page.goto("/tools/screen-recorder");
    await expect(page.getByTestId("screen-unsupported")).toBeVisible();
    await expect(page.getByTestId("screen-start")).toHaveCount(0);
  });
});
