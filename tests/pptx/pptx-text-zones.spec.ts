import { test, expect } from "@playwright/test";
import { findColorFringe } from "@/lib/pptx/image-invert";
import { invertPptx, DEFAULT_PPTX_INVERT_OPTIONS } from "@/lib/pptx/invert-pptx";
import { buildInkMask, buildTextZoneMask, padLine, snapLineToInk } from "@/lib/pptx/text-zones";
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

// ---------- AIの位置が実際の文字より小さい・ずれているとき（行の位置を、画像の文字に合わせる） ----------
// 黒い画像（200×100）に、文字のかわりの縞模様（1列おきに白い）の行を置く
const W = 200;
const Hh = 100;
const stripes = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1 && x % 2 === 0;
const textImage = () =>
  makeImage(W, Hh, (x, y) =>
    stripes(x, y, 20, 30, 120, 42) || stripes(x, y, 20, 50, 120, 62) || (x === 150 && y >= 5 && y < 95) // 3つめは、縦の細い線（枠線）
      ? [255, 255, 255, 255]
      : (x + y) % 2 === 0 && y >= 80
        ? [24, 24, 24, 255] // うすい方眼（文字の画素にしない）
        : [0, 0, 0, 255],
  );
const maskOf = (image: ReturnType<typeof textImage>) => buildInkMask(image.data, image.width, image.height, "000000", "FFFFFF");
const aiLine = (x: number, y: number, w: number, h: number) => ({ text: "あいうえお", x, y, w, h, underline: false, bold: false });

test.describe("文字の画素の地図", () => {
  test("明るい文字は文字の画素になり、うすい方眼・背景は含まれない", () => {
    const image = textImage();
    const mask = maskOf(image);
    expect(mask[30 * W + 20]).toBe(1);
    expect(mask[31 * W + 21]).toBe(0); // 縞のすき間
    expect(mask[85 * W + 41]).toBe(0); // うすい方眼
    expect(mask[10 * W + 100]).toBe(0);
  });
});

test.describe("AIの位置を、画像の文字に合わせる", () => {
  test("AIの行が実際より小さく・上にずれていても、実際の文字の範囲（1行ぶん）に合わせる", () => {
    const mask = maskOf(textImage());
    // 実際は x 20〜119、y 30〜41。AIは、左上だけ近く、幅・高さが0.4倍で、少し上
    const r = snapLineToInk(mask, W, Hh, aiLine(20 / W, 27 / Hh, 40 / W, 5 / Hh));
    expect(r.snapped).toBe(true);
    expect(r.line.x * W).toBeCloseTo(20, 0);
    expect(r.line.y * Hh).toBeCloseTo(30, 0);
    expect((r.line.x + r.line.w) * W).toBeGreaterThanOrEqual(118);
    expect((r.line.y + r.line.h) * Hh).toBeCloseTo(42, 0);
    // 下の行（すき間7行）・縦の細い線（x=150）には広がらない
    expect((r.line.x + r.line.w) * W).toBeLessThan(125);
    expect((r.line.y + r.line.h) * Hh).toBeLessThan(46);
    expect(r.density).toBeGreaterThan(0.3);
  });

  test("AIの位置がほぼ合っているときは、そのまま（動かさない）", () => {
    const mask = maskOf(textImage());
    const r = snapLineToInk(mask, W, Hh, aiLine(20 / W, 30 / Hh, 100 / W, 12 / Hh));
    expect(r.snapped).toBe(false);
    expect(r.line.y).toBeCloseTo(30 / Hh);
  });

  test("文字がない場所の行は、そのまま（探しても見つからない）", () => {
    const mask = maskOf(textImage());
    const r = snapLineToInk(mask, W, Hh, aiLine(0.6, 0.05, 0.1, 0.05));
    expect(r.snapped).toBe(false);
  });

  test("ほぼ全面が塗りつぶされた帯は、文字ではないので、動かさない", () => {
    const band = makeImage(W, Hh, (_x, y) => (y >= 15 && y < 35 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const r = snapLineToInk(maskOf(band), W, Hh, aiLine(0.2, 0.2, 0.5, 0.08));
    expect(r.snapped).toBe(false);
  });

  test("上下の行がくっついて、AIの高さの3.6倍を超えるまとまりのときは、直さない", () => {
    const tall = makeImage(W, Hh, (x, y) => (x % 2 === 0 && x >= 20 && x < 120 && y >= 10 && y < 90 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const r = snapLineToInk(maskOf(tall), W, Hh, aiLine(20 / W, 12 / Hh, 40 / W, 6 / Hh));
    expect(r.snapped).toBe(false);
  });
});

test.describe("消す範囲を広げる", () => {
  test("行の高さの約15%（最低1px）、上下左右に広げ、画像の外には出ない", () => {
    const r = padLine(aiLine(0.1, 0.3, 0.5, 0.2), 200, 100); // 高さ20px → 3px
    expect(r.x * 200).toBeCloseTo(17, 5);
    expect(r.y * 100).toBeCloseTo(27, 5);
    expect((r.x + r.w) * 200).toBeCloseTo(123, 5);
    expect((r.y + r.h) * 100).toBeCloseTo(53, 5);
    const edge = padLine(aiLine(0, 0, 1, 0.1), 200, 100);
    expect(edge.x).toBe(0);
    expect(edge.x + edge.w).toBe(1);
    expect(edge.y).toBe(0);
  });
});
