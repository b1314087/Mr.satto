import { test, expect } from "@playwright/test";
import { strFromU8, strToU8, zipSync } from "fflate";
import { invertPptx, PptxInvertError, DEFAULT_PPTX_INVERT_OPTIONS, type PptxInvertResult } from "@/lib/pptx/invert-pptx";
import { checkXmlWellFormed } from "../helpers/xlsx-strict";
import {
  bwDocument, bwPhoto, buildPptx, colorPhoto, decodePng, encodePng, mixedDocument, pixelAt, picture, readParts, rect, scheme, srgb, testCodec, transparentBw, MASTER_XML,
  type SlideSpec,
} from "../helpers/pptx-builder";

/**
 * PowerPoint白黒反転（src/lib/pptx）のテスト。
 * Node 上で、実装とは別に組み立てた .pptx を変換し、変換後の XML・画像を直接調べる。
 */

const run = (deck: Uint8Array, over: Partial<typeof DEFAULT_PPTX_INVERT_OPTIONS> = {}): Promise<PptxInvertResult> =>
  invertPptx(deck, { ...DEFAULT_PPTX_INVERT_OPTIONS, ...over }, testCodec);
// 実装は <a:srgbClr val="…"/> と書くことがあるため、比べやすいよう <a:srgbClr val="…"></a:srgbClr> の形にそろえる
const normalize = (xml: string) => xml.replace(/<a:srgbClr val="([0-9A-Fa-f]{6})"\/>/g, '<a:srgbClr val="$1"></a:srgbClr>');
const text = (r: PptxInvertResult, name: string): string => normalize(strFromU8(readParts(r.bytes)[name]));
const slide1 = (r: PptxInvertResult) => text(r, "ppt/slides/slide1.xml");
const oneSlide = (shapes: string, extra: Partial<SlideSpec> = {}) => buildPptx({ slides: [{ shapes, ...extra }] });

test.describe("色の反転（XML）", () => {
  test("白い背景は黒に、黒い文字は白になる", async () => {
    const r = await run(oneSlide(rect(2, { text: "題", textColor: srgb("000000") }), { bg: `<p:bg><p:bgPr><a:solidFill>${srgb("FFFFFF")}</a:solidFill><a:effectLst/></p:bgPr></p:bg>` }));
    const xml = slide1(r);
    expect(xml).toContain(`<a:srgbClr val="000000"></a:srgbClr></a:solidFill><a:effectLst/>`);
    expect(xml).toContain(`<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="FFFFFF">`);
    expect(r.report.colors.inverted).toBeGreaterThanOrEqual(2);
  });

  test("マスターの色の対応表（背景1/文字1/背景2/文字2）が入れ替わり、指定のない文字・背景も反転する", async () => {
    const r = await run(oneSlide(rect(2, { text: "既定の文字色" })));
    const master = text(r, "ppt/slideMasters/slideMaster1.xml");
    expect(master).toContain('bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"');
    expect(master).toContain('accent1="accent1"'); // アクセント色の対応は変えない
    expect(r.report.colorMapsSwapped).toBeGreaterThanOrEqual(1);
  });

  test("灰色は明るさを入れ替え、色のついた色（赤・青）はそのまま", async () => {
    const r = await run(
      oneSlide(
        rect(2, { fill: srgb("808080") }) + rect(3, { fill: srgb("333333") }) + rect(4, { fill: srgb("F2F2F2") }) + rect(5, { fill: srgb("FF0000") }) + rect(6, { fill: srgb("0000FF") }) + rect(7, { fill: srgb("C0504D") }),
      ),
    );
    const xml = slide1(r);
    expect(xml).toContain('<a:srgbClr val="7F7F7F">');
    expect(xml).toContain('<a:srgbClr val="CCCCCC">');
    expect(xml).toContain('<a:srgbClr val="0D0D0D">');
    for (const keep of ["FF0000", "0000FF", "C0504D"]) expect(xml).toContain(`<a:srgbClr val="${keep}">`);
    expect(r.report.colors.kept).toBeGreaterThanOrEqual(3);
  });

  test("テーマの色の参照（白=bg1、黒=tx1、変形つき）も反転する。赤などのアクセント色の参照は、そのまま", async () => {
    const r = await run(
      oneSlide(rect(2, { fill: scheme("bg1", '<a:lumMod val="95000"/>') }) + rect(3, { fill: scheme("tx1") }) + rect(4, { fill: scheme("accent2") }) + rect(5, { fill: scheme("tx1", '<a:lumMod val="50000"/><a:lumOff val="50000"/>') })),
    );
    const xml = slide1(r);
    expect(xml).toContain('<a:srgbClr val="0D0D0D">'); // F2F2F2 → 0D0D0D
    expect(xml).toContain('<a:srgbClr val="FFFFFF">'); // 黒 → 白
    expect(xml).toContain('<a:schemeClr val="accent2">'); // アクセント色は参照のまま
    expect(xml).toContain('<a:srgbClr val="7F7F7F">'); // 50%灰色 7F7F7F（黒+50%）は反転しても同じ付近（80→7F）
    expect(xml).not.toContain('val="bg1"');
  });

  test("影は反転しない。色つき図形の上の白い文字（fontRef の lt1）もそのまま", async () => {
    const shadow = `<a:effectLst><a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>`;
    const withFontRef = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill>${srgb("C0504D")}</a:solidFill></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style></p:sp>`;
    const r = await run(oneSlide(rect(2, { fill: srgb("FFFFFF"), extraSpPr: shadow }) + withFontRef));
    const xml = slide1(r);
    expect(xml).toContain(`<a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw>`);
    expect(xml).toContain(`<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>`);
  });

  test("透明度（alpha）など色の子要素は残る", async () => {
    const r = await run(oneSlide(rect(2, { fill: srgb("FFFFFF", '<a:alpha val="50000"/>') })));
    expect(slide1(r)).toContain('<a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr>');
  });

  test("グラデーションの各色も反転する", async () => {
    const grad = `<a:gradFill><a:gsLst><a:gs pos="0">${srgb("FFFFFF")}</a:gs><a:gs pos="100000">${srgb("D9D9D9")}</a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>`;
    const shape = rect(2).replace("</p:spPr>", `${grad}</p:spPr>`);
    const r = await run(oneSlide(shape));
    const xml = slide1(r);
    expect(xml).toContain('<a:gs pos="0"><a:srgbClr val="000000">');
    expect(xml).toContain('<a:gs pos="100000"><a:srgbClr val="262626">');
  });

  test("表のセルの塗り・枠線の色も反転する", async () => {
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="100"/></a:tblGrid><a:tr h="100"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ja-JP"><a:solidFill>${srgb("000000")}</a:solidFill></a:rPr><a:t>表</a:t></a:r></a:p></a:txBody><a:tcPr><a:lnB w="12700"><a:solidFill>${srgb("000000")}</a:solidFill></a:lnB><a:solidFill>${srgb("FFFFFF")}</a:solidFill></a:tcPr></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const r = await run(oneSlide(table));
    const xml = slide1(r);
    expect(xml).toContain('<a:lnB w="12700"><a:solidFill><a:srgbClr val="FFFFFF">');
    expect(xml).toContain('<a:tcPr><a:lnB w="12700"><a:solidFill><a:srgbClr val="FFFFFF"></a:srgbClr></a:solidFill></a:lnB><a:solidFill><a:srgbClr val="000000">');
  });

  test("スライド側の色の対応表の上書き（暗いスライド）も入れ替わる", async () => {
    const deck = buildPptx({ slides: [{ shapes: rect(2, { text: "x" }) }] });
    const parts = readParts(deck);
    const slide = strFromU8(parts["ppt/slides/slide1.xml"]).replace("<a:masterClrMapping/>", '<a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>');
    parts["ppt/slides/slide1.xml"] = strToU8(slide);
    const r = await run(zipSync(parts));
    expect(slide1(r)).toContain('<a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"');
  });

  test("「濃い文字を明るくする」をオンにすると、紺色の文字だけ明るくなる（既定はオフで色を変えない）", async () => {
    const deck = oneSlide(rect(2, { text: "紺", textColor: srgb("1F497D") }) + rect(3, { fill: srgb("1F497D") }));
    const off = slide1(await run(deck));
    expect(off).toContain('<a:srgbClr val="1F497D">');
    const on = slide1(await run(deck, { brightenDarkText: true }));
    expect(on).not.toContain('<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="1F497D">');
    expect(on.match(/<a:solidFill><a:srgbClr val="1F497D">/g)?.length).toBe(1); // 図形の塗りは対象外（そのまま）
  });

  test("反転を2回行うと、白黒の色は元に戻る", async () => {
    const deck = oneSlide(rect(2, { fill: srgb("FFFFFF"), line: srgb("000000"), text: "A", textColor: srgb("000000") }), { bg: `<p:bg><p:bgPr><a:solidFill>${srgb("FFFFFF")}</a:solidFill><a:effectLst/></p:bgPr></p:bg>` });
    const once = await run(deck);
    const twice = await run(once.bytes);
    expect(slide1(twice)).toBe(strFromU8(readParts(deck)["ppt/slides/slide1.xml"]));
    // マスターの背景は「テーマの背景1への参照」から「白の指定」に置き換わる（見た目は元と同じ白）。色の対応表は元に戻る
    const master = text(twice, "ppt/slideMasters/slideMaster1.xml");
    expect(master).toContain('<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"');
    expect(master).toContain('<p:bgRef idx="1001"><a:srgbClr val="FFFFFF"></a:srgbClr></p:bgRef>');
  });
});

test.describe("構造・影響範囲", () => {
  const deck = () =>
    buildPptx({
      slides: [
        { shapes: rect(2, { text: "1枚目", textColor: srgb("000000") }) },
        { shapes: rect(2, { text: "2枚目" }) + picture(3, "rId2"), images: [{ name: "image1.png", bytes: encodePng(bwDocument()) }], notesXml: '<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="000000"/></p:notes>', timing: "<p:timing><p:tnLst/></p:timing>" },
        { shapes: rect(2, { text: "3枚目", fill: srgb("FFFFFF") }) },
      ],
    });

  test("複数スライド: 枚数・順序・ファイル一覧は変わらず、すべてのXMLが正しい", async () => {
    const input = deck();
    const before = readParts(input);
    const r = await run(input);
    const after = readParts(r.bytes);
    expect(r.report.slideCount).toBe(3);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(strFromU8(after["ppt/presentation.xml"])).toBe(strFromU8(before["ppt/presentation.xml"]));
    expect(strFromU8(after["[Content_Types].xml"])).toBe(strFromU8(before["[Content_Types].xml"]));
    const problems: string[] = [];
    for (const [name, bytes] of Object.entries(after)) if (/\.(xml|rels)$/.test(name)) problems.push(...checkXmlWellFormed(strFromU8(bytes), name));
    expect(problems).toEqual([]);
    // 色を指定したスライドは書き換わっている
    for (const n of [1, 3]) expect(strFromU8(after[`ppt/slides/slide${n}.xml`])).not.toBe(strFromU8(before[`ppt/slides/slide${n}.xml`]));
  });

  test("テーマ・発表者ノート・レイアウトの位置情報などは、バイト単位で変わらない。入力は書き換えない", async () => {
    const input = deck();
    const copy = input.slice();
    const before = readParts(input);
    const r = await run(input);
    const after = readParts(r.bytes);
    expect(Buffer.from(input).equals(Buffer.from(copy))).toBe(true);
    for (const n of ["ppt/theme/theme1.xml", "ppt/notesSlides/notesSlide2.xml", "_rels/.rels", "ppt/slides/_rels/slide2.xml.rels", "ppt/slideLayouts/slideLayout1.xml"]) {
      expect(Buffer.from(after[n]).equals(Buffer.from(before[n])), n).toBe(true);
    }
  });

  test("レポートに、発表者ノート・アニメーションの説明が出る", async () => {
    const r = await run(deck());
    expect(r.report.notes.join("\n")).toContain("発表者ノート");
    expect(r.report.notes.join("\n")).toContain("アニメーション");
    expect(r.report.notes.join("\n")).toContain("テーマの色");
  });

  test("ノートだけで使われている画像・GIF・SVGは変更せず、画面で知らせる", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
    const notesImg = encodePng(bwDocument());
    const parts = readParts(
      buildPptx({
        slides: [{ shapes: picture(3, "rId2") + picture(4, "rId3"), images: [{ name: "anim.gif", bytes: gif }, { name: "logo.svg", bytes: strToU8("<svg xmlns='http://www.w3.org/2000/svg'/>") }] }],
        extra: { "ppt/media/noteonly.png": notesImg, "ppt/notesSlides/_rels/notesSlide1.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/noteonly.png"/></Relationships>`, "ppt/notesSlides/notesSlide1.xml": "<p:notes xmlns:p='x'/>" },
      }),
    );
    const r = await run(zipSync(parts));
    const after = readParts(r.bytes);
    for (const n of ["ppt/media/anim.gif", "ppt/media/logo.svg", "ppt/media/noteonly.png"]) expect(Buffer.from(after[n]).equals(Buffer.from(parts[n])), n).toBe(true);
    expect(r.report.images.map((i) => [i.path.split("/").pop(), i.outcome])).toEqual([["anim.gif", "unsupported"], ["logo.svg", "unsupported"]]);
    expect(r.report.notes.join("\n")).toContain("GIF・SVG・EMF・WMF");
  });

  test("プレビュー用のサムネイルは変更せず、そのことを知らせる", async () => {
    const parts = readParts(deck());
    const thumb = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    parts["docProps/thumbnail.jpeg"] = thumb;
    const r = await run(zipSync(parts));
    expect(Buffer.from(readParts(r.bytes)["docProps/thumbnail.jpeg"]).equals(Buffer.from(thumb))).toBe(true);
    expect(r.report.notes.join("\n")).toContain("サムネイル");
  });

  test("デジタル署名がある場合は、無効になることを知らせる", async () => {
    const parts = readParts(deck());
    parts["_xmlsignatures/sig1.xml"] = strToU8("<Signature/>");
    const r = await run(zipSync(parts));
    expect(r.report.notes.join("\n")).toContain("デジタル署名");
  });
});

test.describe("画像の判定と反転", () => {
  const withImage = (img: Uint8Array) => buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "image1.png", bytes: img }] }] });
  const outImage = (r: PptxInvertResult) => decodePng(readParts(r.bytes)["ppt/media/image1.png"]);

  test("白黒の文書画像は反転する（透明度・大きさは変えない）", async () => {
    const src = bwDocument();
    const r = await run(withImage(encodePng(src)));
    const out = outImage(r);
    expect([out.width, out.height]).toEqual([src.width, src.height]);
    expect(pixelAt(out, 0, 0)).toEqual([127, 127, 127, 255]); // 灰色の帯 128 → 127
    expect(pixelAt(src, 1, 10)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(out, 1, 10)).toEqual([0, 0, 0, 255]); // 白 → 黒
    expect(pixelAt(src, 0, 7)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(out, 0, 7)).toEqual([255, 255, 255, 255]);
    expect(r.report.images[0].outcome).toBe("inverted");
  });

  test("白黒写真は反転する", async () => {
    const r = await run(withImage(encodePng(bwPhoto())));
    expect(r.report.images[0].outcome).toBe("inverted");
    expect(pixelAt(outImage(r), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(outImage(r), 39, 0)).toEqual([0, 0, 0, 255]);
  });

  test("カラー写真は、バイト単位でそのまま", async () => {
    const bytes = encodePng(colorPhoto());
    const r = await run(withImage(bytes));
    expect(r.report.images[0].outcome).toBe("kept-color");
    expect(Buffer.from(readParts(r.bytes)["ppt/media/image1.png"]).equals(Buffer.from(bytes))).toBe(true);
  });

  test("透明な背景つきの白黒画像は反転し、透明度（アルファ）は完全に保つ", async () => {
    const src = transparentBw();
    const r = await run(withImage(encodePng(src)));
    const out = outImage(r);
    expect(r.report.images[0].outcome).toBe("inverted");
    for (const [x, y] of [[0, 0], [12, 3], [12, 20], [39, 29]]) {
      expect(pixelAt(out, x, y)[3]).toBe(pixelAt(src, x, y)[3]);
    }
    expect(pixelAt(out, 12, 3)).toEqual([255, 255, 255, 255]);
  });

  test("白黒が中心で一部だけカラーの文書画像は、白黒の部分だけ反転し、色のついた部分は残す", async () => {
    const src = mixedDocument();
    const r = await run(withImage(encodePng(src)));
    const out = outImage(r);
    expect(r.report.images[0].outcome).toBe("inverted-gray");
    expect(pixelAt(out, 2, 2)).toEqual([220, 30, 30, 255]); // 赤い図はそのまま
    expect(pixelAt(src, 21, 20)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(out, 21, 20)).toEqual([0, 0, 0, 255]);
  });

  test("画像の反転をオフにすると、画像は変更しない（色の変換は行う）", async () => {
    const bytes = encodePng(bwDocument());
    const r = await run(withImage(bytes), { invertImages: false });
    expect(r.report.images[0].outcome).toBe("skipped-option");
    expect(Buffer.from(readParts(r.bytes)["ppt/media/image1.png"]).equals(Buffer.from(bytes))).toBe(true);
  });

  test("拡張子がpngでも中身がPNG・JPEGでなければ変更しない。壊れた画像でも全体は止まらない", async () => {
    const broken = encodePng(bwDocument()).slice(0, 40); // PNGの途中で切れている
    const r = await run(withImage(broken));
    expect(r.report.images[0].outcome).toBe("failed");
    expect(Buffer.from(readParts(r.bytes)["ppt/media/image1.png"]).equals(Buffer.from(broken))).toBe(true);
    expect(r.report.notes.join("\n")).toContain("読み込めない");
  });
});

test.describe("入力の検査", () => {
  test("PNG・ZIPではないファイル、空ファイル、古い形式・パスワード付き、PowerPointではないZIPは、わかりやすく断る", async () => {
    await expect(run(new Uint8Array(0))).rejects.toThrow(PptxInvertError);
    await expect(run(strToU8("これはテキストです"))).rejects.toThrow(/読み込めませんでした/);
    await expect(run(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).rejects.toThrow(/パスワード/);
    await expect(run(zipSync({ "a.txt": strToU8("x") }))).rejects.toThrow(/PowerPointファイル/);
    const truncated = buildPptx({ slides: [{ shapes: rect(2) }] }).slice(0, 200);
    await expect(run(truncated)).rejects.toThrow(PptxInvertError);
  });
});

test.describe("色の対応表が特殊なマスター", () => {
  test("すでに暗い配色のマスター（背景1=dk1）は、明るい配色に入れ替わる", async () => {
    const deck = buildPptx({ slides: [{ shapes: rect(2, { text: "x" }) }], masterXml: MASTER_XML('bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"') });
    const r = await run(deck);
    expect(text(r, "ppt/slideMasters/slideMaster1.xml")).toContain('bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"');
  });
});
