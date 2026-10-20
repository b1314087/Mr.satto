import { test, expect } from "@playwright/test";
import { strFromU8 } from "fflate";
import { invertPptx, DEFAULT_PPTX_INVERT_OPTIONS, type PptxInvertResult } from "@/lib/pptx/invert-pptx";
import { PALETTE_PRESETS, contrastRatio, normalizeHex, presetOf, resolvePalette } from "@/lib/pptx/palette";
import { hslToRgb, parseHex, rgbToHsl } from "@/lib/pptx/color";
import { checkXmlWellFormed } from "../helpers/xlsx-strict";
import { bwDocument, bwPhoto, buildPptx, colorPhoto, decodePng, encodePng, mixedDocument, pixelAt, picture, readParts, rect, scheme, srgb, testCodec, transparentBw } from "../helpers/pptx-builder";

/**
 * PowerPoint白黒反転の「配色」（背景色・文字色の指定）のテスト。
 * 既定（純黒×純白）は従来の白黒反転と同じ結果であること、プリセット・自由指定が出力に反映されることを確かめる。
 */

type Colors = { background: string; text: string };
const run = (deck: Uint8Array, colors?: Colors, over: Partial<typeof DEFAULT_PPTX_INVERT_OPTIONS> = {}): Promise<PptxInvertResult> =>
  invertPptx(deck, { ...DEFAULT_PPTX_INVERT_OPTIONS, colors, ...over }, testCodec);
const normalize = (xml: string) => xml.replace(/<a:srgbClr val="([0-9A-Fa-f]{6})"\/>/g, '<a:srgbClr val="$1"></a:srgbClr>');
const part = (r: PptxInvertResult, name: string) => normalize(strFromU8(readParts(r.bytes)[name]));
const slide = (r: PptxInvertResult, n = 1) => part(r, `ppt/slides/slide${n}.xml`);
const hex = (v: number[]) => v.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

const WHITE_BG = `<p:bg><p:bgPr><a:solidFill>${srgb("FFFFFF")}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
const deck = () =>
  buildPptx({
    slides: [
      { shapes: rect(2, { text: "題", textColor: srgb("000000") }) + rect(3, { fill: srgb("808080") }) + rect(4, { fill: srgb("FF0000") }) + rect(5, { fill: scheme("bg1", '<a:lumMod val="95000"/>') }), bg: WHITE_BG },
      { shapes: rect(2, { text: "2枚目", textColor: srgb("000000") }), bg: WHITE_BG },
      { shapes: rect(2, { fill: srgb("FFF2CC") }) },
    ],
  });

test.describe("プリセット", () => {
  test("3つのプリセットが、指定の色であること（初期選択は純黒×純白）", () => {
    expect(PALETTE_PRESETS.map((p) => [p.id, p.name, p.background, p.text])).toEqual([
      ["pure", "純黒 × 純白", "000000", "FFFFFF"],
      ["dark-gray", "ダークグレー × 薄い白", "171717", "F2F2F2"],
      ["charcoal", "チャコール × 暖色系の白", "262626", "FFF4E5"],
    ]);
    expect(presetOf({ background: "000000", text: "FFFFFF" })?.id).toBe("pure");
    expect(presetOf({ background: "#171717", text: "f2f2f2" })?.id).toBe("dark-gray");
    expect(presetOf({ background: "123456", text: "FFFFFF" })).toBeNull();
  });

  for (const p of PALETTE_PRESETS) {
    test(`${p.name}: 白い背景は背景色に、黒い文字は文字色になり、赤はそのまま`, async () => {
      const r = await run(deck(), { background: p.background, text: p.text });
      const xml = slide(r);
      expect(xml).toContain(`<p:bgPr><a:solidFill><a:srgbClr val="${p.background}"></a:srgbClr>`);
      expect(xml).toContain(`<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="${p.text}">`);
      expect(xml).toContain('<a:srgbClr val="FF0000">');
      expect(r.report.colorChoice).toEqual({ background: p.background, text: p.text });
    });
  }

  test("灰色は、背景色と文字色の間の色になる（ダークグレー×薄い白・チャコール×暖色系の白）", async () => {
    // 808080 を反転した 7F7F7F（127/255）を、背景色〜文字色の間に写した色
    const dark = slide(await run(deck(), { background: "171717", text: "F2F2F2" }));
    expect(dark).toContain('<a:srgbClr val="848484">');
    const warm = slide(await run(deck(), { background: "262626", text: "FFF4E5" }));
    expect(warm).toContain('<a:srgbClr val="928D85">');
  });

  test("テーマ色の参照（背景1の95%）も、配色に写る", async () => {
    // F2F2F2 を反転した 0D0D0D（13/255）を 171717〜F2F2F2 の間に写す: 23 + (242-23) × 13/255 ≒ 34 = 0x22
    const xml = slide(await run(deck(), { background: "171717", text: "F2F2F2" }));
    expect(xml).toContain('<a:srgbClr val="222222">');
  });
});

test.describe("自由指定", () => {
  test("指定した背景色・文字色が、全スライドの出力に反映される", async () => {
    const r = await run(deck(), { background: "1A2B4C", text: "FFE08A" });
    for (const n of [1, 2]) {
      const xml = slide(r, n);
      expect(xml).toContain('<p:bgPr><a:solidFill><a:srgbClr val="1A2B4C"></a:srgbClr>');
      expect(xml).toContain('<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="FFE08A">');
    }
    expect(r.report.colorChoice).toEqual({ background: "1A2B4C", text: "FFE08A" });
    expect(r.report.notes.join("\n")).toContain("配色を指定した場合");
  });

  test("小文字・# つきの指定でも正しく処理される。背景より文字のほうが暗い配色（逆）も指定できる", async () => {
    const r = await run(deck(), { background: "#f5f5f5", text: "#222222" });
    expect(slide(r)).toContain('<p:bgPr><a:solidFill><a:srgbClr val="F5F5F5"></a:srgbClr>');
    expect(slide(r)).toContain('<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="222222">');
  });

  test("薄い色つきの塗り（淡い黄色）は、色合いを保ったまま、配色の明るさの範囲に収まる", async () => {
    const r = await run(deck(), { background: "171717", text: "F2F2F2" });
    const m = /<a:srgbClr val="([0-9A-F]{6})">/.exec(slide(r, 3));
    expect(m).not.toBeNull();
    const out = rgbToHsl(parseHex(m![1])!);
    const src = rgbToHsl(parseHex("FFF2CC")!);
    expect(Math.abs(out.h - src.h)).toBeLessThan(2); // 色相は保つ
    expect(out.l).toBeGreaterThan(rgbToHsl(parseHex("171717")!).l);
    expect(out.l).toBeLessThan(0.5); // 淡い色は、暗い側（背景寄り）になる
    void hslToRgb;
  });
});

test.describe("設定を変更しない場合は従来の白黒反転と同じ", () => {
  const sameParts = (a: PptxInvertResult, b: PptxInvertResult) => {
    const pa = readParts(a.bytes);
    const pb = readParts(b.bytes);
    expect(Object.keys(pa)).toEqual(Object.keys(pb));
    for (const k of Object.keys(pa)) expect(Buffer.from(pa[k]).equals(Buffer.from(pb[k])), k).toBe(true);
  };
  const withImages = () =>
    buildPptx({
      slides: [
        {
          shapes: rect(2, { text: "題", textColor: srgb("000000") }) + picture(3, "rId2") + picture(4, "rId3") + picture(5, "rId4"),
          bg: WHITE_BG,
          images: [
            { name: "a.png", bytes: encodePng(bwDocument()) },
            { name: "b.png", bytes: encodePng(mixedDocument()) },
            { name: "c.png", bytes: encodePng(colorPhoto()) },
          ],
        },
      ],
    });

  test("色の指定なし／純黒×純白の指定／既定のオプションは、すべて同じ出力（バイト単位）", async () => {
    const base = await run(withImages(), undefined);
    sameParts(base, await run(withImages(), { background: "000000", text: "FFFFFF" }));
    sameParts(base, await run(withImages(), { background: "#000000", text: "#ffffff" }));
    sameParts(base, await invertPptx(withImages(), { invertImages: true, brightenDarkText: false }, testCodec));
    expect(base.report.notes.join("\n")).not.toContain("配色を指定した場合");
    expect(base.report.colorChoice).toEqual({ background: "000000", text: "FFFFFF" });
  });

  test("従来の結果（背景は000000、文字はFFFFFF、灰色は反転）が保たれる", async () => {
    const r = await run(deck());
    const xml = slide(r);
    expect(xml).toContain('<p:bgPr><a:solidFill><a:srgbClr val="000000"></a:srgbClr>');
    expect(xml).toContain('<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="FFFFFF">');
    expect(xml).toContain('<a:srgbClr val="7F7F7F">');
    expect(xml).toContain('<a:srgbClr val="0D0D0D">');
  });

  test("正しくない色の指定は、純黒×純白で変換し、画面で知らせる", async () => {
    const base = await run(deck());
    const bad = await run(deck(), { background: "zzzzzz", text: "FFF" });
    sameParts(base, bad);
    expect(bad.report.notes.join("\n")).toContain("読み取れなかった");
    expect(resolvePalette({ background: "12", text: "34" }).invalid).toBe(true);
  });
});

test.describe("画像", () => {
  const withImage = (img: Uint8Array) => buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "image1.png", bytes: img }] }] });
  const outImage = (r: PptxInvertResult) => decodePng(readParts(r.bytes)["ppt/media/image1.png"]);
  const colors = { background: "262626", text: "FFF4E5" };

  test("グレースケール画像は反転し、白は背景色、黒は文字色、灰色はその間になる（大きさ・透明度は同じ）", async () => {
    const src = bwDocument();
    const r = await run(withImage(encodePng(src)), colors);
    const out = outImage(r);
    expect([out.width, out.height]).toEqual([src.width, src.height]);
    expect(r.report.images[0].outcome).toBe("inverted");
    expect(hex(pixelAt(out, 1, 10).slice(0, 3))).toBe("262626"); // 白 → 背景色
    expect(hex(pixelAt(out, 0, 7).slice(0, 3))).toBe("FFF4E5"); // 黒 → 文字色
    expect(hex(pixelAt(out, 0, 0).slice(0, 3))).toBe("928D85"); // 灰色 128 → 間の色
    expect(pixelAt(out, 1, 10)[3]).toBe(255);
  });

  test("透明な白黒画像は、透明度（アルファ）を保つ", async () => {
    const src = transparentBw();
    const out = outImage(await run(withImage(encodePng(src)), colors));
    for (const [x, y] of [[0, 0], [12, 3], [12, 20], [39, 29]]) expect(pixelAt(out, x, y)[3]).toBe(pixelAt(src, x, y)[3]);
    expect(hex(pixelAt(out, 12, 3).slice(0, 3))).toBe("FFF4E5");
  });

  test("白黒が中心の画像は、白黒の部分だけが配色になり、色のついた部分は残る", async () => {
    const out = outImage(await run(withImage(encodePng(mixedDocument())), colors));
    expect(pixelAt(out, 2, 2)).toEqual([220, 30, 30, 255]);
    expect(hex(pixelAt(out, 21, 20).slice(0, 3))).toBe("262626");
  });

  test("カラー写真は、配色を変えてもバイト単位で変わらない", async () => {
    const bytes = encodePng(colorPhoto());
    for (const c of [colors, { background: "1A2B4C", text: "FFE08A" }]) {
      const r = await run(withImage(bytes), c);
      expect(r.report.images[0].outcome).toBe("kept-color");
      expect(Buffer.from(readParts(r.bytes)["ppt/media/image1.png"]).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  test("白黒写真の階調は、背景色から文字色へなめらかにつながる", async () => {
    const out = outImage(await run(withImage(encodePng(bwPhoto())), colors));
    expect(hex(pixelAt(out, 39, 0).slice(0, 3))).toBe("262626"); // 白(255) → 背景色
    expect(hex(pixelAt(out, 0, 0).slice(0, 3))).toBe("FFF4E5"); // 黒(0) → 文字色
    const mid = pixelAt(out, 20, 0);
    expect(mid[0]).toBeGreaterThan(0x26);
    expect(mid[0]).toBeLessThan(0xff);
  });

  test("画像の反転をオフにすると、配色を選んでいても画像は変わらない", async () => {
    const bytes = encodePng(bwDocument());
    const r = await run(withImage(bytes), colors, { invertImages: false });
    expect(r.report.images[0].outcome).toBe("skipped-option");
    expect(Buffer.from(readParts(r.bytes)["ppt/media/image1.png"]).equals(Buffer.from(bytes))).toBe(true);
  });
});

test.describe("構造", () => {
  test("配色を指定しても、複数スライドの枚数・順序・ファイル一覧は変わらず、XMLはすべて正しい。入力は書き換えない", async () => {
    const input = deck();
    const copy = input.slice();
    const before = readParts(input);
    const r = await run(input, { background: "262626", text: "FFF4E5" });
    const after = readParts(r.bytes);
    expect(Buffer.from(input).equals(Buffer.from(copy))).toBe(true);
    expect(r.report.slideCount).toBe(3);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const n of ["ppt/presentation.xml", "[Content_Types].xml", "ppt/theme/theme1.xml", "ppt/slideLayouts/slideLayout1.xml"]) {
      expect(Buffer.from(after[n]).equals(Buffer.from(before[n])), n).toBe(true);
    }
    const problems: string[] = [];
    for (const [name, bytes] of Object.entries(after)) if (/\.(xml|rels)$/.test(name)) problems.push(...checkXmlWellFormed(strFromU8(bytes), name));
    expect(problems).toEqual([]);
    // 色の対応表（背景1/文字1…）の入れ替えは、配色を指定しても同じ
    expect(part(r, "ppt/slideMasters/slideMaster1.xml")).toContain('bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"');
  });

  test("影・色つきの図形の上の白い文字は、配色を指定しても従来どおり（そのまま）", async () => {
    const shadow = `<a:effectLst><a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>`;
    const r = await run(buildPptx({ slides: [{ shapes: rect(2, { fill: srgb("FFFFFF"), extraSpPr: shadow }) }] }), { background: "262626", text: "FFF4E5" });
    expect(slide(r)).toContain(`<a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw>`);
  });
});

test.describe("入力の検査・補助関数", () => {
  test("normalizeHex: 6桁の16進だけを受け付け、大文字の RRGGBB にそろえる", () => {
    expect(normalizeHex("#ffe08a")).toBe("FFE08A");
    expect(normalizeHex("171717")).toBe("171717");
    for (const bad of ["", "#fff", "12345", "1234567", "gggggg", null, undefined]) expect(normalizeHex(bad as string)).toBeNull();
  });

  test("contrastRatio: 黒と白は21、同じ色は1", () => {
    expect(contrastRatio("000000", "FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("777777", "777777")).toBeCloseTo(1, 5);
    expect(contrastRatio("zz", "FFFFFF")).toBeNull();
  });
});
