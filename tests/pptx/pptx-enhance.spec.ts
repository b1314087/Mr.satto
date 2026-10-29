import { test, expect } from "@playwright/test";
import { analyzeImage, invertImagePixels, shouldEnhance } from "@/lib/pptx/image-invert";
import { invertPptx, DEFAULT_PPTX_INVERT_OPTIONS } from "@/lib/pptx/invert-pptx";
import { bwDocument, bwPhoto, buildPptx, encodePng, makeImage, picture, pixelAt, readParts, decodePng, testCodec } from "../helpers/pptx-builder";

/** 反転後の「文字の見やすさ」の調整（背景のにじみ消し・細い線の明るさ・線を少し太らせる）のテスト */

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

function invert(img: ReturnType<typeof makeImage>, enhance: boolean, decision: "invert-all" | "invert-gray" = "invert-all") {
  const copy = { ...img, data: new Uint8ClampedArray(img.data) };
  invertImagePixels(copy.data, decision, null, enhance ? { width: img.width, height: img.height } : undefined);
  return copy;
}

test.describe("画像の文字を見やすくする調整", () => {
  test("オフのとき（enhance なし）は、従来どおりの単純な反転のまま", () => {
    const img = makeImage(5, 5, (x) => (x === 2 ? [100, 100, 100, 255] : WHITE));
    const out = invert(img, false);
    expect(pixelAt(out, 2, 2)).toEqual([155, 155, 155, 255]);
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  test("背景の薄いにじみ（ほぼ白）は、完全な背景色になる", () => {
    const img = makeImage(9, 9, (x, y) => (x === 4 && y === 4 ? BLACK : (x + y) % 2 === 0 ? [248, 248, 248, 255] : [240, 240, 240, 255]));
    const out = invert(img, true);
    // 離れた画素（にじみ）は 0 ＝ 背景色
    expect(pixelAt(out, 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(out, 8, 8).slice(0, 3)).toEqual([0, 0, 0]);
    // 文字の画素は文字色いっぱい
    expect(pixelAt(out, 4, 4).slice(0, 3)).toEqual([255, 255, 255]);
  });

  test("細い線の灰色は、単純な反転より明るくなる（文字が薄くならない）", () => {
    const img = makeImage(15, 15, (x) => (x === 7 ? [100, 100, 100, 255] : WHITE));
    const plain = pixelAt(invert(img, false), 7, 3)[0];
    const better = pixelAt(invert(img, true), 7, 3)[0];
    expect(plain).toBe(155);
    expect(better).toBeGreaterThan(plain + 30);
    expect(better).toBeLessThanOrEqual(255);
  });

  test("線が少し太る（上下左右の隣は、文字色の約6割まで。斜めは変わらない）", () => {
    const img = makeImage(9, 9, (x, y) => (x === 4 && y === 4 ? BLACK : WHITE));
    const out = invert(img, true);
    expect(pixelAt(out, 4, 4)[0]).toBe(255);
    for (const [x, y] of [[3, 4], [5, 4], [4, 3], [4, 5]]) expect(pixelAt(out, x, y)[0], `${x},${y}`).toBe(153);
    for (const [x, y] of [[3, 3], [5, 5], [3, 5], [5, 3], [0, 0]]) expect(pixelAt(out, x, y)[0], `${x},${y}`).toBe(0);
  });

  test("透明に近い画素は太らせず、透明度は変えない", () => {
    const img = makeImage(9, 3, (x) => (x === 4 ? BLACK : x === 5 ? [255, 255, 255, 90] : WHITE));
    const out = invert(img, true);
    expect(pixelAt(out, 5, 1)).toEqual([0, 0, 0, 90]);
    expect(pixelAt(out, 3, 1)[3]).toBe(255);
    expect(pixelAt(out, 3, 1)[0]).toBe(153);
  });

  test("白黒が中心でカラーが混ざる画像は、色のついた画素に手を付けない", () => {
    const img = makeImage(9, 9, (x, y) => (x === 4 && y === 4 ? [220, 30, 30, 255] : x === 3 && y === 4 ? BLACK : WHITE));
    const out = invert(img, true, "invert-gray");
    expect(pixelAt(out, 4, 4)).toEqual([220, 30, 30, 255]);
    expect(pixelAt(out, 3, 4)[0]).toBe(255);
    // 色のついた画素へは、太らせた線も入らない
    expect(pixelAt(out, 4, 4)).toEqual([220, 30, 30, 255]);
  });

  test("配色を指定したときは、調整した濃さを、背景色〜文字色の間に写す", () => {
    const img = makeImage(9, 9, (x, y) => (x === 4 && y === 4 ? BLACK : WHITE));
    const copy = { ...img, data: new Uint8ClampedArray(img.data) };
    invertImagePixels(copy.data, "invert-all", { background: { r: 23, g: 23, b: 23 }, text: { r: 242, g: 242, b: 242 } }, { width: 9, height: 9 });
    expect(pixelAt(copy, 0, 0).slice(0, 3)).toEqual([23, 23, 23]);
    expect(pixelAt(copy, 4, 4).slice(0, 3)).toEqual([242, 242, 242]);
  });

  test("調整の対象は、文書のような画像（白地・黒地が中心）だけ。白黒写真は対象外", () => {
    const doc = bwDocument();
    const photo = bwPhoto();
    expect(shouldEnhance(analyzeImage(doc.data, doc.width, doc.height))).toBe(true);
    expect(shouldEnhance(analyzeImage(photo.data, photo.width, photo.height))).toBe(false);
  });

  test("寸法が合わないときは、調整せずに単純な反転にする（壊れた入力で落ちない）", () => {
    const img = makeImage(4, 4, () => [100, 100, 100, 255]);
    const copy = { ...img, data: new Uint8ClampedArray(img.data) };
    invertImagePixels(copy.data, "invert-all", null, { width: 99, height: 99 });
    expect(pixelAt(copy, 0, 0)).toEqual([155, 155, 155, 255]);
  });
});

test.describe("pptx全体（enhanceText）", () => {
  const deck = (images: ReturnType<typeof makeImage>[]) =>
    buildPptx({
      slides: [{ shapes: images.map((_, i) => picture(i + 2, `rId${i + 2}`)).join(""), images: images.map((im, i) => ({ name: `image${i + 1}.png`, bytes: encodePng(im) })) }],
    });

  test("既定（オフ）では、画像は従来どおり。enhanceText をオンにすると、文書のような画像だけ調整される", async () => {
    const src = deck([bwDocument(), bwPhoto()]);
    const off = await invertPptx(src, { ...DEFAULT_PPTX_INVERT_OPTIONS }, testCodec);
    const on = await invertPptx(src, { ...DEFAULT_PPTX_INVERT_OPTIONS, enhanceText: true }, testCodec);
    expect(off.report.images.map((i) => !!i.enhanced)).toEqual([false, false]);
    expect(on.report.images.map((i) => !!i.enhanced)).toEqual([true, false]);
    // 文書の画像は、調整で変わる。写真は、オフと同じ
    const offDoc = decodePng(readParts(off.bytes)["ppt/media/image1.png"]);
    const onDoc = decodePng(readParts(on.bytes)["ppt/media/image1.png"]);
    expect(Buffer.from(onDoc.data).equals(Buffer.from(offDoc.data))).toBe(false);
    expect(readParts(on.bytes)["ppt/media/image2.png"]).toEqual(readParts(off.bytes)["ppt/media/image2.png"]);
    // 透明度は変わらない
    for (const [x, y] of [[0, 0], [12, 3], [39, 29]]) expect(pixelAt(onDoc, x, y)[3]).toBe(255);
  });
});
