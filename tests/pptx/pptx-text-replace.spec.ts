import { test, expect } from "@playwright/test";
import { strFromU8 } from "fflate";
import { applyTextReplacements, buildInkMask, padLine, buildTextBoxXml, findTallLines, snapLineToInk, estimateTextEm, lineFontPt, paintLines, paintLinesAdaptive, pickTextColor, scanSlidePictures, unifyFontSizes, type SlidePicture } from "@/lib/pptx/text-replace";
import { buildPptx, encodePng, makeImage, picture, pixelAt, readParts, decodePng, testCodec } from "../helpers/pptx-builder";

/** 画像の中の文字を、本物のテキストボックスに置き換える処理のテスト（画像の位置合わせ・消去・XML） */

// 黒背景（反転後の画像を想定）に、白い横線（文字の代わり）
const img = () => makeImage(100, 80, (x, y) => (y >= 20 && y < 28 && x >= 20 && x < 70 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
const deck = (shapes: string) => buildPptx({ slides: [{ shapes, images: [{ name: "image1.png", bytes: encodePng(img()) }] }] });
const slideOf = (bytes: Uint8Array) => strFromU8(readParts(bytes)["ppt/slides/slide1.xml"]);
const LINE = { text: "直角三角形ABC", x: 0.2, y: 0.25, w: 0.5, h: 0.1, underline: false, bold: false };
const OPT = { textColor: "F2F2F2", backgroundColor: "171717" };

test.describe("スライド上の画像の位置を調べる", () => {
  test("画像の位置・大きさ・トリミングを読み取る", () => {
    const { pictures, skipped } = scanSlidePictures(readParts(deck(picture(2, "rId2"))));
    expect(skipped).toBe(0);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ slidePath: "ppt/slides/slide1.xml", imagePath: "ppt/media/image1.png", offX: 914400, offY: 914400, cx: 1828800, cy: 1371600 });
    expect(pictures[0].cropL).toBeCloseTo(0.05);
    expect(pictures[0].cropT).toBeCloseTo(0.05);
    expect(pictures[0].cropR).toBe(0);
  });

  test("回転した画像・反転した画像・グループの中の画像は、位置が確実でないため対象外", () => {
    const rotated = picture(2, "rId2").replace("<a:xfrm>", '<a:xfrm rot="5400000">');
    const flipped = picture(2, "rId2").replace("<a:xfrm>", '<a:xfrm flipH="1">');
    const grouped = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${picture(2, "rId2")}</p:grpSp>`;
    for (const [name, shapes] of [["回転", rotated], ["反転", flipped], ["グループ", grouped]] as const) {
      const scan = scanSlidePictures(readParts(deck(shapes)));
      expect(scan.pictures, name).toHaveLength(0);
      expect(scan.skipped, name).toBe(1);
    }
    // グループの外の画像は、グループがあっても対象になる
    const mixed = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:grpSp>${picture(2, "rId2")}`;
    expect(scanSlidePictures(readParts(deck(mixed))).pictures).toHaveLength(1);
  });
});

test.describe("テキストボックスのXML", () => {
  const pic: SlidePicture = { slidePath: "ppt/slides/slide1.xml", imagePath: "ppt/media/image1.png", offX: 914400, offY: 914400, cx: 1828800, cy: 1371600, cropL: 0.05, cropT: 0.05, cropR: 0, cropB: 0 };

  test("画像の位置・トリミングに合わせた場所に、文字の色・太字・下線つきで作る", () => {
    const xml = buildTextBoxXml(7, pic, { ...LINE, underline: true, bold: true }, "F2F2F2")!;
    const x = Math.round(914400 + ((0.2 - 0.05) / 0.95) * 1828800);
    const y = Math.round(914400 + ((0.25 - 0.05) / 0.95) * 1371600);
    expect(xml).toContain(`<p:cNvPr id="7"`);
    expect(xml).toContain(`<a:off x="${x}" y="${y}"/>`);
    expect(xml).toContain('<a:srgbClr val="F2F2F2"/>');
    expect(xml).toContain(' b="1"');
    expect(xml).toContain(' u="sng"');
    expect(xml).toContain("<a:t>直角三角形ABC</a:t>");
    expect(xml).toContain('txBox="1"');
  });

  test("文字は、XMLの特殊文字をエスケープする。色の指定が不正なら白にする", () => {
    const xml = buildTextBoxXml(3, pic, { ...LINE, text: 'a<b & "c"' }, "zzz")!;
    expect(xml).toContain("<a:t>a&lt;b &amp; &quot;c&quot;</a:t>");
    expect(xml).toContain('val="FFFFFF"');
  });

  test("トリミングで見えていない範囲にかかる行は、置き換えない", () => {
    expect(buildTextBoxXml(3, pic, { ...LINE, x: 0.01 }, "FFFFFF")).toBeNull();
    expect(buildTextBoxXml(3, { ...pic, cropR: 0.5 }, { ...LINE, x: 0.4, w: 0.3 }, "FFFFFF")).toBeNull();
  });

  test("枠に収まらない長い文字は、文字の大きさを小さくする（半分までは小さくしない）", () => {
    const short = buildTextBoxXml(3, pic, { ...LINE, text: "あ", w: 0.5 }, "FFFFFF")!;
    const long = buildTextBoxXml(3, pic, { ...LINE, text: "あ".repeat(40), w: 0.2 }, "FFFFFF")!;
    const sz = (xml: string) => Number(/ sz="(\d+)"/.exec(xml)![1]);
    expect(sz(long)).toBeLessThan(sz(short));
    expect(sz(long)).toBeGreaterThanOrEqual(Math.floor(sz(short) * 0.6));
    expect(estimateTextEm("ab")).toBeCloseTo(1.1);
    expect(estimateTextEm("あい")).toBe(2);
  });
});

test.describe("画像から文字を消す", () => {
  test("行の長方形（少し広げた範囲）だけを背景色で塗り、ほかの画素は変えない", () => {
    const image = img();
    paintLines(image.data, image.width, image.height, [{ ...LINE, x: 0.2, y: 0.25, w: 0.5, h: 0.1 }], "171717");
    expect(pixelAt(image, 40, 24).slice(0, 3)).toEqual([23, 23, 23]);
    expect(pixelAt(image, 5, 5).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(image, 90, 70).slice(0, 3)).toEqual([0, 0, 0]);
  });
});

test.describe("applyTextReplacements", () => {
  test("画像から文字を消し、スライドにテキストボックスを追加する。元のIDと重ならない", async () => {
    const src = deck(picture(2, "rId2"));
    const { bytes, report } = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines: [LINE] }], OPT, testCodec);
    expect(report).toMatchObject({ lines: 1, images: 1, skippedLines: 0 });
    const xml = slideOf(bytes);
    expect(xml).toContain("<a:t>直角三角形ABC</a:t>");
    expect(xml).toContain('val="F2F2F2"');
    expect(xml).toMatch(/<p:cNvPr id="3" name="AI文字 3"\/>/);
    expect(xml.indexOf("<p:sp>")).toBeLessThan(xml.indexOf("</p:spTree>"));
    // 文字（白い線）が消え、背景色になる。外側は変わらない
    const out = decodePng(readParts(bytes)["ppt/media/image1.png"]);
    expect(pixelAt(out, 40, 24).slice(0, 3)).toEqual([23, 23, 23]);
    expect(pixelAt(out, 2, 2).slice(0, 3)).toEqual([0, 0, 0]);
    // 元のファイルは変わらない
    expect(Buffer.from(readParts(src)["ppt/media/image1.png"]).equals(Buffer.from(encodePng(img())))).toBe(true);
  });

  test("位置を合わせられない画像（回転・グループの中）の行は置き換えず、画像も変えない", async () => {
    const rotated = picture(2, "rId2").replace("<a:xfrm>", '<a:xfrm rot="5400000">');
    const src = deck(rotated);
    const { bytes, report } = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines: [LINE, LINE] }], OPT, testCodec);
    expect(report).toMatchObject({ lines: 0, images: 0, skippedLines: 2 });
    expect(slideOf(bytes)).not.toContain("AI文字");
    expect(Buffer.from(readParts(bytes)["ppt/media/image1.png"]).equals(Buffer.from(readParts(src)["ppt/media/image1.png"]))).toBe(true);
    expect(report.notes.some((n) => n.includes("2行"))).toBe(true);
  });

  test("見えている範囲の外の行だけは置き換えず、ほかの行は置き換える", async () => {
    const src = deck(picture(2, "rId2"));
    const outside = { ...LINE, text: "範囲外", x: 0.0, w: 0.04 };
    const { bytes, report } = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines: [outside, LINE] }], OPT, testCodec);
    expect(report).toMatchObject({ lines: 1, skippedLines: 1 });
    const xml = slideOf(bytes);
    expect(xml).toContain("直角三角形ABC");
    expect(xml).not.toContain("範囲外");
  });

  test("同じ画像が2つの位置に貼られているときは、両方にテキストボックスを追加し、画像からは1回だけ消す", async () => {
    const src = deck(picture(2, "rId2") + picture(3, "rId2"));
    const { bytes, report } = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines: [LINE] }], OPT, testCodec);
    expect(report).toMatchObject({ lines: 2, images: 1 });
    expect((slideOf(bytes).match(/<a:t>直角三角形ABC<\/a:t>/g) ?? []).length).toBe(2);
  });

  test("置き換える行がない・存在しない画像のときは、何も変えない", async () => {
    const src = deck(picture(2, "rId2"));
    const a = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines: [] }], OPT, testCodec);
    expect(a.report.lines).toBe(0);
    const b = await applyTextReplacements(src, [{ imagePath: "ppt/media/none.png", lines: [LINE] }], OPT, testCodec);
    expect(b.report).toMatchObject({ lines: 0, skippedLines: 1 });
  });
});

test.describe("文字の大きさをそろえる", () => {
  test("近い大きさの行は、中央値にそろう。大きく違う行（見出しなど）は、別のまとまり", () => {
    const out = unifyFontSizes([20, 20.8, 21.5, 40, 41]);
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
    expect(out[3]).toBe(out[4]);
    expect(out[0]).toBeCloseTo(20.8);
    expect(out[3]).toBeGreaterThan(out[0]!);
  });

  test("幅に収めるために小さくなっていた行は、小さいまま。作れない行（null）は null のまま", () => {
    const out = unifyFontSizes([20, 20, 20, 17, null]);
    expect(out[3]).toBe(17);
    expect(out[0]).toBe(20);
    expect(out[4]).toBeNull();
    expect(unifyFontSizes([])).toEqual([]);
  });

  test("スライドでは、高さが少しずれた同じ段落の行が、同じ文字の大きさ（sz）になる", async () => {
    const lines = [0.4, 0.46, 0.52].map((y, n) => ({ ...LINE, text: "あいうえお", y, h: 0.05 + n * 0.002, w: 0.4 }));
    const { bytes } = await applyTextReplacements(deck(picture(2, "rId2")), [{ imagePath: "ppt/media/image1.png", lines }], OPT, testCodec);
    const sizes = [...slideOf(bytes).matchAll(/ sz="(\d+)"/g)].map((m) => m[1]);
    expect(sizes).toHaveLength(3);
    expect(new Set(sizes).size).toBe(1);
  });

  test("lineFontPt は、行の高さと幅から決める（トリミングの外の行は null）", () => {
    const pic: SlidePicture = { slidePath: "s", imagePath: "i", offX: 0, offY: 0, cx: 9144000, cy: 5143500, cropL: 0.05, cropT: 0, cropR: 0, cropB: 0 };
    expect(lineFontPt(pic, { ...LINE, x: 0.01 })).toBeNull();
    expect(lineFontPt(pic, LINE)).toBeGreaterThan(4);
  });
});

test.describe("画像から文字を消す（周りの色に合わせる）", () => {
  // 元が白文字の帯だった見出しを想定: 反転後は、白い帯の上に、黒っぽい文字の跡
  const bar = () => makeImage(100, 80, (x, y) => (y >= 15 && y < 35 ? [250, 250, 250, 255] : [23, 23, 23, 255]));

  test("周りが背景色に近いときは、これまでどおり背景色で塗る", () => {
    const image = img();
    const { fills } = paintLinesAdaptive(image.data, image.width, image.height, [LINE], "171717");
    expect(fills).toEqual(["171717"]);
    expect(pixelAt(image, 40, 24).slice(0, 3)).toEqual([23, 23, 23]);
  });

  test("周りが背景色と大きく違う帯の上では、周りの色で塗る（黒い四角を残さない）", () => {
    const image = bar();
    const line = { ...LINE, x: 0.2, y: 0.25, w: 0.5, h: 0.1 }; // y 20〜28: 白い帯の中
    const { fills } = paintLinesAdaptive(image.data, image.width, image.height, [line], "171717");
    expect(fills).toEqual(["FAFAFA"]);
    expect(pixelAt(image, 40, 24).slice(0, 3)).toEqual([250, 250, 250]);
    expect(pixelAt(image, 5, 70).slice(0, 3)).toEqual([23, 23, 23]);
  });

  test("文字の色: 塗った色の上で読めるなら指定の色。読めないときは、差が大きいほう", () => {
    expect(pickTextColor("171717", "F2F2F2", "171717")).toBe("F2F2F2");
    expect(pickTextColor("FAFAFA", "F2F2F2", "171717")).toBe("171717");
    expect(pickTextColor("zzz", "F2F2F2", "171717")).toBe("F2F2F2");
  });

  test("スライド全体: 白い帯の上の見出しは、暗い文字色のテキストボックスになる", async () => {
    const src = buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "image1.png", bytes: encodePng(bar()) }] }] });
    const line = { ...LINE, x: 0.2, y: 0.25, w: 0.5, h: 0.1 };
    const { bytes } = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines: [line] }], OPT, testCodec);
    expect(slideOf(bytes)).toContain('<a:srgbClr val="171717"/>');
    const out = decodePng(readParts(bytes)["ppt/media/image1.png"]);
    expect(pixelAt(out, 40, 24).slice(0, 3)).toEqual([250, 250, 250]);
  });
});

// ---------- AIの位置が実際の文字より小さい・ずれているとき ----------
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

test.describe("背の高い式（分数など）", () => {
  test("ほかの行より1.6倍を超えて背が高く、まばらなものだけが、式とみなされる", () => {
    expect(findTallLines([17, 17, 17, 33], [0.5, 0.5, 0.5, 0.2])).toEqual([false, false, false, true]);
    // 白い帯のように密なものは、文字として置き換えられるので、式とみなさない
    expect(findTallLines([17, 17, 17, 33], [0.5, 0.5, 0.5, 0.9])).toEqual([false, false, false, false]);
    // 行が少ないと、比べられない
    expect(findTallLines([17, 33], [0.5, 0.2])).toEqual([false, false]);
  });
});

test.describe("applyTextReplacements（AIの位置が小さいとき）", () => {
  test("元の文字が残らないよう画像から消し、文字の大きさを実際の行に合わせる。背の高い式は残す", async () => {
    // 3行（高さ12）と、背の高いまばらな式（高さ26: x 20〜100 の縞）
    const rows = (x: number, y: number) =>
      stripes(x, y, 20, 8, 120, 20) || stripes(x, y, 20, 28, 120, 40) || stripes(x, y, 20, 48, 120, 60) || (x >= 20 && x < 100 && y >= 68 && y < 94 && x % 4 === 0);
    const image = makeImage(W, Hh, (x, y) => (rows(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const src = buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "image1.png", bytes: encodePng(image) }] }] });
    const small = (y: number) => ({ ...LINE, x: 20 / W, y: (y - 2) / Hh, w: 40 / W, h: 5 / Hh });
    const lines = [small(8), small(28), small(48), { ...small(68), h: 10 / Hh }];
    const { bytes, report } = await applyTextReplacements(src, [{ imagePath: "ppt/media/image1.png", lines }], { textColor: "FFFFFF", backgroundColor: "000000" }, testCodec);
    expect(report).toMatchObject({ lines: 3, skippedLines: 1, snappedLines: 3, tallLines: 1 });
    expect(report.notes.join("\n")).toContain("縦に2段以上");
    // 3行とも、同じ大きさになり、AIの小さい高さ（5）から決めた大きさ（約1.3pt→下限4pt）ではなく、実際の高さから決まる
    const sizes = [...slideOf(bytes).matchAll(/ sz="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeGreaterThan(400);
    // 画像: 3行の文字は消え、背の高い式は残っている
    const out = decodePng(readParts(bytes)["ppt/media/image1.png"]);
    expect(pixelAt(out, 60, 14).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(out, 60, 34).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(out, 40, 54).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(out, 40, 69).slice(0, 3)).toEqual([255, 255, 255]);
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
