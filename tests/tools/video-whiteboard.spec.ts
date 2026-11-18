import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as plainTest } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import { arrangeInGrid, boardDuration, boardSize, localTime } from "@/lib/video/board-layout";

/**
 * 動画ホワイトボード（2026-11-19）のテスト。
 * - 並べ方・長さ・時刻の計算（画面なし）
 * - 画面：動画を置く・動かす・形を変える・同時に再生
 * - 書き出し：大きさ・長さ・映像の位置（色で確かめる）・音声の有無・短い動画を最後の場面で止める
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-board-"));

function colorVideo(name: string, color: string, sec: number, freq: number | null): string {
  const out = path.join(tmp(), name);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=320x180:r=30:d=${sec}`,
    ...(freq ? ["-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000`] : []),
    "-t", String(sec), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(freq ? ["-c:a", "aac"] : []),
    out,
  ]);
  return out;
}

function probe(file: string): { width: number; height: number; duration: number; audio: boolean } {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file]).toString()) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video")!;
  return { width: v.width!, height: v.height!, duration: Number(j.format.duration), audio: j.streams.some((s) => s.codec_type === "audio") };
}

/** 書き出した動画の、指定した時刻・位置（0〜1）の色 */
function colorAt(file: string, sec: number, fx: number, fy: number): [number, number, number] {
  const png = path.join(tmp(), "f.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(sec), "-i", file, "-frames:v", "1", png]);
  const out = execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB')\nw,h=im.size\nprint(*im.getpixel((int(w*float(sys.argv[2])),int(h*float(sys.argv[3])))))", png, String(fx), String(fy)], { encoding: "utf8" });
  return out.trim().split(/\s+/).map(Number) as [number, number, number];
}

plainTest.describe("動画ホワイトボード：計算", () => {
  plainTest("並べ方：縦動画に横長の動画2本なら上下、横動画なら左右。はみ出さない", () => {
    const vertical = arrangeInGrid([16 / 9, 16 / 9], boardSize("vertical"));
    expect(vertical[0].cx).toBeCloseTo(vertical[1].cx, 5);
    expect(vertical[0].cy).toBeLessThan(vertical[1].cy);
    const horizontal = arrangeInGrid([16 / 9, 16 / 9], boardSize("horizontal"));
    expect(horizontal[0].cy).toBeCloseTo(horizontal[1].cy, 5);
    expect(horizontal[0].cx).toBeLessThan(horizontal[1].cx);
    const { width, height } = boardSize("square");
    for (const p of arrangeInGrid([1, 16 / 9, 9 / 16], { width, height })) {
      expect(p.cx - p.w / 2).toBeGreaterThanOrEqual(-0.01);
      expect(p.cx + p.w / 2).toBeLessThanOrEqual(width + 0.01);
      expect(p.cy - p.h / 2).toBeGreaterThanOrEqual(-0.01);
      expect(p.cy + p.h / 2).toBeLessThanOrEqual(height + 0.01);
    }
  });

  plainTest("長さはいちばん長い動画。短い動画は、最後の場面で止めるか、くり返す", () => {
    expect(boardDuration([2, 5, 3])).toBe(5);
    expect(boardDuration([])).toBe(0);
    expect(localTime(1, 2, "hold")).toBe(1);
    expect(localTime(4, 2, "hold")).toBeCloseTo(1.999, 3);
    expect(localTime(4.5, 2, "loop")).toBeCloseTo(0.5, 5);
  });
});

test.describe("動画ホワイトボード：画面と書き出し", () => {
  test.setTimeout(240_000);
  let red: string;
  let blue: string;
  test.beforeAll(() => {
    red = colorVideo("red.mp4", "red", 2, 440);
    blue = colorVideo("blue.mp4", "blue", 3, 880);
  });

  test("2本を置くと縦動画で上下に並び、ドラッグで動かせる。横動画にすると左右に並び直し、同時に再生できる", async ({ page }) => {
    await page.goto("/tools/video-whiteboard");
    await uploadFixture(page, [red, blue]);
    const items = page.getByTestId("vb-item");
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    const board = page.getByTestId("vb-board");
    await expect(board).toHaveAttribute("data-board-width", "1080");
    const a = (await items.nth(0).boundingBox())!;
    const b = (await items.nth(1).boundingBox())!;
    expect(a.y).toBeLessThan(b.y);
    expect(Math.abs(a.x - b.x)).toBeLessThan(3);
    // ドラッグで動かす
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 30, a.y + a.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    const moved = (await items.nth(0).boundingBox())!;
    expect(moved.x - a.x).toBeGreaterThan(20);
    await expect(items.nth(0)).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("vb-resize")).toBeVisible();
    // 横動画にすると、左右に並び直す
    await page.getByTestId("vb-shape").getByRole("radio", { name: /横動画/ }).click();
    await expect(board).toHaveAttribute("data-board-width", "1920");
    const c = (await items.nth(0).boundingBox())!;
    const d = (await items.nth(1).boundingBox())!;
    expect(c.x).toBeLessThan(d.x);
    // 同時に再生すると、時刻が進む
    await page.getByTestId("vb-play").click();
    await expect.poll(async () => (await page.getByTestId("vb-time").textContent()) ?? "", { timeout: 5_000 }).not.toMatch(/^0:00\.0 /);
    await page.getByTestId("vb-play").click();
    await expect(page.getByTestId("vb-length")).toContainText("0:03.0");
  });

  test("書き出し：横動画で、左に赤・右に青。長さは長いほう（3秒）。短い赤は最後の場面で止まる。音は混ざって入る", async ({ page }) => {
    await page.goto("/tools/video-whiteboard");
    await uploadFixture(page, [red, blue]);
    await expect(page.getByTestId("vb-item")).toHaveCount(2, { timeout: 30_000 });
    await page.getByTestId("vb-shape").getByRole("radio", { name: /横動画/ }).click();
    await page.getByTestId("vb-run").click();
    const popup = page.getByTestId("result-popup");
    await expect(popup).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("vb-result")).toContainText("1920×1080");
    await expect(page.getByTestId("vb-result")).toContainText("音声あり");
    const wait = page.waitForEvent("download");
    await popup.getByRole("button", { name: "ダウンロード" }).click();
    const download = await wait;
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    const out = path.join(tmp(), "out.mp4");
    await download.saveAs(out);
    const info = probe(out);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.duration).toBeGreaterThan(2.8);
    expect(info.duration).toBeLessThan(3.4);
    expect(info.audio).toBe(true);
    const left = colorAt(out, 1, 0.25, 0.5);
    const right = colorAt(out, 1, 0.75, 0.5);
    expect(left[0]).toBeGreaterThan(180);
    expect(left[2]).toBeLessThan(80);
    expect(right[2]).toBeGreaterThan(180);
    expect(right[0]).toBeLessThan(80);
    // 2秒で終わる赤い動画は、2.5秒の時点でも最後の場面（赤）のまま
    const later = colorAt(out, 2.5, 0.25, 0.5);
    expect(later[0]).toBeGreaterThan(180);
  });

  test("音量をすべて0にすると、音声なしで書き出す。外すと一覧からもキャンバスからも消える", async ({ page }) => {
    await page.goto("/tools/video-whiteboard");
    await uploadFixture(page, [red, blue]);
    await expect(page.getByTestId("vb-item")).toHaveCount(2, { timeout: 30_000 });
    for (const n of [0, 1]) await page.getByTestId("vb-volume").nth(n).fill("0");
    await page.getByTestId("vb-shape").getByRole("radio", { name: /正方形/ }).click();
    await page.getByTestId("vb-run").click();
    await expect(page.getByTestId("vb-result")).toContainText("音声なし", { timeout: 180_000 });
    await expect(page.getByTestId("vb-result")).toContainText("1080×1080");
    await page.getByTestId("result-popup").getByRole("button", { name: /閉じる/ }).first().click().catch(() => undefined);
    await page.keyboard.press("Escape");
    await page.getByTestId("vb-remove").first().click();
    await expect(page.getByTestId("vb-item")).toHaveCount(1);
    await expect(page.getByTestId("vb-row")).toHaveCount(1);
  });
});
