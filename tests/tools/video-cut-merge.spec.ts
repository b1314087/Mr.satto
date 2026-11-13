import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures as FIXTURES } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";
import { validateClips } from "@/lib/processors/browser/video-cut-merge";
import { outputToSource, removeOutputRange, sequenceStarts, snapTime, splitAtOutputTime } from "@/lib/video/cut-segments";

/**
 * 動画カット・結合（次期機能追加 3）。
 * - 1本の動画から残す区間を複数指定して順番につなぐ
 * - 複数の動画を順番を入れ替えて1本にする（縦向き・横向き・解像度・fps・音声の有無が違っても）
 * - 書き出したファイルを ffprobe で読み直し、長さ・大きさ・音声（映像と同じ長さ＝ずれない）を確かめる
 * - 処理中のキャンセル
 */

type Probe = { width: number; height: number; videoSec: number; audioSec: number | null; formatSec: number };

function probe(file: string): Probe {
  const json = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", file]).toString()
  ) as { streams: { codec_type: string; width?: number; height?: number; duration?: string }[]; format: { duration?: string } };
  const v = json.streams.find((s) => s.codec_type === "video")!;
  const a = json.streams.find((s) => s.codec_type === "audio");
  const formatSec = Number(json.format.duration ?? 0);
  return {
    width: v.width ?? 0,
    height: v.height ?? 0,
    videoSec: Number(v.duration ?? formatSec),
    audioSec: a ? Number(a.duration ?? formatSec) : null,
    formatSec,
  };
}

async function runAndDownload(page: Page, out: string): Promise<string> {
  await page.getByTestId("video-cut-merge-run").click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 120_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "ダウンロード" }).click();
  const download = await wait;
  const dest = path.join(path.dirname(out), download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

plainTest.describe("区間の確認（ブラウザを使わない）", () => {
  plainTest("終了が開始より前・短すぎる区間・長さを超える区間・空は、理由つきで止める", () => {
    const d = 5;
    plainExpect(validateClips([])).toMatch(/1つ以上/);
    plainExpect(validateClips([{ start: 2, end: 1, durationSec: d }])).toMatch(/終了を開始より後/);
    plainExpect(validateClips([{ start: 1, end: 1.05, durationSec: d }])).toMatch(/0.1秒以上/);
    plainExpect(validateClips([{ start: 1, end: 9, durationSec: d }])).toMatch(/超えています/);
    plainExpect(validateClips([{ start: 0, end: 1, durationSec: d }, { start: 2, end: 3, durationSec: d }])).toBeNull();
  });

  plainTest("つないだあとの時間：区間は隙間なく並び、分ける・範囲を消すと、うしろが詰まる。磁石は近い候補に吸い付く（2026-11）", () => {
    let id = 10;
    const nextId = () => id++;
    const segs = [
      { id: 1, start: 0, end: 2 },
      { id: 2, start: 5, end: 6 },
    ];
    plainExpect(sequenceStarts(segs)).toEqual([0, 2, 3]);
    plainExpect(outputToSource(segs, 2.5)).toEqual({ index: 1, source: 5.5 });
    // 1.5秒（つないだあと）で分ける → 0〜1.5・1.5〜2・5〜6
    const split = splitAtOutputTime(segs, 1.5, nextId);
    plainExpect(split.map((s) => [s.start, s.end])).toEqual([[0, 1.5], [1.5, 2], [5, 6]]);
    // 短すぎる位置では分けない
    plainExpect(splitAtOutputTime(segs, 0.02, nextId)).toBe(segs);
    // つないだあとの 1〜2.5秒を消す → 0〜1 と 5.5〜6 が残り、合計1.5秒に詰まる
    const removed = removeOutputRange(segs, { start: 1, end: 2.5 }, nextId);
    plainExpect(removed.map((s) => [s.start, s.end])).toEqual([[0, 1], [5.5, 6]]);
    plainExpect(sequenceStarts(removed).at(-1)).toBe(1.5);
    // 磁石
    plainExpect(snapTime(1.03, [0, 1, 2], 0.05)).toEqual({ t: 1, snappedTo: 1 });
    plainExpect(snapTime(1.2, [0, 1, 2], 0.05)).toEqual({ t: 1.2, snappedTo: null });
  });
});

test.describe("動画カット・結合の画面", () => {
  test("不要部分を削除（タイムライン）：数字を入れずに、赤い行のドラッグで1.0〜1.5秒を選んで削除し、残った2区間の順番をドラッグで入れ替えて書き出す", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/tools/video-cut-merge");
    await uploadFixture(page, FIXTURES.cutLandscapeWebm); // 3秒
    const bars = page.getByTestId("video-cut-segment");
    await expect(bars).toHaveCount(1, { timeout: 30_000 }); // 最初は全体を残す1区間
    await expect(page.getByTestId("video-cut-summary")).toContainText("1区間・合計0:03");
    // 数字の入力欄は無い（タイムラインで操作する）
    await expect(page.getByTestId("video-cut-start")).toHaveCount(0);

    // 削除する範囲を、赤い行の 1/3（1.0秒）〜 1/2（1.5秒）でドラッグして選ぶ
    await page.getByTestId("video-cut-timeline-select").scrollIntoViewIfNeeded();
    const lane = (await page.getByTestId("video-cut-timeline-select").boundingBox())!;
    await page.mouse.move(lane.x + lane.width / 3, lane.y + lane.height / 2);
    await page.mouse.down();
    await page.mouse.move(lane.x + lane.width / 2, lane.y + lane.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId("video-cut-timeline-selection")).toBeVisible();
    await page.getByTestId("video-cut-delete-range").click();
    await expect(bars).toHaveCount(2);
    await expect(page.getByTestId("video-cut-summary")).toContainText("2区間");
    await expect(page.getByTestId("video-cut-order-item").nth(0)).toContainText("0:00.0〜0:01.0");

    // 残す区間の順番を、つまみのドラッグで入れ替える（区間2を上へ）
    const items = page.getByTestId("video-cut-order-item");
    // 下にくっつく実行ボタンの帯に隠れないよう、画面の真ん中へ
    await items.nth(1).evaluate((el) => el.scrollIntoView({ block: "center" }));
    const firstBefore = await items.nth(0).textContent();
    const handle = (await items.nth(1).getByTestId("video-cut-drag").boundingBox())!;
    const target = (await items.nth(0).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, target.y + 2, { steps: 6 });
    await page.mouse.up();
    await expect(items.nth(0)).not.toHaveText(firstBefore ?? "");
    await expect(items.nth(0)).toContainText("0:01.5〜0:03.0");

    // つないだ結果を、書き出す前に再生して確かめられる
    await page.getByTestId("video-cut-play-joined").click();
    await expect(page.getByTestId("video-cut-play-joined")).toContainText("止める");
    await page.getByTestId("video-cut-play-joined").click();

    const out = await runAndDownload(page, test.info().outputPath("x"));
    expect(path.basename(out)).toBe("cut-landscape_カット.mp4");
    const p = probe(out);
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
    expect(p.formatSec).toBeGreaterThan(2.2);
    expect(p.formatSec).toBeLessThan(2.8);
    expect(p.audioSec).not.toBeNull();
    expect(Math.abs((p.audioSec ?? 0) - p.videoSec)).toBeLessThan(0.15); // 映像と音声の長さがそろう（ずれない）
    await expect(page.getByTestId("video-cut-merge-result")).toContainText("320×240");
    await expect(page.getByTestId("video-cut-merge-result")).toContainText("音声あり");
  });

  test("不要部分を削除：残す区間のバーの端をドラッグして短くでき、再生位置で分けられる", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tools/video-cut-merge");
    await uploadFixture(page, FIXTURES.cutLandscapeWebm);
    const bar = page.getByTestId("video-cut-segment");
    await expect(bar).toHaveCount(1, { timeout: 30_000 });
    await bar.scrollIntoViewIfNeeded();
    const lane = (await page.getByTestId("video-cut-timeline-track").boundingBox())!;
    const end = (await bar.getByTestId("video-cut-segment-end").boundingBox())!;
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
    await page.mouse.down();
    await page.mouse.move(lane.x + (lane.width * 2) / 3, end.y + end.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId("video-cut-summary")).toContainText("合計0:02");
    // 再生位置（1秒）で分ける
    await page.getByTestId("video-cut-video").evaluate(async (v: HTMLVideoElement) => {
      v.currentTime = 1;
      await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
    });
    await page.getByTestId("video-cut-split").click();
    await expect(bar).toHaveCount(2);
  });

  test("複数の動画を結合：横向き・縦向き（fps違い）・音声なしを、順番を入れ替えて1本にする。大きさは1本目に合わせ、黒い余白を付ける", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/tools/video-cut-merge");
    await page.getByTestId("video-cut-merge-mode").getByRole("radio", { name: "複数の動画を結合" }).click();
    await uploadFixture(page, [FIXTURES.cutPortraitWebm, FIXTURES.cutLandscapeWebm, FIXTURES.cutSilentWebm]);
    const list = page.getByTestId("video-merge-item");
    await expect(list).toHaveCount(3);
    await expect(list.nth(0)).toContainText("cut-portrait.webm");
    await expect(list.nth(0)).toContainText("240×320");
    await expect(list.nth(2)).toContainText("音声なし");
    // 横向きの動画を1本目にする（つまみのドラッグで順番を変える）
    await list.nth(1).getByTestId("video-merge-drag").scrollIntoViewIfNeeded();
    const handle = (await list.nth(1).getByTestId("video-merge-drag").boundingBox())!;
    const top = (await list.nth(0).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, top.y + 4, { steps: 6 });
    await page.mouse.up();
    await expect(list.nth(0)).toContainText("cut-landscape.webm");
    await expect(page.getByTestId("video-merge-timeline-clip")).toHaveCount(3);
    // つないだあとのタイムラインでも、順番が反映され、隙間なく並ぶ
    await expect(page.getByTestId("video-merge-timeline-clip").nth(0)).toContainText("cut-landscape.webm");
    await expect(page.getByTestId("video-merge-summary")).toContainText("3本・合計");
    await expect(page.getByTestId("video-merge-size-note")).toContainText("320×240");
    // 書き出し形式：WebM
    await page.getByTestId("video-cut-merge-container").getByRole("radio", { name: /WebM/ }).click();

    const out = await runAndDownload(page, test.info().outputPath("x"));
    expect(path.basename(out)).toBe("cut-landscape_結合.webm");
    const p = probe(out);
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
    expect(p.formatSec).toBeGreaterThan(6.6); // 3秒 + 2秒 + 2秒
    expect(p.formatSec).toBeLessThan(7.4);
    expect(p.audioSec).not.toBeNull(); // 音声なしの動画は無音として入る
    await expect(page.getByTestId("result-popup")).toContainText("黒い余白を付けて大きさをそろえました");
  });

  test("不要部分を削除（編集ソフトのように）：再生位置で分けて、選んだ区間を削除するとうしろが詰まる。端を短くしてもうしろが詰まる。拡大・縮小、磁石で再生位置に吸い付く（2026-11）", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/tools/video-cut-merge");
    await uploadFixture(page, FIXTURES.cutLandscapeWebm); // 3秒
    const clips = page.getByTestId("video-cut-segment");
    await expect(clips).toHaveCount(1, { timeout: 30_000 });
    const track = page.getByTestId("video-cut-timeline-track");
    await track.scrollIntoViewIfNeeded();
    const ruler = page.getByTestId("video-cut-timeline-ruler");
    const seekTo = async (frac: number) => {
      const r = (await ruler.boundingBox())!;
      await page.mouse.click(r.x + r.width * frac, r.y + r.height / 2);
    };
    // 1秒で分け、2秒で分ける → 3区間
    await seekTo(1 / 3);
    await page.getByTestId("video-cut-split").click();
    await seekTo(2 / 3);
    await page.getByTestId("video-cut-split").click();
    await expect(clips).toHaveCount(3);
    await expect(page.getByTestId("video-cut-summary")).toContainText("3区間・合計0:03");
    // 真ん中の区間（1〜2秒）を一覧で削除 → うしろが詰まり、2区間・合計2秒。区間どうしに隙間が無い
    await page.getByRole("button", { name: "区間2を削除" }).click();
    await expect(clips).toHaveCount(2);
    await expect(page.getByTestId("video-cut-summary")).toContainText("2区間・合計0:02");
    await expect(page.getByTestId("video-cut-order-item").nth(1)).toContainText("0:02.0〜0:03.0");
    const gap = async () => {
      const a = (await clips.nth(0).boundingBox())!;
      const b = (await clips.nth(1).boundingBox())!;
      return Math.abs(b.x - (a.x + a.width));
    };
    expect(await gap()).toBeLessThan(2);

    // 1つ目の区間の右端を短くする → 2つ目の区間が左に詰まる（隙間ができない）
    const t = (await track.boundingBox())!;
    const endHandle = (await clips.nth(0).getByTestId("video-cut-segment-end").boundingBox())!;
    const before = (await clips.nth(1).boundingBox())!.x;
    await page.mouse.move(endHandle.x + endHandle.width / 2, endHandle.y + endHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width * 0.3, endHandle.y + endHandle.height / 2, { steps: 6 });
    await page.mouse.up();
    expect((await clips.nth(1).boundingBox())!.x).toBeLessThan(before - 5);
    expect(await gap()).toBeLessThan(2);

    // 磁石：再生位置（0.3秒あたり）の近くまで右端をのばすと、再生位置にぴったり吸い付く
    await seekTo(0.25);
    const playhead = (await page.getByTestId("video-cut-timeline-playhead").boundingBox())!;
    const endH = (await clips.nth(0).getByTestId("video-cut-segment-end").boundingBox())!;
    await page.mouse.move(endH.x + endH.width / 2, endH.y + endH.height / 2);
    await page.mouse.down();
    await page.mouse.move(playhead.x + playhead.width / 2 + 4, endH.y + endH.height / 2, { steps: 6 });
    await expect(page.getByTestId("video-cut-timeline-guide")).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId("video-cut-timeline-guide")).toHaveCount(0);
    const c0 = (await clips.nth(0).boundingBox())!;
    const ph = (await page.getByTestId("video-cut-timeline-playhead").boundingBox())!;
    expect(Math.abs(c0.x + c0.width - (ph.x + ph.width / 2))).toBeLessThan(2);

    // 拡大：タイムラインが横に広がり、横にスクロールできる
    const scroll = page.getByTestId("video-cut-timeline-scroll");
    const w0 = await page.getByTestId("video-cut-timeline-inner").evaluate((el) => el.getBoundingClientRect().width);
    await page.getByTestId("video-cut-timeline-zoom-in").click();
    await page.getByTestId("video-cut-timeline-zoom-in").click();
    await expect(page.getByTestId("video-cut-timeline-zoom-value")).toHaveText("225%");
    const w1 = await page.getByTestId("video-cut-timeline-inner").evaluate((el) => el.getBoundingClientRect().width);
    expect(w1).toBeGreaterThan(w0 * 2);
    expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // 拡大・縮小はバーでもできる
    await page.getByTestId("video-cut-timeline-zoom").fill("100");
    await expect(page.getByTestId("video-cut-timeline-zoom-value")).toHaveText("100%");
  });

  test("処理中にキャンセルできる。キャンセル後はもう一度実行できる", async ({ page }) => {
    test.setTimeout(180_000);
    const long = test.info().outputPath("long.webm");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "40", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus", long,
    ]);
    expect(fs.existsSync(long)).toBe(true);
    await page.goto("/tools/video-cut-merge");
    await uploadFixture(page, long);
    await expect(page.getByTestId("video-cut-summary")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("video-cut-merge-run").click();
    await expect(page.getByText(/書き出し中\.\.\. \d+%/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(page.getByText("処理をキャンセルしました。")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    await expect(page.getByTestId("video-cut-merge-run")).toBeEnabled();
  });
});
