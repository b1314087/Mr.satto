import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import {
  THUMBNAIL_MAX_COUNT,
  planEven,
  planFromInterval,
  planFromTimes,
  thumbnailFileNames,
  timeForFileName,
} from "@/lib/video/thumbnail-plan";

/**
 * 動画編集 工程4：動画サムネイルの複数抽出のテスト。
 * - 取り出す時刻の決め方（指定した時刻・一定の間隔・均等に）、上限、重複、ファイル名（ブラウザを使わない確認）
 * - 画面：まとめて抽出 → 一覧（時刻・画像・ファイル名）→ 1枚ずつ保存・ZIPで保存、キャンセル、1枚の抽出が今までどおり
 */

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

plainTest("指定した時刻：並べて入れた時刻を小さい順にし、同じ時刻は1回だけ。読めない時刻・長さを超える時刻は理由を出す", () => {
  const p = planFromTimes("0:15\n0:05, 0:30、1:00 0:05", 90);
  plainExpect(p.times).toEqual([5, 15, 30, 60]);
  plainExpect(p.error).toBeNull();
  plainExpect(p.note).toContain("同じ時刻");
  plainExpect(planFromTimes("0:05\nabc", 90).error).toContain("abc");
  plainExpect(planFromTimes("0:05\n2:00", 90).error).toContain("2:00");
  plainExpect(planFromTimes("", 90).error).toContain("時刻を入れて");
  plainExpect(planFromTimes("１：３０", 120).times).toEqual([90]);
});

plainTest("一定の間隔：0秒から、間隔ごとに動画の長さまで。上限を超えるときは実行できない", () => {
  plainExpect(planFromInterval(10, 35).times).toEqual([0, 10, 20, 30]);
  plainExpect(planFromInterval(10, 30).times).toEqual([0, 10, 20]);
  plainExpect(planFromInterval(5, 4).times).toEqual([0]);
  const over = planFromInterval(5, 5 * THUMBNAIL_MAX_COUNT + 1);
  plainExpect(over.times).toEqual([]);
  plainExpect(over.error).toContain(`${THUMBNAIL_MAX_COUNT}枚まで`);
  plainExpect(planFromInterval(5, 5 * THUMBNAIL_MAX_COUNT).error).toBeNull();
});

plainTest("均等に：最初と最後のコマを含めて等しい間隔。1枚なら真ん中。短い動画では同じコマを省く", () => {
  const p = planEven(5, 10.1, 30);
  plainExpect(p.times[0]).toBe(0);
  plainExpect(p.times).toHaveLength(5);
  plainExpect(p.times[4]).toBeCloseTo(10.1 - 1 / 30, 2);
  plainExpect(planEven(1, 10, 30).times[0]).toBeCloseTo(4.983, 2);
  const short = planEven(20, 0.3, 30);
  plainExpect(short.times.length).toBeLessThan(20);
  plainExpect(short.note).toContain("省きました");
  plainExpect(planEven(THUMBNAIL_MAX_COUNT + 1, 100).error).toContain("枚まで");
});

plainTest("ファイル名：時刻が入り、重ならず、使えない文字は置き換える", () => {
  plainExpect(timeForFileName(5)).toBe("0005");
  plainExpect(timeForFileName(65.5)).toBe("0105-5");
  plainExpect(timeForFileName(3723)).toBe("010203");
  plainExpect(thumbnailFileNames("video", [5, 15, 30], "png")).toEqual(["video-thumbnail-0005.png", "video-thumbnail-0015.png", "video-thumbnail-0030.png"]);
  const names = thumbnailFileNames("a:b", [5, 5.01], "jpg");
  plainExpect(new Set(names).size).toBe(2);
  plainExpect(names[0]).not.toContain(":");
});

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

let dir = "";
let video = "";

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-multi-"));
  video = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function open(page: Page) {
  await page.goto("/tools/video-thumbnail");
  await uploadFixture(page, video);
  await expect(page.getByTestId("thumb-mode")).toBeVisible();
  await expect(page.getByText(/抽出する時点: 0:00 \/ 0:12/)).toBeVisible({ timeout: 30_000 });
}

async function chooseMode(page: Page, label: string) {
  await page.getByTestId("thumb-mode").getByText(label, { exact: true }).click();
}

function pngSize(buf: Buffer) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test("指定した時刻：まとめて抽出し、一覧に時刻・画像・ファイル名が出る。1枚ずつ保存でき、ZIPにも全部入る（PNG）", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await chooseMode(page, "指定した時刻");
  await page.getByTestId("thumb-times").fill("0:05\n0:01\n0:10, 0:05");
  await expect(page.getByTestId("thumb-plan-summary")).toHaveText("3枚を取り出します：0:01.0、0:05.0、0:10.0");
  await page.getByTestId("thumb-batch-run").click();
  await expect(page.getByTestId("thumb-results")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("thumb-item")).toHaveCount(3);
  await expect(page.getByTestId("thumb-item-time")).toHaveText(["0:01.0", "0:05.0", "0:10.0"]);
  await expect(page.getByTestId("thumb-item-name").first()).toContainText("clip-thumbnail-0001.png");

  const wait = page.waitForEvent("download");
  await page.getByTestId("thumb-item-save").nth(1).click();
  const one = await wait;
  plainExpect(one.suggestedFilename()).toBe("clip-thumbnail-0005.png");
  const onePath = path.join(dir, one.suggestedFilename());
  await one.saveAs(onePath);
  plainExpect(pngSize(fs.readFileSync(onePath))).toEqual({ w: 640, h: 360 });

  const zipWait = page.waitForEvent("download");
  await page.getByRole("button", { name: "3枚をZIPで保存" }).click();
  const zip = await zipWait;
  plainExpect(zip.suggestedFilename()).toBe("clip-thumbnails.zip");
  const zipPath = path.join(dir, "out.zip");
  await zip.saveAs(zipPath);
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  plainExpect(Object.keys(entries).sort()).toEqual(["clip-thumbnail-0001.png", "clip-thumbnail-0005.png", "clip-thumbnail-0010.png"]);
  // 時刻ごとに違うコマ（中身が違う）
  const sizes = Object.values(entries).map((b) => b.length);
  plainExpect(new Set(sizes).size).toBe(3);
});

test("一定の間隔（5秒ごと・JPEG）と、均等に（3枚）で抽出できる", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await chooseMode(page, "一定の間隔");
  await page.getByTestId("thumb-plan").getByText("5秒ごと", { exact: true }).click();
  await page.getByText("JPEG", { exact: true }).click();
  await expect(page.getByTestId("thumb-plan-summary")).toHaveText("3枚を取り出します：0:00.0、0:05.0、0:10.0");
  await page.getByTestId("thumb-batch-run").click();
  await expect(page.getByTestId("thumb-item")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("thumb-item-name").last()).toContainText("clip-thumbnail-0010.jpg");
  const wait = page.waitForEvent("download");
  await page.getByTestId("thumb-item-save").first().click();
  const jpg = await wait;
  const p = path.join(dir, jpg.suggestedFilename());
  await jpg.saveAs(p);
  plainExpect(fs.readFileSync(p).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

  await chooseMode(page, "均等に");
  await page.getByTestId("thumb-plan").getByText("3枚", { exact: true }).click();
  await expect(page.getByTestId("thumb-plan-summary")).toContainText("3枚を取り出します：0:00.0、0:06.0");
  await page.getByTestId("thumb-batch-run").click();
  await expect(page.getByTestId("thumb-item")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByTestId("thumb-results-summary")).toContainText("3枚");
});

test("不正な時刻・長さを超える時刻・上限を超える枚数は、理由を出して実行できない", async ({ page }) => {
  await open(page);
  await chooseMode(page, "指定した時刻");
  const run = page.getByTestId("thumb-batch-run");
  await page.getByTestId("thumb-times").fill("0:05\n1:7x");
  await expect(page.getByTestId("thumb-plan-error")).toContainText("1:7x");
  await expect(run).toBeDisabled();
  await page.getByTestId("thumb-times").fill("0:05\n0:30");
  await expect(page.getByTestId("thumb-plan-error")).toContainText("動画の長さ");
  await expect(run).toBeDisabled();
  const many = Array.from({ length: THUMBNAIL_MAX_COUNT + 1 }, (_, i) => (i * 0.3).toFixed(1)).join("\n");
  await page.getByTestId("thumb-times").fill(many);
  await expect(page.getByTestId("thumb-plan-error")).toContainText(`${THUMBNAIL_MAX_COUNT}枚まで`);
  await expect(run).toBeDisabled();
  // 「今の位置を足す」で、動画の位置が一覧に入る
  await page.getByTestId("thumb-times").fill("");
  await page.getByTestId("thumb-add-current").click();
  await expect(page.getByTestId("thumb-times")).toHaveValue("0:00.0");
  await expect(run).toBeEnabled();
});

test("まとめて抽出をキャンセルすると、途中の画像は出さない", async ({ page }) => {
  test.setTimeout(120_000);
  // 1枚ずつの取り出しを遅くして、途中で止める
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      setTimeout(() => orig.call(this, cb, ...rest), 700);
    };
  });
  await open(page);
  await chooseMode(page, "均等に");
  await page.getByTestId("thumb-plan").getByText("10枚", { exact: true }).click();
  await page.getByTestId("thumb-batch-run").click();
  await expect(page.getByRole("status").filter({ hasText: /\/ 10 枚を抽出中/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByText("処理をキャンセルしました。")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("thumb-results")).toHaveCount(0);
});

test("一部の時刻を取り出せなかったときは、成功と区別して知らせ、取り出せた分だけを保存できる", async ({ page }) => {
  test.setTimeout(120_000);
  // 2回目の画像化だけ失敗させる
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.toBlob;
    let n = 0;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      n++;
      if (n === 2) {
        cb(null);
        return;
      }
      orig.call(this, cb, ...rest);
    };
  });
  await open(page);
  await chooseMode(page, "指定した時刻");
  await page.getByTestId("thumb-times").fill("0:01\n0:03\n0:05");
  await page.getByTestId("thumb-batch-run").click();
  await expect(page.getByRole("alert").filter({ hasText: "1枚を取り出せませんでした（0:03.0）" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("thumb-item")).toHaveCount(2);
  await expect(page.getByTestId("thumb-results-summary")).toContainText("1枚は失敗");
  await expect(page.getByRole("button", { name: "取り出せた2枚をZIPで保存" })).toBeVisible();
});

test("「1枚（この時点）」は今までどおり：スライダーの時点を抽出し、ポップアップから保存できる", async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await expect(page.getByTestId("thumb-mode").getByRole("radio", { name: "1枚（この時点）" })).toBeChecked();
  await page.getByRole("slider", { name: "抽出する時点" }).fill("4");
  await page.getByRole("button", { name: "この時点を抽出する" }).click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 60_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "画像をダウンロード" }).click();
  plainExpect((await wait).suggestedFilename()).toBe("clip-thumbnail.png");
});
