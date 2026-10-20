/**
 * PowerPoint白黒反転のテスト用ヘルパー。
 *  - 最小限の .pptx（スライドマスター・レイアウト・テーマ・スライド・画像）を fflate で組み立てる
 *  - PNG の書き出し・読み込み（fflate の zlib を使う）と、それを使ったテスト用の画像コーデック
 * 実装（src/lib/pptx）とは別に、結果を確かめるために使う。新しい依存は追加しない。
 */
import { strToU8, unzipSync, unzlibSync, zipSync, zlibSync, type Zippable } from "fflate";
import type { ImageCodec, RasterImage } from "@/lib/pptx/image-invert";

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA（1画素4バイト）から PNG を作る */
export function encodePng(image: RasterImage): Uint8Array {
  const { width, height, data } = image;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** このヘルパーで書いた PNG（RGBA・フィルタなし）を読む */
export function decodePng(bytes: Uint8Array): RasterImage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset).getUint32(0);
      height = new DataView(body.buffer, body.byteOffset).getUint32(4);
      if (body[8] !== 8 || body[9] !== 6) throw new Error("テスト用PNGではありません");
    } else if (type === "IDAT") idat.push(body);
    off += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of idat) {
    joined.set(p, o);
    o += p.length;
  }
  const raw = unzlibSync(joined);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width * 4 + 1)] !== 0) throw new Error("フィルタ付きPNGは読めません");
    data.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, data };
}

/** テスト用の画像コーデック（PNGだけ。JPEGは扱わない） */
export const testCodec: ImageCodec = {
  async decode(bytes, kind) {
    if (kind !== "png") throw new Error("テスト用コーデックはPNGだけ");
    return decodePng(bytes);
  },
  async encode(image) {
    return encodePng(image);
  },
};

export type Rgba = [number, number, number, number];
/** 関数で画素を決めた画像 */
export function makeImage(width: number, height: number, pixel: (x: number, y: number) => Rgba): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}
export const pixelAt = (img: RasterImage, x: number, y: number): Rgba => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

// ---------- 代表的な画像 ----------
/** 白地に黒い文字のような、白黒の文書画像（左上に灰色の帯） */
export const bwDocument = () => makeImage(40, 30, (x, y) => (y < 6 ? [128, 128, 128, 255] : (x + y) % 7 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
/** 白黒写真（灰色の階調） */
export const bwPhoto = () => makeImage(40, 30, (x) => { const v = Math.round((x / 39) * 255); return [v, v, v, 255]; });
/** カラー写真（色相が変化する） */
export const colorPhoto = () => makeImage(40, 30, (x, y) => [Math.round((x / 39) * 255), Math.round((y / 29) * 255), 120, 255]);
/** 透明な背景に黒い図（アルファ付きの白黒） */
export const transparentBw = () => makeImage(40, 30, (x, y) => (x < 10 ? [0, 0, 0, 0] : y < 15 ? [0, 0, 0, 255] : [0, 0, 0, 90]));
/** 白地の文書に、赤い図が少し混ざった画像（白黒が中心） */
export const mixedDocument = () => makeImage(40, 30, (x, y) => (x < 8 && y < 8 ? [220, 30, 30, 255] : (x + y) % 5 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));

// ---------- pptx ----------
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

export const MASTER_XML = (clrMap = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"', bg = '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS}><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap ${clrMap}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

export const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS} type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

export interface SlideSpec {
  /** <p:spTree> の中身（図形など） */
  shapes: string;
  /** 背景（<p:bg>…</p:bg>）。省略するとマスターの背景 */
  bg?: string;
  /** スライドで使う画像（rId はスライド内の連番 rId2〜） */
  images?: { name: string; bytes: Uint8Array }[];
  /** 発表者ノートの本文XML（<p:notesSlide>）を付ける */
  notesXml?: string;
  /** <p:timing> のXML */
  timing?: string;
}

export interface PptxSpec {
  slides: SlideSpec[];
  masterXml?: string;
  extra?: Record<string, Uint8Array | string>;
}

export function slideXml(s: SlideSpec): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS}><p:cSld>${s.bg ?? ""}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${s.shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${s.timing ?? ""}</p:sld>`;
}

/** 矩形（塗り・枠線・文字の色をXMLで指定できる） */
export function rect(id: number, opts: { fill?: string; line?: string; text?: string; textColor?: string; extraSpPr?: string; rPrExtra?: string } = {}): string {
  const fill = opts.fill ? `<a:solidFill>${opts.fill}</a:solidFill>` : "";
  const ln = opts.line ? `<a:ln w="12700"><a:solidFill>${opts.line}</a:solidFill></a:ln>` : "";
  const color = opts.textColor ? `<a:solidFill>${opts.textColor}</a:solidFill>` : "";
  const text = opts.text
    ? `<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ja-JP" sz="2400">${color}${opts.rPrExtra ?? ""}</a:rPr><a:t>${opts.text}</a:t></a:r></a:p></p:txBody>`
    : `<p:txBody><a:bodyPr/><a:p><a:endParaRPr lang="ja-JP"/></a:p></p:txBody>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="${id * 457200}"/><a:ext cx="3657600" cy="365760"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}${ln}${opts.extraSpPr ?? ""}</p:spPr>${text}</p:sp>`;
}

export function picture(id: number, rId: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:srcRect l="5000" t="5000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="${id * 457200}"/><a:ext cx="1828800" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

export const srgb = (hex: string, inner = "") => `<a:srgbClr val="${hex}">${inner}</a:srgbClr>`;
export const scheme = (val: string, inner = "") => `<a:schemeClr val="${val}">${inner}</a:schemeClr>`;

export function buildPptx(spec: PptxSpec): Uint8Array {
  const files: Record<string, Uint8Array | string> = {};
  files["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${spec.slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("")}</Types>`;
  files["_rels/.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  files["ppt/presentation.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${spec.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  files["ppt/_rels/presentation.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${spec.slides
    .map((_, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join("")}</Relationships>`;
  files["ppt/slideMasters/slideMaster1.xml"] = spec.masterXml ?? MASTER_XML();
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`;
  files["ppt/slideLayouts/slideLayout1.xml"] = LAYOUT_XML;
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  files["ppt/theme/theme1.xml"] = THEME_XML;
  spec.slides.forEach((s, i) => {
    const k = i + 1;
    files[`ppt/slides/slide${k}.xml`] = slideXml(s);
    const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    (s.images ?? []).forEach((img, j) => {
      rels.push(`<Relationship Id="rId${j + 2}" Type="${REL}/image" Target="../media/${img.name}"/>`);
      files[`ppt/media/${img.name}`] = img.bytes;
    });
    if (s.notesXml) {
      rels.push(`<Relationship Id="rId90" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${k}.xml"/>`);
      files[`ppt/notesSlides/notesSlide${k}.xml`] = s.notesXml;
    }
    files[`ppt/slides/_rels/slide${k}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
  });
  for (const [k, v] of Object.entries(spec.extra ?? {})) files[k] = v;
  const z: Zippable = {};
  for (const [k, v] of Object.entries(files)) z[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(z, { level: 6 });
}

/** 変換後の .pptx から、部品の文字列を取り出す */
export function readParts(pptx: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(pptx);
}
