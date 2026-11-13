import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * 画像・動画ツールの縦向き・横向き対応（次期機能追加 4）。
 *
 * 縦長・横長・正方形・EXIFで回転を指定したJPEG（保存は横長、表示は縦長）を各ツールに入れ、
 * プレビューに出る画像・キャンバス・動画が、元の縦横比のまま（引き伸ばし・つぶれなし）で表示されることを確かめる。
 * - <img>：表示の縦横比 ＝ 画像の縦横比（object-fit: contain / scale-down なら枠は違ってよい）
 * - <canvas>：表示の縦横比 ＝ キャンバスの縦横比
 * - <video>：表示の縦横比 ＝ 動画の縦横比（object-fit: contain なら枠は違ってよい）
 */

const IMAGE_TOOLS = [
  "image-compress",
  "image-format-convert",
  "image-crop",
  "image-rotate-flip",
  "image-adjust",
  "image-metadata-remove",
  "image-watermark",
  "image-layout",
  "image-merge",
  "image-padding-text",
  "image-padding",
  "image-tile-split",
  "image-mosaic",
  "background-remover",
] as const;

const VIDEO_TOOLS = [
  "video-convert",
  "video-compress",
  "video-resize",
  "video-frame-rate",
  "video-h264",
  "video-thumbnail",
  "video-cut-merge",
  "video-metadata-remove",
  "video-mosaic",
  "video-subtitle",
] as const;

type Distortion = { tag: string; shown: number; natural: number; testid: string | null };

/** 画面の中の画像・キャンバス・動画で、縦横比が崩れて表示されているものを返す */
async function findDistorted(page: Page): Promise<Distortion[]> {
  const { out, checked } = await page.evaluate(() => {
    const out: { tag: string; shown: number; natural: number; testid: string | null }[] = [];
    let checked = 0;
    const main = document.querySelector("main") ?? document.body;
    for (const el of Array.from(main.querySelectorAll("img, canvas, video"))) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue; // アイコンなど
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      let nw = 0;
      let nh = 0;
      if (el instanceof HTMLImageElement) {
        if (!el.complete || !el.naturalWidth) continue;
        if (el.src.startsWith("data:image/svg") || el.src.endsWith(".svg")) continue;
        nw = el.naturalWidth;
        nh = el.naturalHeight;
      } else if (el instanceof HTMLCanvasElement) {
        nw = el.width;
        nh = el.height;
      } else if (el instanceof HTMLVideoElement) {
        nw = el.videoWidth;
        nh = el.videoHeight;
      }
      if (!nw || !nh) continue;
      checked++;
      const fit = st.objectFit;
      if (fit === "contain" || fit === "scale-down" || (el instanceof HTMLVideoElement && fit !== "fill")) continue;
      if (fit === "cover") continue; // 意図した切り抜き（サムネイルの枠など）
      // 内側の大きさ（枠線・余白を除く）
      const bw = parseFloat(st.borderLeftWidth) + parseFloat(st.borderRightWidth) + parseFloat(st.paddingLeft) + parseFloat(st.paddingRight);
      const bh = parseFloat(st.borderTopWidth) + parseFloat(st.borderBottomWidth) + parseFloat(st.paddingTop) + parseFloat(st.paddingBottom);
      const shown = (r.width - bw) / (r.height - bh);
      const natural = nw / nh;
      // 1px の丸めを許す
      const tol = Math.max(0.03, 2 / Math.min(r.width - bw, r.height - bh));
      if (Math.abs(shown / natural - 1) > tol) {
        out.push({ tag: el.tagName.toLowerCase(), shown: Math.round(shown * 1000) / 1000, natural: Math.round(natural * 1000) / 1000, testid: el.closest("[data-testid]")?.getAttribute("data-testid") ?? null });
      }
    }
    return { out, checked };
  });
  lastChecked = checked;
  return out;
}
/** 直前の findDistorted で調べた要素の数（何も調べていないのに「崩れなし」としないため） */
let lastChecked = 0;

function exifRotatedJpeg(file: string) {
  // 保存は横長（300×200）、EXIFの向き＝6（右に90°回して表示）→ 表示は縦長（200×300）
  execFileSync("python3", [
    "-c",
    "import sys\nfrom PIL import Image\nim=Image.new('RGB',(300,200),(200,60,60))\nfor x in range(100):\n  for y in range(50): im.putpixel((x,y),(0,0,255))\nex=Image.Exif(); ex[0x0112]=6\nim.save(sys.argv[1], exif=ex.tobytes())",
    file,
  ]);
}

test.describe("画像ツール：縦長・横長・正方形・EXIFの回転", () => {
  for (const id of IMAGE_TOOLS) {
    test(`${id}：プレビューの縦横比が崩れない`, async ({ page }) => {
      test.setTimeout(120_000);
      const exif = test.info().outputPath("exif-rot6.jpg");
      exifRotatedJpeg(exif);
      for (const file of [fixtures.portraitPng, fixtures.landscapeJpg, fixtures.png, exif]) {
        await page.goto(`/tools/${id}`);
        await uploadFixture(page, file);
        // プレビューの描画を待つ
        await page.waitForTimeout(2500);
        const bad = await findDistorted(page);
        expect(bad, `${id} / ${file.split("/").pop()}`).toEqual([]);
        console.log(`[orientation] ${id} ${file.split("/").pop()} checked=${lastChecked}`);
        expect(lastChecked, `${id}: プレビューが見つからない`).toBeGreaterThan(0);
      }
    });
  }

  test("EXIFで回転を指定したJPEGは、プレビューでも縦長で表示される（image-crop）", async ({ page }) => {
    const exif = test.info().outputPath("exif-rot6.jpg");
    exifRotatedJpeg(exif);
    await page.goto("/tools/image-crop");
    await uploadFixture(page, exif);
    await page.waitForTimeout(2000);
    const shapes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("main img, main canvas"))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 60 && r.height > 60)
        .map((r) => r.height / r.width)
    );
    expect(shapes.length).toBeGreaterThan(0);
    expect(Math.max(...shapes)).toBeGreaterThan(1.3); // 縦長（1.5）
  });
});

test.describe("動画ツール：縦向き・横向き", () => {
  for (const id of VIDEO_TOOLS) {
    test(`${id}：プレビューの縦横比が崩れない`, async ({ page }) => {
      test.setTimeout(120_000);
      for (const file of [fixtures.cutPortraitWebm, fixtures.cutLandscapeWebm]) {
        await page.goto(`/tools/${id}`);
        await uploadFixture(page, file);
        await page.waitForTimeout(3000);
        const bad = await findDistorted(page);
        expect(bad, `${id} / ${file.split("/").pop()}`).toEqual([]);
        console.log(`[orientation] ${id} ${file.split("/").pop()} checked=${lastChecked}`);
        expect(lastChecked, `${id}: プレビューが見つからない`).toBeGreaterThan(0);
        // 縦長の動画は、縦長に表示される（横に引き伸ばされない）
        const vids = await page.evaluate(() =>
          Array.from(document.querySelectorAll("main video"))
            .filter((v) => (v as HTMLVideoElement).videoWidth > 0)
            .map((v) => ({ w: (v as HTMLVideoElement).videoWidth, h: (v as HTMLVideoElement).videoHeight }))
        );
        for (const v of vids) expect(v.w / v.h).toBeCloseTo(file.includes("portrait") ? 0.75 : 4 / 3, 1);
      }
    });
  }
});

test.describe("画像ツール：EXIFの回転を、書き出した画像にも反映する（回転情報を消しても横倒しにならない）", () => {
  /** 書き出した画像を、EXIFの向きを当てはめて読み、縦長か・青い角が右上にあるかを返す */
  function displayShape(file: string): { w: number; h: number; blueTopRight: boolean } {
    return JSON.parse(
      execFileSync("python3", [
        "-c",
        "import sys, json\nfrom PIL import Image, ImageOps\nim=ImageOps.exif_transpose(Image.open(sys.argv[1])).convert('RGB')\nw,h=im.size\nr,g,b=im.getpixel((w-5,5))\nprint(json.dumps({'w':w,'h':h,'blueTopRight': b>150 and r<100}))",
        file,
      ], { encoding: "utf8" })
    );
  }

  for (const c of [
    { id: "image-metadata-remove", run: "メタデータを削除する" },
    { id: "image-format-convert", run: /件を.*に変換する/, before: "PNG" },
  ] as { id: string; run: string | RegExp; before?: string }[]) {
    test(`${c.id}：保存は横長・EXIFで縦長のJPEGが、縦長のまま書き出される`, async ({ page }) => {
      test.setTimeout(90_000);
      const exif = test.info().outputPath("exif-rot6.jpg");
      exifRotatedJpeg(exif);
      await page.goto(`/tools/${c.id}`);
      await uploadFixture(page, exif);
      if (c.before) await page.getByRole("radio", { name: c.before, exact: true }).or(page.getByRole("button", { name: c.before, exact: true })).first().click();
      await page.getByRole("button", { name: c.run }).click();
      const popup = page.getByTestId("result-popup");
      await expect(popup).toBeVisible({ timeout: 30_000 });
      const wait = page.waitForEvent("download");
      await popup.getByRole("button", { name: /ダウンロード/ }).first().click();
      const out = test.info().outputPath("out-" + c.id);
      await (await wait).saveAs(out);
      const s = displayShape(out);
      expect(s.h).toBeGreaterThan(s.w);
      expect(s.blueTopRight).toBe(true);
    });
  }
});
