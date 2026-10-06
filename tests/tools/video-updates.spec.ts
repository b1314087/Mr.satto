import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * 動画ツールの更新のテスト:
 *  - 読み込みサイズの上限を撤廃(大きいファイルは警告を出して続行できる)
 *  - H.264変換: H.265(HEVC)の動画を判定して案内する
 *
 * 実際のH.264エンコードは、テストに使うヘッドレスChromiumが対応していないため、
 * H.264変換ツールの画面確認では VideoEncoder.isConfigSupported を「対応」と見せかけて(スタブ)開く。
 * 変換の完走そのものはここでは確認しない(実機のブラウザで確認が必要)。
 */

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function openAfterHydration(page: Page, id: string) {
  await page.goto(`/tools/${id}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[role="button"][aria-label*="動画ファイル"]');
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
  });
}

test.describe("動画の読み込みサイズ上限の撤廃", () => {
  const sizesMb = [{ mb: 310, expect: /約310MB/ }];

  for (const tool of ["video-convert", "video-compress", "video-resize", "video-frame-rate", "video-metadata-remove", "video-thumbnail"]) {
    test(`${tool}: 300MB超でも読み込めず止まらず、警告が出て続行できる`, async ({ page }) => {
      test.setTimeout(90_000);
      const big = path.join(os.tmpdir(), `big-${tool}-${Date.now()}.mp4`);
      fs.writeFileSync(big, "");
      fs.truncateSync(big, sizesMb[0].mb * 1024 * 1024); // 中身が0のスパースファイル(読み込み・形式判定は失敗するが、サイズ制限の確認には十分)
      try {
        await openAfterHydration(page, tool);
        await uploadFixture(page, big);
        await expect(page.getByTestId("video-size-warning")).toBeVisible();
        await expect(page.getByTestId("video-size-warning")).toContainText(sizesMb[0].expect);
        await expect(page.getByTestId("video-size-warning")).toContainText("このまま続行できます");
        // 「ファイルサイズが大きすぎます」のエラーは出ない
        await expect(page.getByText(/ファイルサイズが大きすぎます/)).toHaveCount(0);
        // ファイルが読み込まれた状態(ファイル一覧に表示)になっている
        await expect(page.getByText(path.basename(big)).first()).toBeVisible();
      } finally {
        fs.rmSync(big, { force: true });
      }
    });
  }

  test("小さいファイルでは警告は出ない", async ({ page }) => {
    const { fixtures } = await import("../fixtures/paths");
    await openAfterHydration(page, "video-convert");
    await uploadFixture(page, fixtures.webm);
    await expect(page.getByRole("button", { name: "変換する" })).toBeVisible();
    await expect(page.getByTestId("video-size-warning")).toHaveCount(0);
  });
});

test.describe("H.264変換: H.265(HEVC)対応", () => {
  test.skip(!hasFfmpeg(), "ffmpegが無いためH.265のテスト動画を作れません");

  function makeVideo(codec: "libx265" | "libx264"): string {
    const out = path.join(os.tmpdir(), `codec-${codec}-${Date.now()}.mp4`);
    const args = ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1", "-c:v", codec, "-pix_fmt", "yuv420p"];
    if (codec === "libx265") args.push("-tag:v", "hvc1");
    args.push(out);
    execFileSync("ffmpeg", args, { stdio: "ignore" });
    return out;
  }

  async function openH264(page: Page) {
    // ヘッドレスChromiumはH.264エンコードに対応しないため、対応しているように見せかけて画面を開く
    await page.addInitScript(() => {
      const w = window as unknown as { VideoEncoder?: { isConfigSupported?: (c: unknown) => Promise<unknown> } };
      if (w.VideoEncoder) {
        w.VideoEncoder.isConfigSupported = async (config: unknown) => ({ supported: true, config });
      }
    });
    await openAfterHydration(page, "video-h264");
  }

  test("H.265の動画を選ぶと、コーデックがH.265と表示され、読み込めるかの案内が出る", async ({ page }) => {
    const file = makeVideo("libx265");
    try {
      await openH264(page);
      await uploadFixture(page, file);
      const info = page.getByTestId("video-codec-info");
      await expect(info).toBeVisible({ timeout: 20_000 });
      await expect(info).toContainText("元の動画のコーデック: H.265（HEVC）");
      const text = (await info.textContent()) ?? "";
      if (text.includes("読み込めません")) {
        // このブラウザがH.265をデコードできない場合: 専用の案内が出て、変換ボタンは押せない
        await expect(info).toContainText("Safari");
        await expect(page.getByRole("button", { name: "H.264に変換する" })).toBeDisabled();
      } else {
        // デコードできる場合: H.265→H.264の再エンコードと、画質の選択肢が出る
        await expect(info).toContainText("H.265（HEVC） から H.264（AVC）へ再エンコードします");
        await expect(page.getByLabel("再エンコードの画質")).toBeVisible();
        await expect(page.getByRole("button", { name: "H.264に変換する" })).toBeEnabled();
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("H.264の動画を選ぶと、再エンコードしない旨が表示される(読み込める環境のみ)", async ({ page }) => {
    const file = makeVideo("libx264");
    try {
      await openH264(page);
      await uploadFixture(page, file);
      const info = page.getByTestId("video-codec-info");
      await expect(info).toBeVisible({ timeout: 20_000 });
      await expect(info).toContainText("元の動画のコーデック: H.264（AVC）");
      const text = (await info.textContent()) ?? "";
      if (!text.includes("読み込めません")) {
        await expect(info).toContainText("再エンコードせずにMP4へ入れ直す");
        await expect(page.getByLabel("再エンコードの画質")).toHaveCount(0);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
