import { execFileSync } from "node:child_process";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 動画カテゴリの代表E2E（Phase 14）。
 *
 * video-thumbnail: フル E2E（サムネイル画像として動画の1コマを抽出しダウンロード）。
 * video-convert / video-compress: Phase 13で既知の課題として文書化されている
 * WebCodecs依存・ブラウザによる対応差のリスクがあり、テスト用の極小WebM
 * フィクスチャでの変換完走を安定的に自動検証するのは今回のスコープでは難しいと
 * 判断し、意図的にsmokeレベル（ページが開ける・動画ファイルを受け付けられる）に
 * 留める。既知の課題を自動テスト追加のついでに「直す」ことはしない
 * （Phase 14の方針どおり）。
 */

test("video-thumbnail: 動画から1コマを抽出し画像としてダウンロードできる", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/tools/video-thumbnail");
  await uploadFixture(page, fixtures.webm);

  await page.getByRole("button", { name: "この時点を抽出する" }).click();
  await waitForSuccess(page, "完了", 45_000);

  const download = await clickAndDownload(page, "画像をダウンロード");
  await assertDownloadedFile(download, { minBytes: 10 });
});

test("video-convert: 動画ファイルを受け付けられる（smoke）", async ({ page }) => {
  await page.goto("/tools/video-convert");
  await uploadFixture(page, fixtures.webm);
  await expect(page.getByRole("button", { name: "変換する" })).toBeVisible();
});

test("video-compress: 動画ファイルを受け付けられる（smoke）", async ({ page }) => {
  await page.goto("/tools/video-compress");
  await uploadFixture(page, fixtures.webm);
  await expect(page.getByRole("button", { name: "圧縮する" })).toBeVisible();
});

test("video-metadata-remove: 動画ファイルを受け付けられる（smoke）", async ({ page }) => {
  await page.goto("/tools/video-metadata-remove");
  await uploadFixture(page, fixtures.webm);
  await expect(page.getByRole("button", { name: "メタデータを削除する" })).toBeVisible();
});

test("video-metadata-remove: タイトル・作成者・コメントのメタデータが実際に消え、映像・音声は保たれる", async ({
  page,
}) => {
  test.setTimeout(60_000);

  // 処理前: ffmpegで明示的に埋め込んだメタデータが存在することを確認しておく
  // （フィクスチャ生成側の前提が崩れていないことの確認も兼ねる）。
  const beforeTags = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format_tags=title,artist,comment",
    "-of",
    "default=noprint_wrappers=0",
    fixtures.videoWithMetadataMp4,
  ]).toString();
  expect(beforeTags).toContain("TestTitle");
  expect(beforeTags).toContain("TestArtist");
  expect(beforeTags).toContain("TestComment");

  await page.goto("/tools/video-metadata-remove");
  await uploadFixture(page, fixtures.videoWithMetadataMp4);

  await page.getByRole("button", { name: "メタデータを削除する" }).click();
  await waitForSuccess(page, "完了", 45_000);

  const download = await clickAndDownload(page, "ダウンロード");
  const { path: outputPath } = await assertDownloadedFile(download, { minBytes: 100 });

  // 処理後: 埋め込んだメタデータタグが実際に消えていることを確認する
  // （単なるファイル名変更やコンテナのコピーでは消えないことの検証）。
  const afterTags = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format_tags=title,artist,comment",
    "-of",
    "default=noprint_wrappers=0",
    outputPath,
  ]).toString();
  expect(afterTags).not.toContain("TestTitle");
  expect(afterTags).not.toContain("TestArtist");
  expect(afterTags).not.toContain("TestComment");

  // 映像・音声トラックそのものは保たれていることを確認する（メタデータだけを
  // 取り除き、中身を壊していないことの確認）。
  const streamInfo = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "default=noprint_wrappers=0",
    outputPath,
  ]).toString();
  expect(streamInfo).toContain("codec_type=video");
  expect(streamInfo).toContain("codec_type=audio");
});
