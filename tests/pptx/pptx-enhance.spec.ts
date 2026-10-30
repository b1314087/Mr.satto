import { test, expect } from "@playwright/test";
import { analyzeImage, findColorFringe, invertImagePixels, shouldEnhance, shouldUpscale, upscale2x } from "@/lib/pptx/image-invert";
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

  test("白黒が中心でカラーが混ざる画像は、太い色のついた部分に手を付けない（細い色のにじみは、白黒として反転する）", () => {
    // 6×6の赤い塗りに、黒い画素が接している
    const img = makeImage(14, 14, (x, y) => (x >= 4 && x < 10 && y >= 4 && y < 10 ? [220, 30, 30, 255] : x === 3 && y === 6 ? BLACK : WHITE));
    const out = invert(img, true, "invert-gray");
    expect(pixelAt(out, 6, 6)).toEqual([220, 30, 30, 255]);
    expect(pixelAt(out, 4, 4)).toEqual([220, 30, 30, 255]);
    expect(pixelAt(out, 3, 6)[0]).toBe(255);
    // 色のついた画素へは、太らせた線も入らない
    expect(pixelAt(out, 5, 5)).toEqual([220, 30, 30, 255]);
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

test.describe("低い解像度の画像のなめらかな拡大", () => {
  test("拡大する大きさの目安: 小さすぎる・十分に大きい画像は、そのまま", () => {
    expect(shouldUpscale(40, 30)).toBe(false);
    expect(shouldUpscale(599, 300)).toBe(false);
    expect(shouldUpscale(960, 540)).toBe(true);
    expect(shouldUpscale(1600, 900)).toBe(true);
    expect(shouldUpscale(1601, 900)).toBe(false);
    expect(shouldUpscale(2560, 1440)).toBe(false);
  });

  test("縦横2倍になり、一様な画像は一様のまま、境目は元の値の範囲で、なめらかに変わる", () => {
    const flat = upscale2x(makeImage(6, 4, () => [90, 120, 200, 255]));
    expect([flat.width, flat.height]).toEqual([12, 8]);
    for (let i = 0; i < flat.data.length; i += 4) expect(Array.from(flat.data.slice(i, i + 4))).toEqual([90, 120, 200, 255]);

    const edge = upscale2x(makeImage(8, 2, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
    const row = Array.from({ length: 16 }, (_, x) => pixelAt(edge, x, 1)[0]);
    // 左は黒・右は白で、途中に灰色の画素が入る（階段状にならない）。値は 0〜255 の範囲に収まる
    expect(row[0]).toBe(0);
    expect(row[15]).toBe(255);
    expect(row.some((v) => v > 0 && v < 255)).toBe(true);
    for (let x = 1; x < 16; x++) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1] - 12);
  });

  test("透明度も、いっしょに拡大される（不透明のままなら不透明）", () => {
    const up = upscale2x(makeImage(4, 4, (x) => [10, 10, 10, x < 2 ? 0 : 255]));
    expect(pixelAt(up, 0, 0)[3]).toBe(0);
    expect(pixelAt(up, 7, 7)[3]).toBe(255);
  });

  test("パワーポイント全体: 解像度が中くらいで文書のような画像だけ、2倍に拡大して反転する（調整オンのときだけ）", async () => {
    const big = makeImage(800, 600, (x, y) => (y % 50 < 3 && x > 40 && x < 700 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const src = buildPptx({ slides: [{ shapes: picture(2, "rId2") + picture(3, "rId3"), images: [{ name: "image1.png", bytes: encodePng(big) }, { name: "image2.png", bytes: encodePng(bwDocument()) }] }] });
    const off = await invertPptx(src, { ...DEFAULT_PPTX_INVERT_OPTIONS }, testCodec);
    const on = await invertPptx(src, { ...DEFAULT_PPTX_INVERT_OPTIONS, enhanceText: true }, testCodec);
    expect(off.report.images.map((i) => !!i.upscaled)).toEqual([false, false]);
    expect(on.report.images.map((i) => !!i.upscaled)).toEqual([true, false]);
    const outBig = decodePng(readParts(on.bytes)["ppt/media/image1.png"]);
    expect([outBig.width, outBig.height]).toEqual([1600, 1200]);
    // 小さい画像（40×30）は、大きさが変わらない
    const outSmall = decodePng(readParts(on.bytes)["ppt/media/image2.png"]);
    expect([outSmall.width, outSmall.height]).toEqual([40, 30]);
    expect(on.report.notes.join("\n")).toContain("2倍に拡大");
    // 報告に出す大きさは、元の画像の大きさのまま
    expect([on.report.images[0].width, on.report.images[0].height]).toEqual([800, 600]);
  });
});

test.describe("文字の縁の色のにじみ（二重線の原因）", () => {
  // 白地に、黒い縦線（x=10）。その両側に、オレンジ（左・x=9）と青（右・x=11）のにじみ
  const fringed = () =>
    makeImage(40, 30, (x, y) => {
      if (y < 6) return WHITE;
      if (x === 10) return BLACK;
      if (x === 9) return [255, 200, 130, 255];
      if (x === 11) return [130, 190, 255, 255];
      // 太い赤い塗り（20〜31 × 12〜23）
      if (x >= 20 && x < 32 && y >= 12 && y < 24) return [220, 30, 30, 255];
      return WHITE;
    });

  test("黒い線に接した細い色のにじみは、にじみとして見つかる。太い赤い塗りは、見つからない", () => {
    const img = fringed();
    const f = findColorFringe(img.data, img.width, img.height);
    expect(f[10 * img.width + 9]).toBe(1);
    expect(f[10 * img.width + 11]).toBe(1);
    expect(f[16 * img.width + 25]).toBe(0);
    expect(f[16 * img.width + 21]).toBe(0);
  });

  test("黒い線から離れた、濃い色の細い線は、にじみにしない（色を残す）。色の弱い細い線は、にじみとする", () => {
    const img = makeImage(40, 30, (x) => (x === 5 ? [20, 20, 200, 255] : x === 30 ? [255, 235, 200, 255] : WHITE));
    const f = findColorFringe(img.data, img.width, img.height);
    expect(f[10 * img.width + 5]).toBe(0);
    expect(f[10 * img.width + 30]).toBe(1);
  });

  test("拡大した画像では、にじみの幅も広がるので、見る範囲を拡大の倍率に合わせる", () => {
    // 幅4画素のオレンジのにじみが、黒い線の左に付いている（2倍に拡大したあとの画像を想定）
    const img = makeImage(60, 30, (x) => (x === 30 ? BLACK : x >= 26 && x < 30 ? [255, 190, 90, 255] : WHITE));
    expect(findColorFringe(img.data, img.width, img.height, 2)[10 * img.width + 27]).toBe(1);
  });

  test("調整つきの反転: 黒い線は白い線になり、にじみは色が残らず、灰色の縁になる。赤い塗りは赤のまま", () => {
    const img = fringed();
    const out = { ...img, data: new Uint8ClampedArray(img.data) };
    invertImagePixels(out.data, "invert-gray", null, { width: img.width, height: img.height });
    const at = (x: number, y: number) => pixelAt(out, x, y);
    expect(at(10, 12).slice(0, 3)).toEqual([255, 255, 255]);
    for (const x of [9, 11]) {
      const [r, g, b] = at(x, 12);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBe(0);
    }
    expect(at(25, 16).slice(0, 3)).toEqual([220, 30, 30]);
  });

  test("見やすさの調整をしない（従来の反転）ときも、白黒中心の画像では、にじみが色のまま残らず、白い文字のまわりに色の輪が出ない", () => {
    const img = fringed();
    const out = { ...img, data: new Uint8ClampedArray(img.data) };
    invertImagePixels(out.data, "invert-gray", null, undefined, { width: img.width, height: img.height });
    const at = (x: number, y: number) => pixelAt(out, x, y);
    expect(at(10, 12).slice(0, 3)).toEqual([255, 255, 255]);
    for (const x of [9, 11]) {
      const [r, g, b] = at(x, 12);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBe(0);
    }
    // 太い赤い塗りは、従来どおり赤のまま
    expect(at(25, 16).slice(0, 3)).toEqual([220, 30, 30]);
    // 大きさを渡さない（従来の呼び方）ときは、これまでと同じ動き（にじみは色のまま）
    const legacy = { ...img, data: new Uint8ClampedArray(img.data) };
    invertImagePixels(legacy.data, "invert-gray", null);
    expect(pixelAt(legacy, 9, 12)).toEqual([255, 200, 130, 255]);
  });
  test("オプション reduceColorFringe: 既定（オン）はにじみを白黒にし、false にすると従来どおり色のまま残す。太い赤い塗りはどちらも赤のまま", async () => {
    const src = buildPptx({
      slides: [{ shapes: picture(2, "rId2"), images: [{ name: "image1.png", bytes: encodePng(fringed()) }] }],
    });
    const on = await invertPptx(src, { ...DEFAULT_PPTX_INVERT_OPTIONS }, testCodec);
    const off = await invertPptx(src, { ...DEFAULT_PPTX_INVERT_OPTIONS, reduceColorFringe: false }, testCodec);
    const onImg = decodePng(readParts(on.bytes)["ppt/media/image1.png"]);
    const offImg = decodePng(readParts(off.bytes)["ppt/media/image1.png"]);
    const chroma = (img: ReturnType<typeof decodePng>, x: number, y: number) => {
      const [r, g, b] = pixelAt(img, x, y);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    expect(chroma(onImg, 9, 12)).toBe(0);
    expect(chroma(offImg, 9, 12)).toBeGreaterThan(30);
    expect(pixelAt(onImg, 25, 16).slice(0, 3)).toEqual([220, 30, 30]);
    expect(pixelAt(offImg, 25, 16).slice(0, 3)).toEqual([220, 30, 30]);
  });
});
