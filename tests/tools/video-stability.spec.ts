import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test as baseTest } from "@playwright/test";
import type { Download, Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, closeResultPopup } from "../helpers/tool-runner";
import { BlobAssembler, moveMoovToFront, shiftChunkOffsets } from "@/lib/video/stream-output";
import { discardReasonMessage, toFriendlyVideoError, VideoUserFacingError } from "@/lib/video/shared";

/**
 * 動画編集 工程1（8ツール共通の安定性・メモリ・音声保持）のテスト。
 * - 書き出し：少しずつBlobにする方式（BlobAssembler）と、MP4の moov を先頭へ移す処理（moveMoovToFront）
 * - 音声保持：音声を書き出せない環境では、何も知らせずに無音の動画を作らない
 * - エラー：内部のエラーコード（英語）をそのまま出さない
 * - 結果のリセット：動画を消すと、前の結果が残らない
 * 出力ファイルは ffprobe / ffmpeg で、箱の並び・音声トラック・音声の中身（無音でないこと）まで確かめる。
 */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-stab-"));

/** MP4の最上位の箱（box）の種類を、先頭から順に返す */
function topLevelBoxes(file: string): string[] {
  const buf = fs.readFileSync(file);
  const types: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(off + 8));
    else if (size === 0) size = buf.length - off;
    types.push(type);
    if (size < 8) break;
    off += size;
  }
  return types;
}

function streams(file: string): string[] {
  return execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]).toString().trim().split(/\s+/).filter(Boolean);
}

/** 最後まで読み込んで、デコードのエラーが出ないこと（壊れたファイルでないこと）を確かめる */
function decodesCleanly(file: string): void {
  const out = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  expect(out.toString().trim()).toBe("");
}

/** 音声の平均の大きさ（dB）。無音なら -91dB 程度になる（volumedetect の結果は標準エラーに出る） */
function meanVolume(file: string): number {
  const r = spawnSync("ffmpeg", ["-v", "info", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr ?? "")?.[1] ?? NaN);
}

async function saveDownload(download: Download): Promise<string> {
  const dest = path.join(tmpDir(), download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

async function downloadResult(page: Page): Promise<string> {
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 90_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "ダウンロード" }).click();
  return saveDownload(await wait);
}

/** この環境のブラウザで、音声の書き出し（AudioEncoder）ができないように見せかける（対応していないブラウザの再現） */
async function disableAudioEncoding(page: Page) {
  await page.addInitScript(() => {
    if (typeof AudioEncoder !== "undefined") {
      AudioEncoder.isConfigSupported = async (config: AudioEncoderConfig) => ({ supported: false, config });
    }
  });
}

// ---------------------------------------------------------------------------
// 書き出しの仕組み（ブラウザを使わない確認）
// ---------------------------------------------------------------------------

baseTest.describe("書き出しの仕組み", () => {
  baseTest("BlobAssembler: 後ろへの追加と、前の位置への書き直しを、正しく1つのファイルにまとめる", async () => {
    const a = new BlobAssembler();
    a.write(0, new Uint8Array([1, 2, 3, 4]));
    a.write(4, new Uint8Array([5, 6, 7, 8]));
    a.write(8, new Uint8Array([9, 10]));
    a.write(2, new Uint8Array([30, 40, 50])); // 2つの小片にまたがる書き直し
    a.write(0, new Uint8Array([100])); // 先頭の書き直し
    a.write(9, new Uint8Array([11, 12])); // 最後をはみ出す書き直し
    expect(a.size).toBe(11);
    const bytes = Array.from(new Uint8Array(await a.toBlob("video/mp4").arrayBuffer()));
    expect(bytes).toEqual([100, 2, 30, 40, 50, 6, 7, 8, 9, 11, 12]);
    a.clear();
    expect(a.size).toBe(0);
  });

  baseTest("moveMoovToFront: moov が最後にあるMP4を、先頭に moov がある正しいMP4に並べ替える（映像・音声とも壊れない）", async () => {
    const dir = tmpDir();
    const src = path.join(dir, "moov-at-end.mp4");
    // ffmpeg の既定（-movflags を付けない）では、moov はファイルの最後に置かれる
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", src]);
    expect(topLevelBoxes(src).indexOf("moov")).toBeGreaterThan(topLevelBoxes(src).indexOf("mdat"));

    const moved = await moveMoovToFront(new Blob([fs.readFileSync(src)], { type: "video/mp4" }));
    const out = path.join(dir, "moved.mp4");
    fs.writeFileSync(out, Buffer.from(await moved.arrayBuffer()));
    const boxes = topLevelBoxes(out);
    expect(boxes[0]).toBe("ftyp");
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
    expect(moved.size).toBe(fs.statSync(src).size);
    expect(streams(out).sort()).toEqual(["audio", "video"]);
    decodesCleanly(out);
    expect(meanVolume(out)).toBeGreaterThan(-40);
  });

  baseTest("moveMoovToFront: すでに先頭に moov があるファイル・MP4でないものは、そのまま返す", async () => {
    // 1回並べ替えたもの（moov が先頭）を、もう一度渡しても変わらない
    const fast = await moveMoovToFront(new Blob([fs.readFileSync(fixtures.videoWithMetadataMp4)], { type: "video/mp4" }));
    expect(await moveMoovToFront(fast)).toBe(fast);
    const notMp4 = new Blob([new Uint8Array([1, 2, 3])]);
    expect(await moveMoovToFront(notMp4)).toBe(notMp4);
  });

  baseTest("shiftChunkOffsets: 32ビットの位置の表に収まらないときは、並べ替えをやめる（false）", () => {
    // stco（値は 0xFFFFFFF0 の1件）だけを入れた stbl > minf > mdia > trak > moov
    const stco = Buffer.alloc(20);
    stco.writeUInt32BE(20, 0);
    stco.write("stco", 4, "latin1");
    stco.writeUInt32BE(1, 12);
    stco.writeUInt32BE(0xfffffff0, 16);
    const wrap = (type: string, inner: Buffer) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(8 + inner.length, 0);
      h.write(type, 4, "latin1");
      return Buffer.concat([h, inner]);
    };
    const moov = wrap("moov", wrap("trak", wrap("mdia", wrap("minf", wrap("stbl", stco)))));
    expect(shiftChunkOffsets(new Uint8Array(moov), 0x100)).toBe(false);
    expect(shiftChunkOffsets(new Uint8Array(moov), 0x5)).toBe(true);
  });
});

baseTest.describe("エラーの日本語化（ブラウザを使わない確認）", () => {
  baseTest("内部のエラー（英語）は、原因に合った日本語の案内になる。元のエラーは cause に残る", () => {
    const enc = toFriendlyVideoError(Object.assign(new Error("Encoding error."), { name: "EncodingError" }));
    expect(enc).toBeInstanceOf(VideoUserFacingError);
    expect(enc.message).toContain("書き出せませんでした");
    expect((enc as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);

    expect(toFriendlyVideoError(new Error("Decoding error: bad bitstream")).message).toContain("読み込めませんでした");
    expect(toFriendlyVideoError(new RangeError("Array buffer allocation failed")).message).toContain("メモリが不足");
    const unknown = toFriendlyVideoError(new Error("Something odd happened (code 42)"));
    expect(unknown.message).toContain("問題が発生しました");
    expect(unknown.message).not.toMatch(/[A-Za-z]{4,}/);
    // すでに日本語の案内は、そのまま使う
    expect(toFriendlyVideoError(new Error("この動画形式には対応していません。")).message).toBe("この動画形式には対応していません。");
  });

  baseTest("トラックが外された理由（no_encodable_target_codec など）は、日本語の案内になる", () => {
    for (const reason of ["no_encodable_target_codec", "undecodable_source_codec", "unknown_source_codec", "cannot_copy", "max_track_count_reached"]) {
      for (const kind of ["video", "audio"] as const) {
        const m = discardReasonMessage(kind, reason, "webm");
        expect(m, `${kind}:${reason}`).not.toContain(reason);
        expect(m).toMatch(/[ぁ-んァ-ン]/);
      }
    }
    expect(discardReasonMessage("video", "no_encodable_target_codec", "webm")).toContain("WebM");
  });
});

// ---------------------------------------------------------------------------
// 画面での確認
// ---------------------------------------------------------------------------

test.describe("書き出したファイルの中身", () => {
  test.setTimeout(120_000);

  test("メタデータ削除（MP4）: moov が先頭にあり、映像・音声とも最後まで読め、音声は無音でない", async ({ page }) => {
    await page.goto("/tools/video-metadata-remove");
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByRole("button", { name: "メタデータを削除する" }).click();
    const out = await downloadResult(page);
    const boxes = topLevelBoxes(out);
    expect(boxes[0]).toBe("ftyp");
    expect(boxes.indexOf("moov")).toBeGreaterThan(-1);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
    expect(streams(out).sort()).toEqual(["audio", "video"]);
    decodesCleanly(out);
    expect(meanVolume(out)).toBeGreaterThan(-40);
  });

  test("圧縮（MP4）: 音声付きの動画を圧縮しても、音声が残る。moov は先頭", async ({ page }) => {
    await page.goto("/tools/video-compress");
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByRole("button", { name: "圧縮する" }).click();
    const out = await downloadResult(page);
    expect(topLevelBoxes(out).indexOf("moov")).toBeLessThan(topLevelBoxes(out).indexOf("mdat"));
    expect(streams(out).sort()).toEqual(["audio", "video"]);
    decodesCleanly(out);
    expect(meanVolume(out)).toBeGreaterThan(-40);
  });

  test("形式変換（MP4→WebM）: この環境で音声を書き出せるときは、音声が残る", async ({ page }) => {
    await page.goto("/tools/video-convert");
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByText("WebM", { exact: true }).first().click();
    await page.getByRole("button", { name: "変換する" }).click();
    const out = await downloadResult(page);
    expect(out.endsWith(".webm")).toBe(true);
    expect(streams(out).sort()).toEqual(["audio", "video"]);
    decodesCleanly(out);
    expect(meanVolume(out)).toBeGreaterThan(-40);
  });
});

test.describe("音声を書き出せない環境", () => {
  test.setTimeout(120_000);

  test("WebMの音声を作れないときは、黙って無音にせず案内を出す。「音声なしで書き出す」を選ぶと映像だけで書き出せる", async ({ page }) => {
    await disableAudioEncoding(page);
    await page.goto("/tools/video-convert");
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByText("WebM", { exact: true }).first().click();
    await page.getByRole("button", { name: "変換する" }).click();
    const notice = page.getByTestId("video-audio-loss");
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice).toContainText("音声を残せません");
    await expect(notice).toContainText("WebM");
    await expect(notice).not.toContainText("no_encodable");
    await expect(page.getByTestId("result-popup")).toHaveCount(0);

    await notice.getByRole("button", { name: "音声なしで書き出す" }).click();
    const out = await downloadResult(page);
    expect(streams(out)).toEqual(["video"]);
    decodesCleanly(out);
  });

  test("同じ環境でも、音声をそのまま使えるMP4への変換では音声が残る（不要な案内を出さない）", async ({ page }) => {
    await disableAudioEncoding(page);
    await page.goto("/tools/video-metadata-remove");
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByRole("button", { name: "メタデータを削除する" }).click();
    const out = await downloadResult(page);
    await expect(page.getByTestId("video-audio-loss")).toHaveCount(0);
    expect(streams(out).sort()).toEqual(["audio", "video"]);
  });

  test("元の動画に音声がないときは、音声の案内を出さない", async ({ page }) => {
    await disableAudioEncoding(page);
    await page.goto("/tools/video-convert");
    await uploadFixture(page, fixtures.webm); // 映像だけのWebM
    await page.getByRole("button", { name: "変換する" }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("video-audio-loss")).toHaveCount(0);
  });

  test("映像を書き出せないときは、内部のコードではなく日本語の案内を出す", async ({ page }) => {
    await page.addInitScript(() => {
      if (typeof VideoEncoder !== "undefined") {
        VideoEncoder.isConfigSupported = async (config: VideoEncoderConfig) => ({ supported: false, config });
      }
    });
    await page.goto("/tools/video-compress");
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByRole("button", { name: "圧縮する" }).click();
    const alert = page.locator("main [role=alert].border");
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(alert).toContainText("書き出せません");
    await expect(alert).not.toContainText("no_encodable");
    await expect(alert).not.toContainText("_");
  });
});

test.describe("動画を消したときの結果のリセット", () => {
  test.setTimeout(120_000);

  for (const tool of [
    { id: "video-compress", run: "圧縮する" },
    { id: "video-convert", run: "変換する" },
    { id: "video-metadata-remove", run: "メタデータを削除する" },
  ]) {
    test(`${tool.id}: 処理後に動画を消すと、結果・保存ボタン・プレビューが消え、別の動画で処理し直せる`, async ({ page }) => {
      await page.goto(`/tools/${tool.id}`);
      await uploadFixture(page, fixtures.videoWithMetadataMp4);
      await page.getByRole("button", { name: tool.run, exact: true }).click();
      await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 90_000 });
      await closeResultPopup(page);
      await page.getByRole("button", { name: "video-with-metadata.mp4 を削除" }).click();
      await expect(page.getByTestId("result-popup")).toHaveCount(0);
      await expect(page.getByTestId("result-popup-reopen")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
      await expect(page.locator("main video")).toHaveCount(0);
      await expect(page.locator("main [role=alert].border")).toHaveCount(0);

      await uploadFixture(page, fixtures.webm);
      await page.getByRole("button", { name: tool.run, exact: true }).click();
      await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 90_000 });
    });
  }

  test("サムネイル抽出: 抽出後に動画を消すと、結果が消える", async ({ page }) => {
    await page.goto("/tools/video-thumbnail");
    await uploadFixture(page, fixtures.webm);
    await page.getByRole("button", { name: "この時点を抽出する" }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    await closeResultPopup(page);
    await page.getByRole("button", { name: "sample.webm を削除" }).click();
    await expect(page.getByTestId("result-popup-reopen")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "画像をダウンロード" })).toHaveCount(0);
  });

  test("処理中に動画を消すと、処理が止まり、あとから前の結果が表示されない", async ({ page }) => {
    const dir = tmpDir();
    const longer = path.join(dir, "longer.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "8M", "-c:a", "aac", "-pix_fmt", "yuv420p", longer]);
    await page.goto("/tools/video-compress");
    await uploadFixture(page, longer);
    await page.getByRole("button", { name: "圧縮する" }).click();
    await expect(page.getByText(/圧縮中\.\.\. \d+%/)).toBeVisible({ timeout: 30_000 });
    // 処理中は画面全体が覆われるため、利用者の操作の代わりに、削除ボタンのクリックを直接発生させる
    await page.getByRole("button", { name: "longer.mp4 を削除" }).dispatchEvent("click");
    await expect(page.getByText(/圧縮中\.\.\. \d+%/)).toHaveCount(0, { timeout: 15_000 });
    // 前の処理の結果が、あとから届いて表示されないこと（十分に待つ）
    await page.waitForTimeout(8_000);
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    await expect(page.getByTestId("result-popup-reopen")).toHaveCount(0);
    await expect(page.getByText("処理をキャンセルしました。")).toHaveCount(0);
    // 続けて別の動画で処理できる
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await page.getByRole("button", { name: "圧縮する" }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 90_000 });
  });
});

