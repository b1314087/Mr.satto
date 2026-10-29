import { test, expect } from "@playwright/test";
import { strFromU8 } from "fflate";
import { applyTextReplacements, buildTextBoxXml, estimateTextEm, lineFontPt, paintLines, paintLinesAdaptive, pickTextColor, scanSlidePictures, unifyFontSizes, type SlidePicture } from "@/lib/pptx/text-replace";
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
