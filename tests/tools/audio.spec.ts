import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";

/**
 * 音声ツール（6種）のE2E。
 * 「ボタンを押せた」だけで成功扱いにせず、ダウンロードしたファイルをffprobe / ffmpegで
 * 実際に解析して、形式・長さ・音量が期待どおりになっていることを確認する。
 * 入力はffmpegで合成した純音（tests/global-setup.ts の generateAudio）。
 */

/**
 * ファイルを選び、プレビュー（data-testid="tool-preview"）が出るまで待つ。
 * 以前は8秒おきにファイルを選び直していたが、開発サーバーがチャンクを404で返してツール本体が
 * 起動しなかった場合は、何度選び直しても反応せず回復できなかった（工程2の調査）。
 * 現在は、ファイル入力欄の準備完了を待ってから1回だけ選び、開発サーバーのチャンク読み込み失敗が
 * 確認できた場合に限って再読み込みで回復する（詳細は tests/helpers/tool-ready.ts）。
 * 音声のデコードとプレビュー生成には時間がかかることがあるため、準備完了の待機上限は長めにしている。
 */
async function uploadAndWait(page: Page, files: string | string[]) {
  await uploadWhenReady(page, files, page.getByTestId("tool-preview").first(), { readyTimeoutMs: 25_000 });
}

function probe(file: string): { codec: string; duration: number } {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name:format=duration",
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]).toString();
  const codec = /codec_name=(\S+)/.exec(out)?.[1] ?? "";
  const duration = Number(/duration=([\d.]+)/.exec(out)?.[1] ?? "0");
  return { codec, duration };
}

/** ffmpegのvolumedetectで最大音量(dB)を取得する */
function maxVolumeDb(file: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf-8",
  });
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  expect(m, "ffmpegのvolumedetect結果から最大音量を取得できませんでした").toBeTruthy();
  return Number(m![1]);
}

test("audio-convert: WAV→MP3 に変換でき、実際にMP3として再生できる長さで出力される", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/audio-convert");
  await uploadAndWait(page, fixtures.audioWav);

  await page.locator("label", { hasText: /^MP3$/ }).click();
  await page.getByRole("button", { name: "変換する" }).click();
  await waitForSuccess(page, "変換が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  expect(download.suggestedFilename()).toMatch(/\.mp3$/);
  const { path } = await assertDownloadedFile(download, { minBytes: 1000 });
  const info = probe(path);
  expect(info.codec).toBe("mp3");
  expect(info.duration).toBeGreaterThan(1.8);
  expect(info.duration).toBeLessThan(2.4);
});

test("audio-convert: WAV→FLAC に変換できる", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/audio-convert");
  await uploadAndWait(page, fixtures.audioWav);

  // FLACはブラウザによって書き出し非対応の場合があるため、選択肢があるときだけ検証する。
  // （対応状況の調査が終わるとMP3などの選択肢が出る。それまで待ってから判定する）
  const flac = page.locator("label", { hasText: /^FLAC$/ });
  await expect(page.locator("label", { hasText: /^WAV$/ })).toBeVisible({ timeout: 15_000 });
  test.skip((await flac.count()) === 0, "このブラウザはFLAC書き出しに対応していません");
  await flac.click();
  await page.getByRole("button", { name: "変換する" }).click();
  await waitForSuccess(page, "変換が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 500 });
  expect(probe(path).codec).toBe("flac");
});

test("audio-convert: M4A→MP3 に変換できる（ブラウザがAACを読める場合）", async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!fs.existsSync(fixtures.audioM4a), "M4Aフィクスチャを作成できない環境");
  await page.goto("/tools/audio-convert");
  const canDecodeAac = await page.evaluate(async () => {
    if (typeof AudioDecoder === "undefined") return false;
    const r = await AudioDecoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2 });
    return !!r.supported;
  });
  test.skip(!canDecodeAac, "このブラウザはAACのデコードに対応していません");

  await uploadAndWait(page, fixtures.audioM4a);
  await page.locator("label", { hasText: /^MP3$/ }).click();
  await page.getByRole("button", { name: "変換する" }).click();
  await waitForSuccess(page, "変換が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1000 });
  expect(probe(path).codec).toBe("mp3");
});

test("audio-convert: 書き出せない形式は選択肢に出ない（MP3は常に選べる）", async ({ page }) => {
  await page.goto("/tools/audio-convert");
  await uploadAndWait(page, fixtures.audioWav);
  await expect(page.locator("label", { hasText: /^MP3$/ })).toBeVisible({ timeout: 15_000 });
  const supported = await page.evaluate(async () => {
    const check = async (codec: string) =>
      typeof AudioEncoder !== "undefined" &&
      !!(await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported;
    return { aac: await check("mp4a.40.2"), flac: await check("flac"), opus: await check("opus") };
  });
  // ブラウザがエンコードできない形式は、選ばせてエラーにするのではなく最初から出さない
  expect(await page.locator("label", { hasText: /^M4A（AAC）$/ }).count()).toBe(supported.aac ? 1 : 0);
  expect(await page.locator("label", { hasText: /^OGG（Opus）$/ }).count()).toBe(supported.opus ? 1 : 0);
});

test("audio-convert: 音声ではないファイルを選ぶと、分かりやすいエラーが表示される", async ({ page }) => {
  await page.goto("/tools/audio-convert");
  // 拡張子が対象外のファイルはドロップゾーン側で弾かれ、エラーが表示されて変換ボタンは出ない
  const error = page.getByRole("alert");
  for (let attempt = 0; attempt < 5 && !(await error.first().isVisible()); attempt++) {
    await uploadFixture(page, fixtures.txt);
    await error.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
  }
  await expect(error.first()).toBeVisible();
  await expect(page.getByRole("button", { name: "変換する" })).toHaveCount(0);
});

test("audio-trim: 終了位置を1秒に指定すると、約1秒に切り出される", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/audio-trim");
  await uploadAndWait(page, fixtures.audioWav);

  const end = page.getByLabel("終了位置", { exact: true });
  await expect(end).toBeVisible({ timeout: 20_000 });
  await end.fill("1");
  await end.press("Enter");

  await page.getByRole("button", { name: "切り出す" }).click();
  await waitForSuccess(page, "切り出しが完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1000 });
  const info = probe(path);
  expect(info.codec).toMatch(/^pcm_/);
  expect(info.duration).toBeGreaterThan(0.85);
  expect(info.duration).toBeLessThan(1.15);
});

test("audio-merge: 形式の違う2つの音声を結合すると、長さが合計になる", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/audio-merge");
  await uploadAndWait(page, [fixtures.audioWav, fixtures.audioWavMono]);

  await page.locator("label", { hasText: /^MP3$/ }).click();
  await page.getByRole("button", { name: "結合する" }).click();
  await waitForSuccess(page, "結合が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  expect(download.suggestedFilename()).toMatch(/\.mp3$/);
  const { path } = await assertDownloadedFile(download, { minBytes: 1000 });
  const info = probe(path);
  expect(info.codec).toBe("mp3");
  // 2秒 + 1秒 = 3秒（エンコーダの前後の余白を考慮して幅を持たせる）
  expect(info.duration).toBeGreaterThan(2.8);
  expect(info.duration).toBeLessThan(3.4);
});

test("audio-volume: ノーマライズで最大音量が目標値（−1dB）付近に揃う", async ({ page }) => {
  test.setTimeout(90_000);
  // 元の純音は小さめ（約−18dB）。処理前の最大音量も確認しておく。
  expect(maxVolumeDb(fixtures.audioWav)).toBeLessThan(-10);

  await page.goto("/tools/audio-volume");
  await uploadAndWait(page, fixtures.audioWav);
  await page.locator("label", { hasText: "ノーマライズ" }).click();
  await page.getByRole("button", { name: "音量を調整する" }).click();
  await waitForSuccess(page, "音量の調整が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1000 });
  const after = maxVolumeDb(path);
  expect(after).toBeGreaterThan(-2);
  expect(after).toBeLessThan(0);
});

test("audio-volume: +6dBで最大音量が約6dB上がる", async ({ page }) => {
  test.setTimeout(90_000);
  const before = maxVolumeDb(fixtures.audioWav);

  await page.goto("/tools/audio-volume");
  await uploadAndWait(page, fixtures.audioWav);
  // 既定が+6dB
  await page.getByRole("button", { name: "音量を調整する" }).click();
  await waitForSuccess(page, "音量の調整が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1000 });
  const diff = maxVolumeDb(path) - before;
  expect(diff).toBeGreaterThan(5);
  expect(diff).toBeLessThan(7);
});

test("audio-compress: WAVを64kbpsのMP3に圧縮すると、ファイルサイズが大きく小さくなる", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/audio-compress");
  await uploadAndWait(page, fixtures.audioWav);

  await page.locator("label", { hasText: /^64kbps$/ }).click();
  await page.getByRole("button", { name: "圧縮する" }).click();
  await waitForSuccess(page, "圧縮が完了しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path, size } = await assertDownloadedFile(download, { minBytes: 500 });
  expect(probe(path).codec).toBe("mp3");
  expect(size).toBeLessThan(fs.statSync(fixtures.audioWav).size / 5);
});

test("audio-extract: 音声付き動画（MP4）から音声を取り出せる（ブラウザがAACを読める場合）", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/audio-extract");
  const canDecodeAac = await page.evaluate(async () => {
    if (typeof AudioDecoder === "undefined") return false;
    const r = await AudioDecoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2 });
    return !!r.supported;
  });
  test.skip(!canDecodeAac, "このブラウザはAACのデコードに対応していません");

  await uploadAndWait(page, fixtures.videoWithMetadataMp4);
  await page.getByRole("button", { name: "音声を取り出す" }).click();
  await waitForSuccess(page, "音声を取り出しました", 60_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 500 });
  expect(probe(path).duration).toBeGreaterThan(0.5);
});

test("audio-extract: 音声のない動画では、分かりやすいエラーが表示される", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/tools/audio-extract");
  await uploadAndWait(page, fixtures.webm);
  await page.getByRole("button", { name: "音声を取り出す" }).click();
  await expect(page.getByText("音声が含まれていません", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
});

test("licenses: ライセンス表記ページが表示され、フッターからリンクされている", async ({ page }) => {
  await page.goto("/licenses");
  await expect(page.getByRole("heading", { level: 1, name: "オープンソースライセンス表記" })).toBeVisible();
  await expect(page.getByText("MPL-2.0").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "LAME MP3 Encoder" })).toBeVisible();
  await expect(page.locator('a[href="https://lame.sourceforge.io/license.txt"]')).toBeVisible();

  await page.goto("/");
  await expect(page.locator('footer a[href="/licenses"]')).toBeVisible();
});
