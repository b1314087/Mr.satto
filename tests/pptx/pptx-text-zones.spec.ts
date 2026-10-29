import { test, expect } from "@playwright/test";
import { findColorFringe } from "@/lib/pptx/image-invert";
import { invertPptx, DEFAULT_PPTX_INVERT_OPTIONS } from "@/lib/pptx/invert-pptx";
import { buildTextZoneMask } from "@/lib/pptx/text-zones";
import { buildPptx, decodePng, encodePng, makeImage, picture, pixelAt, readParts, testCodec } from "../helpers/pptx-builder";

/** AIが見つけた「文字の範囲」を使った、白黒の反転（画像は画像のまま）のテスト */

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

/** 100×60 の白地。文字のかわりの縞（x 10〜59, y 20〜31）、文字から離れた赤い細い線（x=64）、太い青い四角（6×6） */
const page = () =>
  makeImage(100, 60, (x, y) => {
    if (x >= 10 && x < 60 && y >= 20 && y < 32 && x % 2 === 0) return BLACK;
    if (x === 64 && y >= 20 && y < 32) return RED;
    if (x >= 80 && x < 86 && y >= 40 && y < 46) return BLUE;
    return WHITE;
  });

// AIの枠（実際より小さく、少し上にずれている）
const SMALL_LINE = { x: 0.1, y: 0.3, w: 0.3, h: 0.12 };

test.describe("文字の範囲の地図", () => {
  test("AIの枠が小さくても、画像の文字に合わせて広げ、文字のふちの数画素まで範囲にする。離れた場所は範囲にしない", () => {
    const img = page();
    const zone = buildTextZoneMask(img, [SMALL_LINE]);
    expect(zone).not.toBeNull();
    const at = (x: number, y: number) => zone![y * img.width + x];
    expect(at(10, 25)).toBe(1); // 文字の左はし
    expect(at(58, 25)).toBe(1); // 文字の右はし（AIの枠は x=40 までだった）
    expect(at(62, 25)).toBe(1); // 文字のふちの外側
    expect(at(95, 5)).toBe(0);
    expect(at(80, 43)).toBe(0); // 青い四角のあたり
  });

  test("行がないときは、範囲なし（null）", () => {
    expect(buildTextZoneMask(page(), [])).toBeNull();
  });
});

test.describe("範囲の中の細い色を、白黒にそろえる", () => {
  const colored = (img: ReturnType<typeof page>, zone?: Uint8Array) => findColorFringe(img.data, img.width, img.height, 1, zone);

  test("範囲なしでは、文字から離れた濃い赤の細い線は、色のまま（にじみとみなさない）", () => {
    const img = page();
    expect(colored(img)[25 * img.width + 64]).toBe(0);
  });

  test("範囲の中では、濃い赤の細い線も、白黒にそろえる。太い青い四角は、範囲の中でも色のまま", () => {
    const img = page();
    const zone = new Uint8Array(img.width * img.height).fill(1);
    const fringe = colored(img, zone);
    expect(fringe[25 * img.width + 64]).toBe(1);
    expect(fringe[43 * img.width + 82]).toBe(0);
  });
});

test.describe("スライド全体（画像は画像のまま、範囲の中だけ白黒にそろえる）", () => {
  const build = () => buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "image1.png", bytes: encodePng(page()) }] }] });

  test("AIの範囲を渡すと、範囲の中の赤い線が灰色（白黒）に反転される。渡さないと赤のまま。青い四角はどちらも色のまま", async () => {
    const withoutZone = await invertPptx(build(), { ...DEFAULT_PPTX_INVERT_OPTIONS, enhanceText: true }, testCodec);
    const withZone = await invertPptx(
      build(),
      { ...DEFAULT_PPTX_INVERT_OPTIONS, enhanceText: true, textZoneFor: (_path, image) => buildTextZoneMask(image, [SMALL_LINE]) },
      testCodec,
    );
    const imgOf = (r: { bytes: Uint8Array }) => decodePng(readParts(r.bytes)["ppt/media/image1.png"]);
    const a = imgOf(withoutZone);
    const b = imgOf(withZone);
    expect(pixelAt(a, 64, 25).slice(0, 3)).toEqual([255, 0, 0]);
    const [r, g, bl] = pixelAt(b, 64, 25);
    expect(r).toBe(g);
    expect(g).toBe(bl);
    expect(r).toBeGreaterThan(60);
    expect(pixelAt(a, 82, 43).slice(0, 3)).toEqual([0, 0, 255]);
    expect(pixelAt(b, 82, 43).slice(0, 3)).toEqual([0, 0, 255]);
    // 画像の大きさは変わらず、文字の位置も同じ（消したり入れ直したりしない）
    expect(b.width).toBe(a.width);
    expect(pixelAt(b, 10, 25).slice(0, 3)).toEqual([255, 255, 255]);
    expect(withZone.report.images[0].zoned).toBe(true);
    expect(withoutZone.report.images[0].zoned).toBe(false);
    expect(withZone.report.notes.join("\n")).toContain("AIが見つけた文字の範囲");
  });
});
