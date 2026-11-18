import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as plainTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";
import { cueAlphaAt, effectiveFades } from "@/lib/video/subtitle-render";
import {
  DEFAULT_CUE_LOOK,
  activeCuesAt,
  buildSrt,
  buildWebVtt,
  checkCues,
  formatSubtitleTime,
  parseSubtitleTime,
  previewCues,
  sortCuesByTime,
  type SubtitleCue,
} from "@/lib/video/subtitles";
import { canCopyIntoWebm, subtitleShiftFor } from "@/lib/processors/browser/video-subtitle";

/**
 * 動画字幕追加のテスト。
 * - 字幕の時間の読み書き・確認・WebVTT／SRTの作成（画面なし）
 * - 字幕の追加・編集・削除・複製・並べ替え、不正な時間、重なりの警告
 * - プレビュー（表示時間・シーク・再生・表示位置・大きさ）
 * - 書き出し（字幕トラック・映像と音声の維持・時間・音声なし・WebM・キャンセル）
 *   書き出したファイルは、ファイルの構造（Matroska）を直接読んで、字幕トラックの中身と時間を確かめる。
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-subtitle-"));
const cue = (start: string, end: string, text: string, id = `${start}-${end}-${text}`): SubtitleCue => ({ id, start, end, text });

function makeVideo(opts: { sec: number; audio: boolean; w?: number; h?: number; bitrate?: string }): string {
  const out = path.join(tmp(), `src-${opts.sec}s-${opts.audio ? "a" : "na"}.mp4`);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${opts.w ?? 320}x${opts.h ?? 180}:rate=30`,
    ...(opts.audio ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []),
    "-t", String(opts.sec), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", opts.bitrate ?? "500k",
    ...(opts.audio ? ["-c:a", "aac"] : []),
    "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

/** ffprobe で、ストリームの種類・コーデックと、映像・音声の最初のデータの時間を調べる */
function probeStreams(file: string): { video: string | null; audio: string | null; videoFirst: number | null; frames: number } {
  const json = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,nb_read_packets", "-of", "json", file]).toString()
  ) as { streams: { codec_type: string; codec_name?: string; nb_read_packets?: string }[] };
  const v = json.streams.find((s) => s.codec_type === "video");
  const a = json.streams.find((s) => s.codec_type === "audio");
  const first = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-read_intervals", "%+#1", "-of", "csv=p=0", file])
    .toString()
    .trim()
    .split("\n")[0];
  return { video: v?.codec_name ?? null, audio: a?.codec_name ?? null, videoFirst: first ? Number(first) : null, frames: Number(v?.nb_read_packets ?? 0) };
}

async function openWithVideo(page: Page, file: string) {
  await page.goto("/tools/video-subtitle");
  await uploadFixture(page, file);
  await expect(page.getByText("動画の情報を調べています…")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("vs-add")).toBeVisible({ timeout: 30_000 });
}

/** 字幕を1件足して、プレビュー（動画の上の入力欄）で文字を入れ、一覧で時間を入れる */
async function addCue(page: Page, start: string, end: string, text: string) {
  await page.getByTestId("vs-add").click();
  // 追加すると、動画の上に入力欄が出て、すぐに入力できる
  const editor = page.getByTestId("vs-cue-text");
  await expect(editor).toBeFocused();
  await editor.fill(text);
  const row = page.getByTestId("vs-cue").last();
  await row.getByTestId("vs-cue-start").fill(start);
  await row.getByTestId("vs-cue-end").fill(end);
}

/** 一覧の字幕を選んで、プレビューの入力欄で文字を書き換える */
async function editText(page: Page, index: number, text: string) {
  await page.getByTestId("vs-cue").nth(index).getByTestId("vs-cue-text-view").click();
  await page.getByTestId("vs-cue-text").fill(text);
}

const cueTexts = (page: Page) => page.getByTestId("vs-cue-text-view").allTextContents();

async function exportAndSave(page: Page): Promise<string> {
  await page.getByTestId("vs-run").click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 120_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "ダウンロード" }).click();
  const download = await wait;
  const dest = path.join(tmp(), download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

async function seek(page: Page, sec: number) {
  await page.getByTestId("vs-video").evaluate(async (v: HTMLVideoElement, t) => {
    v.pause();
    await new Promise<void>((resolve) => {
      v.addEventListener("seeked", () => resolve(), { once: true });
      v.currentTime = t;
    });
  }, sec);
}

// ---------------------------------------------------------------------------
// 1. 字幕の計算（画面なし）
// ---------------------------------------------------------------------------
plainTest.describe("字幕の時間・確認・ファイルの作成（画面なし）", () => {
  plainTest("時間は HH:MM:SS.mmm で読み書きでき、ミリ秒まで扱える。H:MM:SS・MM:SS.mmm・秒だけ・全角も読める。不正な値は読まない", () => {
    expect(parseSubtitleTime("00:00:01.000")).toBe(1);
    expect(parseSubtitleTime("01:02:03.456")).toBe(3723.456);
    expect(parseSubtitleTime("1:02:03")).toBe(3723);
    expect(parseSubtitleTime("02:03.5")).toBe(123.5);
    expect(parseSubtitleTime("12.25")).toBe(12.25);
    expect(parseSubtitleTime("００：００：０２．５００")).toBe(2.5);
    expect(parseSubtitleTime("00:00:01,250")).toBe(1.25);
    for (const bad of ["", "abc", "00:60:00.000", "00:00:61.000", "1:2:3:4", "-1", "00:00:01.0000"]) expect(parseSubtitleTime(bad), bad).toBeNull();
    expect(formatSubtitleTime(3723.456)).toBe("01:02:03.456");
    expect(formatSubtitleTime(1.0005)).toBe("00:00:01.001");
    expect(formatSubtitleTime(65.5, ",")).toBe("00:01:05,500");
  });

  plainTest("確認：不正な時間・終了が開始以前・動画の長さを超える・文字が空は、書き出せない問題として返す", () => {
    const r = checkCues(
      [cue("x", "00:00:02.000", "a", "1"), cue("00:00:03.000", "00:00:02.000", "b", "2"), cue("00:00:09.000", "00:00:11.000", "c", "3"), cue("00:00:01.000", "00:00:02.000", "  ", "4")],
      10
    );
    const msgs = r.errors.map((e) => e.message).join("\n");
    expect(msgs).toContain("1番目の開始時間を");
    expect(msgs).toContain("2番目の終了時間は、開始時間より後に");
    expect(msgs).toContain("3番目の終了時間が、動画の長さ（00:00:10.000）を超えています");
    expect(msgs).toContain("4番目の字幕の文字を入力してください");
    expect(r.resolved).toEqual([]);
  });

  plainTest("重なりは警告だけ（書き出せる）。時間順でなければ知らせ、書き出し用は時間順に並べる", () => {
    const r = checkCues([cue("00:00:03.000", "00:00:06.000", "二", "b"), cue("00:00:01.000", "00:00:03.500", "一", "a")], 10);
    expect(r.errors).toEqual([]);
    expect(r.overlaps).toEqual([{ a: 1, b: 2 }]);
    expect(r.outOfOrder).toBe(true);
    expect(r.resolved.map((c) => c.text)).toEqual(["一", "二"]);
    // ちょうど続く（終了＝次の開始）は重なりではない
    expect(checkCues([cue("00:00:01.000", "00:00:03.000", "a"), cue("00:00:03.000", "00:00:04.000", "b")], 10).overlaps).toEqual([]);
    expect(sortCuesByTime([cue("00:00:05.000", "00:00:06.000", "b"), cue("bad", "x", "z"), cue("00:00:01.000", "00:00:02.000", "a")]).map((c) => c.text)).toEqual(["a", "b", "z"]);
  });

  plainTest("プレビュー：開始を含み、終了を含まない時間に表示する", () => {
    const shown = previewCues([cue("00:00:01.000", "00:00:02.000", "一"), cue("00:00:02.000", "00:00:03.000", "二")]);
    expect(activeCuesAt(shown, 0.999).map((c) => c.text)).toEqual([]);
    expect(activeCuesAt(shown, 1).map((c) => c.text)).toEqual(["一"]);
    expect(activeCuesAt(shown, 2).map((c) => c.text)).toEqual(["二"]);
    expect(activeCuesAt(shown, 3).map((c) => c.text)).toEqual([]);
  });

  plainTest("WebVTT：字幕ごとの見た目（文字色・大きさ・位置）と全体の背景を STYLE とキューの設定で書き、記号は安全な形にする。SRT は時間と文字だけ（総合改修 11）", () => {
    const top = { ...DEFAULT_CUE_LOOK, color: "#ffff00", size: 7.8, x: 50, y: 5 };
    const { resolved } = checkCues([{ ...cue("00:00:01.000", "00:00:03.000", "A&B <b>\n\n二行目"), look: top }, { ...cue("00:00:03.000", "00:00:06.000", "今日は旅行に来ています"), look: top }], null);
    // 見た目が全部同じ：::cue にまとめ、文字に印を付けない
    const vtt = buildWebVtt(resolved, { color: "#000000", opacity: 50 });
    expect(vtt.startsWith("WEBVTT\n\nSTYLE\n::cue { color: #ffff00; background-color: rgba(0,0,0,0.5); font-size: 130%; }\n\n")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:03.000 line:5% position:50% align:center\nA&amp;B &lt;b&gt;\n二行目\n");
    // 下の既定の位置は、位置の設定を書かない
    const def = checkCues([cue("00:00:03.000", "00:00:06.000", "既定")], null).resolved;
    expect(buildWebVtt(def)).toContain("00:00:03.000 --> 00:00:06.000 align:center\n既定");
    // 字幕ごとに違う見た目：クラスを付けて、混ざらないようにする
    const mixed = checkCues([{ ...cue("00:00:01.000", "00:00:02.000", "赤"), look: { ...DEFAULT_CUE_LOOK, color: "#e53935" } }, { ...cue("00:00:02.000", "00:00:03.000", "青"), look: { ...DEFAULT_CUE_LOOK, color: "#1e88e5", size: 12 } }], null).resolved;
    const mv = buildWebVtt(mixed, { color: "#000000", opacity: 0 });
    expect(mv).toContain("::cue(.s1) { color: #e53935; font-size: 100%; }");
    expect(mv).toContain("::cue(.s2) { color: #1e88e5; font-size: 200%; }");
    expect(mv).toContain("<c.s1>赤</c>");
    expect(mv).toContain("<c.s2>青</c>");
    // 色に任意の文字は書かない
    const evil = checkCues([{ ...cue("00:00:01.000", "00:00:02.000", "x"), look: { ...DEFAULT_CUE_LOOK, color: "red;} body{" } }], null).resolved;
    expect(buildWebVtt(evil)).toContain("color: #ffffff;");
    expect(buildSrt(resolved)).toBe("1\n00:00:01,000 --> 00:00:03,000\nA&B <b>\n二行目\n\n2\n00:00:03,000 --> 00:00:06,000\n今日は旅行に来ています\n");
  });

  plainTest("フェード：透明から徐々に表示し、徐々に透明にして消える。合計が表示時間を超えるときは表示時間に収める", () => {
    const c = { startSec: 1, endSec: 3, look: { ...DEFAULT_CUE_LOOK, fadeIn: 0.5, fadeOut: 1 } };
    expect(cueAlphaAt(c, 0.9)).toBe(0);
    expect(cueAlphaAt(c, 1)).toBe(0);
    expect(cueAlphaAt(c, 1.25)).toBeCloseTo(0.5, 5);
    expect(cueAlphaAt(c, 1.6)).toBe(1);
    expect(cueAlphaAt(c, 2.5)).toBeCloseTo(0.5, 5);
    expect(cueAlphaAt(c, 3)).toBe(0);
    const long = { startSec: 0, endSec: 1, look: { ...DEFAULT_CUE_LOOK, fadeIn: 2, fadeOut: 2 } };
    const f = effectiveFades(long);
    expect(f.fadeIn + f.fadeOut).toBeCloseTo(1, 5);
    expect(cueAlphaAt(long, 0.5)).toBeCloseTo(1, 5);
  });

  plainTest("WebM は VP8・VP9・AV1 と Opus・Vorbis（または音声なし）のときだけ。字幕のずらし幅は、マイナスの先頭時間を0にする分", () => {
    expect(canCopyIntoWebm("vp9", "opus", true)).toBe(true);
    expect(canCopyIntoWebm("vp8", null, false)).toBe(true);
    expect(canCopyIntoWebm("avc", "aac", true)).toBe(false);
    expect(canCopyIntoWebm("vp9", "aac", true)).toBe(false);
    expect(subtitleShiftFor([0, -0.0232])).toBeCloseTo(0.0232, 6);
    expect(subtitleShiftFor([0, 0])).toBe(0);
    expect(subtitleShiftFor([null, null])).toBe(0);
    expect(subtitleShiftFor([0, -2])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 画面：字幕の編集・プレビュー
// ---------------------------------------------------------------------------
test.describe("動画字幕追加：字幕の編集とプレビュー", () => {
  test.setTimeout(120_000);
  let video4s: string;
  test.beforeAll(() => {
    video4s = makeVideo({ sec: 4, audio: true });
  });

  test("字幕の追加・編集・複製・並べ替え・削除ができ、時間順に並べ替えられる", async ({ page }) => {
    await openWithVideo(page, video4s);
    await addCue(page, "00:00:02.000", "00:00:03.000", "二番目");
    await addCue(page, "00:00:00.500", "00:00:01.500", "一番目");
    const rows = page.getByTestId("vs-cue");
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId("vs-order-note")).toBeVisible();
    // 複製
    await rows.nth(0).getByTestId("vs-cue-duplicate").click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1).getByTestId("vs-cue-text-view")).toHaveText("二番目");
    // 複製した方を編集（文字はプレビューの入力欄で）
    await editText(page, 1, "三番目");
    await expect(rows.nth(1).getByTestId("vs-cue-text-view")).toHaveText("三番目");
    await rows.nth(1).getByTestId("vs-cue-start").fill("00:00:03.000");
    await rows.nth(1).getByTestId("vs-cue-end").fill("00:00:03.900");
    // 上へ・下へ
    await rows.nth(2).getByTestId("vs-cue-up").click();
    await expect(rows.nth(1).getByTestId("vs-cue-text-view")).toHaveText("一番目");
    await rows.nth(0).getByTestId("vs-cue-down").click();
    await expect(rows.nth(0).getByTestId("vs-cue-text-view")).toHaveText("一番目");
    // 時間順に並べ替え
    await page.getByTestId("vs-sort").click();
    expect(await cueTexts(page)).toEqual(["一番目", "二番目", "三番目"]);
    await expect(page.getByTestId("vs-order-note")).toHaveCount(0);
    // 削除
    await rows.nth(1).getByTestId("vs-cue-delete").click();
    await expect(rows).toHaveCount(2);
    expect(await cueTexts(page)).toEqual(["一番目", "三番目"]);
    // 一覧には文字の入力欄がない（文字はプレビューの動画の上で入力する）。入力欄は1つだけ
    await expect(rows.first().locator("textarea")).toHaveCount(0);
    await rows.first().getByTestId("vs-cue-text-view").click();
    await expect(page.getByTestId("vs-cue-text")).toHaveCount(1);
  });

  test("プレビュー：字幕を追加すると、動画の上の字幕の位置に入力欄が出る。再生中は隠れ、選んだ字幕を削除できる。大きく表示しても編集できる", async ({ page }) => {
    await openWithVideo(page, video4s);
    // 「字幕を追加」は再生ボタンの横にある
    const play = await page.getByTestId("vs-play").boundingBox();
    const add = await page.getByTestId("vs-add").boundingBox();
    expect(Math.abs(play!.y - add!.y)).toBeLessThan(20);
    await seek(page, 1.0);
    await page.getByTestId("vs-add").click();
    const editor = page.getByTestId("vs-cue-text");
    await expect(editor).toBeFocused();
    await page.keyboard.type("動画の上で入力");
    await expect(page.getByTestId("vs-cue").first().getByTestId("vs-cue-text-view")).toHaveText("動画の上で入力");
    // 入力欄は動画の枠の中の、字幕の位置（既定は下の方：88%）にある
    const video = await page.getByTestId("vs-video").boundingBox();
    const box = await editor.boundingBox();
    const cy = (box!.y + box!.height / 2 - video!.y) / video!.height;
    expect(cy).toBeGreaterThan(0.7);
    expect(cy).toBeLessThan(0.98);
    // 再生中は入力欄を隠し、書き出しと同じ描画で流す
    await page.getByTestId("vs-video").evaluate((v: HTMLVideoElement) => { v.muted = true; v.loop = true; return v.play(); });
    await expect(editor).toHaveCount(0);
    await page.getByTestId("vs-video").evaluate((v: HTMLVideoElement) => v.pause());
    await expect(editor).toBeVisible();

    // 大きく表示しても、追加・入力・削除ができる
    await page.getByTestId("preview-fullscreen").click();
    const frame = page.locator('[data-preview-fullscreen="true"]');
    await expect(frame).toBeVisible();
    await seek(page, 2.5);
    await frame.getByTestId("vs-add").click();
    await expect(frame.getByTestId("vs-cue-text")).toBeFocused();
    await page.keyboard.type("大きく表示で入力");
    await expect(frame.getByTestId("vs-timeline-row")).toHaveCount(2);
    await frame.getByTestId("vs-preview-delete").click();
    await expect(frame.getByTestId("vs-timeline-row")).toHaveCount(1);
    await page.getByTestId("preview-fullscreen-close").click();
    expect(await cueTexts(page)).toEqual(["動画の上で入力"]);
  });

  test("字幕が0件・不正な時間・動画の長さを超える字幕は、書き出す前にエラーを出し、書き出さない。重なりは警告だけ", async ({ page }) => {
    await openWithVideo(page, video4s);
    await page.getByTestId("vs-run").click();
    await expect(page.getByText("字幕が1件も登録されていません")).toBeVisible();
    await addCue(page, "00:00:01.000", "abc", "こんにちは");
    await addCue(page, "00:00:03.000", "00:00:09.000", "長すぎる");
    await page.getByTestId("vs-run").click();
    const errors = page.getByTestId("vs-errors");
    await expect(errors).toContainText("1番目の終了時間を「00:00:03.000」の形で入力してください");
    await expect(errors).toContainText("2番目の終了時間が、動画の長さ");
    await expect(page.getByTestId("vs-cue").nth(0).getByTestId("vs-cue-end")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    // 直すとエラーが消える。重なっていると警告が出る（書き出しは禁止しない）
    await page.getByTestId("vs-cue").nth(0).getByTestId("vs-cue-end").fill("00:00:03.500");
    await page.getByTestId("vs-cue").nth(1).getByTestId("vs-cue-end").fill("00:00:04.000");
    await expect(page.getByTestId("vs-errors")).toHaveCount(0);
    await expect(page.getByTestId("vs-overlap-warning")).toContainText("1番目と2番目");
  });

  test("プレビュー：シークした位置・再生中に、表示時間の字幕だけが出る。表示位置・文字サイズ・色が反映される", async ({ page }) => {
    await openWithVideo(page, video4s);
    await addCue(page, "00:00:00.500", "00:00:01.500", "こんにちは");
    await addCue(page, "00:00:02.000", "00:00:03.000", "今日は旅行に来ています");
    await seek(page, 1.0);
    await expect(page.getByTestId("vs-overlay-cue")).toHaveText(["こんにちは"]);
    await expect(page.getByTestId("vs-current-time")).toHaveText("00:00:01.000");
    await seek(page, 1.7);
    await expect(page.getByTestId("vs-overlay-cue")).toHaveCount(0);
    // 「この字幕へ移動」で開始位置へ
    await page.getByTestId("vs-cue").nth(1).getByTestId("vs-cue-seek").click();
    await expect(page.getByTestId("vs-overlay-cue")).toHaveText(["今日は旅行に来ています"]);
    // 再生すると、時間に合わせて字幕が変わる（3秒を過ぎると消える）
    await seek(page, 0.2);
    await page.getByTestId("vs-video").evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
    await expect(page.getByTestId("vs-overlay-cue")).toHaveText(["こんにちは"], { timeout: 5_000 });
    await expect(page.getByTestId("vs-overlay-cue")).toHaveText(["今日は旅行に来ています"], { timeout: 5_000 });
    await page.getByTestId("vs-video").evaluate((v: HTMLVideoElement) => v.pause());
    // 字幕ごとの見た目（総合改修 11）：1番目だけを上・大きく・黄色・縁取りなしにする。2番目は変わらない
    await seek(page, 1.0);
    const row1 = page.getByTestId("vs-cue").nth(0);
    await row1.getByTestId("vs-cue-look").locator("summary").click();
    await row1.getByLabel("1番目の縦の位置（Y）の数値").fill("10");
    await row1.getByLabel("1番目の縦の位置（Y）の数値").blur();
    await row1.getByLabel("1番目の文字の大きさの数値").fill("12");
    await row1.getByLabel("1番目の文字の大きさの数値").blur();
    await row1.getByTestId("vs-cue-color-黄").click();
    await row1.getByTestId("vs-cue-outline").uncheck();
    // 入力欄にも、選んだ字幕の見た目（色・位置）が反映される
    await expect(page.getByTestId("vs-cue-text")).toHaveCSS("color", "rgb(253, 216, 53)");
    // 入力中の字幕はキャンバスには描かない（二重にならない）。2番目を選ぶと、1番目はキャンバスに描かれる
    await page.getByTestId("vs-cue").nth(1).getByTestId("vs-cue-text-view").click();
    await seek(page, 1.0);
    const cueEl = page.getByTestId("vs-overlay-cue");
    await expect(cueEl).toHaveAttribute("data-y", "10");
    await expect(cueEl).toHaveAttribute("data-size", "12");
    await expect(cueEl).toHaveAttribute("data-color", "#fdd835");
    // キャンバスの上の方（y=10%付近）に黄色の文字が描かれ、下の方には描かれていない
    const yellowRows = await page.getByTestId("vs-overlay-canvas").evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const ys: number[] = [];
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 180 && d[i + 2] < 120) { ys.push(y / c.height); break; }
        }
      }
      return ys;
    });
    expect(yellowRows.length).toBeGreaterThan(3);
    expect(Math.max(...yellowRows)).toBeLessThan(0.3);
    // 2番目の字幕の見た目は変わっていない（設定が混ざらない）
    await page.getByTestId("vs-cue").nth(1).getByTestId("vs-cue-seek").click();
    await expect(cueEl).toHaveAttribute("data-y", "88");
    await expect(cueEl).toHaveAttribute("data-color", "#ffffff");
    // プレビューの入力欄で文字を変えると、すぐ反映される
    await editText(page, 1, "あとから変更");
    await seek(page, 2.5);
    await expect(cueEl).toHaveText(["あとから変更"]);
  });

  test("タイムライン：字幕ごとのバーの端・真ん中をドラッグして、表示時間を変えられる。目盛りを押すと再生位置が動く", async ({ page }) => {
    await openWithVideo(page, video4s);
    await addCue(page, "00:00:01.000", "00:00:02.000", "ドラッグ");
    const row = page.getByTestId("vs-timeline-row");
    await expect(row).toHaveCount(1);
    await row.scrollIntoViewIfNeeded();
    const lane = await row.locator("[data-timeline-lane]").boundingBox();
    const end = await row.getByTestId("vs-timeline-row-end").boundingBox();
    // 終了の端を、動画の 3秒 の位置までドラッグ
    await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2);
    await page.mouse.down();
    await page.mouse.move(lane!.x + (lane!.width * 3) / 4, end!.y + end!.height / 2, { steps: 6 });
    await page.mouse.up();
    const endVal = parseSubtitleTime(await page.getByTestId("vs-cue-end").inputValue())!;
    // つまみの真ん中をつかむので、つまみの幅の半分（画面の数ピクセル＝0.2秒前後）だけずれることがある
    expect(endVal).toBeGreaterThan(2.8);
    expect(endVal).toBeLessThan(3.3);
    await expect(page.getByTestId("vs-cue-start")).toHaveValue("00:00:01.000");
    // 真ん中をドラッグすると、長さを保ったまま動く
    await row.scrollIntoViewIfNeeded();
    const bar = await row.getByTestId("vs-timeline-row-bar").boundingBox();
    await page.mouse.move(bar!.x + bar!.width / 2, bar!.y + bar!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar!.x + bar!.width / 2 - lane!.width / 4, bar!.y + bar!.height / 2, { steps: 6 });
    await page.mouse.up();
    const s2 = parseSubtitleTime(await page.getByTestId("vs-cue-start").inputValue())!;
    const e2 = parseSubtitleTime(await page.getByTestId("vs-cue-end").inputValue())!;
    expect(s2).toBeLessThan(0.3);
    expect(e2 - s2).toBeCloseTo(endVal - 1, 1);
    // 目盛りを押すと、そこへ再生位置が動く
    await page.getByTestId("vs-timeline-ruler").scrollIntoViewIfNeeded();
    const ruler = await page.getByTestId("vs-timeline-ruler").boundingBox();
    await page.mouse.click(ruler!.x + ruler!.width / 2, ruler!.y + ruler!.height / 2);
    await expect.poll(async () => page.getByTestId("vs-video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.8);
  });
});

// ---------------------------------------------------------------------------
// 3. 書き出し
// ---------------------------------------------------------------------------
test.describe("動画字幕追加：書き出し", () => {
  test.setTimeout(180_000);

  test("書き出しは、字幕を焼き付けた動画だけ（字幕トラック・字幕ファイルの選択肢はない）。WebMでも書き出せる", async ({ page }) => {
    await openWithVideo(page, fixtures.webm);
    await expect(page.getByTestId("vs-mode")).toHaveCount(0);
    await expect(page.getByTestId("vs-save-srt")).toHaveCount(0);
    await expect(page.getByTestId("vs-save-vtt")).toHaveCount(0);
    await expect(page.getByText("字幕トラック")).toHaveCount(0);
    await page.getByTestId("vs-burn-container-webm").check();
    await addCue(page, "00:00:00.100", "00:00:00.900", "WebM の字幕");
    const out = await exportAndSave(page);
    expect(out).toMatch(/-subtitled\.webm$/);
    expect(probeStreams(out).video).not.toBeNull();
  });

  test("音声のない動画でも書き出せる（映像だけ）", async ({ page }) => {
    const src = makeVideo({ sec: 2, audio: false });
    await openWithVideo(page, src);
    await addCue(page, "00:00:00.200", "00:00:01.800", "音声なし");
    const out = await exportAndSave(page);
    const streams = probeStreams(out);
    expect(streams.video).not.toBeNull();
    expect(streams.audio).toBeNull();
  });

  test("書き出し中にキャンセルすると、結果を出さずに止まり、そのあともう一度書き出せる", async ({ page }) => {
    const src = makeVideo({ sec: 6, audio: true, w: 640, h: 360, bitrate: "4M" });
    await openWithVideo(page, src);
    await addCue(page, "00:00:01.000", "00:00:02.000", "キャンセル");
    // 書き出しの途中で止められるよう、ファイルの読み込みを少し遅くする
    await page.evaluate(() => {
      const w = window as unknown as { __slow: boolean };
      w.__slow = true;
      // 元の動画の読み込み（Blob の stream の読み取り）を1回ごとに少し待たせる
      const origRead = ReadableStreamDefaultReader.prototype.read;
      ReadableStreamDefaultReader.prototype.read = async function (this: ReadableStreamDefaultReader) {
        if (w.__slow) await new Promise((r) => setTimeout(r, 300));
        return origRead.call(this);
      } as typeof origRead;
    });
    await page.getByTestId("vs-run").click();
    await page.getByTestId("vs-cancel").click();
    await expect(page.getByTestId("vs-canceled")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { __slow: boolean }).__slow = false;
    });
    const out = await exportAndSave(page);
    expect(out).toMatch(/-subtitled\.mp4$/);
    expect(probeStreams(out).video).not.toBeNull();
  });

  test("映像に焼き付ける：プレビューと同じ位置・色で字幕が映像に描かれ、どの再生アプリでも見える。音声も残る", async ({ page }) => {
    // 赤い色が入らない、灰色の動画（音声あり）
    const src = path.join(tmp(), "gray.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", src]);
    await openWithVideo(page, src);
    await addCue(page, "00:00:00.000", "00:00:02.500", "■■■■");
    const row = page.getByTestId("vs-cue").nth(0);
    await row.getByTestId("vs-cue-look").locator("summary").click();
    await row.getByTestId("vs-cue-color-赤").click();
    await row.getByTestId("vs-cue-outline").uncheck();
    await row.getByLabel("1番目の文字の大きさの数値").fill("15");
    await row.getByLabel("1番目の文字の大きさの数値").blur();
    await row.getByLabel("1番目の縦の位置（Y）の数値").fill("20");
    await row.getByLabel("1番目の縦の位置（Y）の数値").blur();
    const out = await exportAndSave(page);
    expect(out).toMatch(/-subtitled\.mp4$/);
    const streams = probeStreams(out);
    expect(streams.audio).not.toBeNull();
    // 1秒の位置のコマを取り出し、赤い文字が上の方（y=20%付近）にあることを確かめる
    const frame = path.join(tmp(), "frame.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", out, "-frames:v", "1", frame]);
    const r = JSON.parse(execFileSync("python3", ["-c", "import sys,json\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB')\nw,h=im.size\nys=[y for y in range(h) for x in range(0,w,2) if (lambda p:p[0]>170 and p[1]<90 and p[2]<90)(im.getpixel((x,y)))]\nprint(json.dumps({'n':len(ys),'cy':(sum(ys)/len(ys)/h) if ys else -1}))", frame], { encoding: "utf8" }));
    expect(r.n).toBeGreaterThan(30);
    expect(Math.abs(r.cy - 0.2)).toBeLessThan(0.07);
  });

  test("動画として読み込めないファイルは、日本語のエラーを出す", async ({ page }) => {
    const bad = path.join(tmp(), "broken.mp4");
    fs.writeFileSync(bad, "this is not a video");
    await page.goto("/tools/video-subtitle");
    await uploadFixture(page, bad);
    await expect(page.getByRole("alert").filter({ hasText: /動画|形式/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("vs-add")).toHaveCount(0);
  });
});
