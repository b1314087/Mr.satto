/**
 * PowerPoint白黒反転の、「画像の中の文字を、本物の文字（テキストボックス）に置き換える」処理（Mr.Satto）。
 *
 * AIが読み取って、利用者が確認した文字の行（位置は画像全体に対する割合）を使って、
 *   ① 変換後の画像から、その行の文字を消す（背景色で塗る）
 *   ② その画像がスライドの上で占めている位置に合わせて、テキストボックスを重ねる
 * を行う。すべてブラウザの中で行い、何も送信しない。元の（変換前の）ファイルは変更しない。
 *
 * 位置の対応が確実なものだけを置き換える: 回転・反転した画像、グループの中の画像は対象外（変更しない）。
 * トリミング（srcRect）は考慮する。
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { createBrowserImageCodec, sniffRasterKind, type ImageCodec } from "./image-invert";
import { decodeXmlBytes, resolveTarget } from "./invert-pptx";
import { parseHex } from "./color";

const SLIDE_RE = /^ppt\/slides\/[^/]+\.xml$/;
const COMPRESSED = new Set(["png", "jpg", "jpeg", "gif", "mp4", "m4v", "mov", "mp3", "m4a", "wmv", "wma", "avi", "webp", "zip", "pptx", "xlsx", "docx", "heic"]);
const ext = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

/** スライドの上の画像1つ（位置はEMU。1pt = 12700 EMU） */
export interface SlidePicture {
  slidePath: string;
  imagePath: string;
  offX: number;
  offY: number;
  cx: number;
  cy: number;
  /** トリミング（画像全体に対する割合 0〜1） */
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;
}

export interface PictureScan {
  pictures: SlidePicture[];
  /** 位置が確実でないため対象にしなかった画像の数（回転・反転・グループの中・位置情報なし） */
  skipped: number;
}

/** 部品どうしの参照から、スライドの上の画像と、その位置を調べる */
export function scanSlidePictures(files: Record<string, Uint8Array>): PictureScan {
  const pictures: SlidePicture[] = [];
  let skipped = 0;
  const slides = Object.keys(files).filter((n) => SLIDE_RE.test(n)).sort();
  for (const slide of slides) {
    const xml = decodeXmlBytes(files[slide]);
    if (xml === null) continue;
    const relsPath = slide.replace(/^(.*)\/([^/]+)$/, "$1/_rels/$2.rels");
    const relsBytes = files[relsPath];
    const relsXml = relsBytes ? decodeXmlBytes(relsBytes) : null;
    if (relsXml === null) continue;
    const rels = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      if (/TargetMode="External"/i.test(m[1])) continue;
      const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
      const type = /\bType="([^"]*)"/.exec(m[1])?.[1] ?? "";
      const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
      if (id && target && type.endsWith("/image")) rels.set(id, resolveTarget(slide, target));
    }
    // グループの中かどうかを調べるため、グループの開始・終了の位置を数える
    const groupEvents: { index: number; delta: 1 | -1 }[] = [];
    for (const g of xml.matchAll(/<(\/?)p:grpSp(?=[\s>/])/g)) groupEvents.push({ index: g.index ?? 0, delta: g[1] ? -1 : 1 });
    const depthAt = (index: number) => groupEvents.filter((e) => e.index < index).reduce((d, e) => d + e.delta, 0);
    for (const m of xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
      const block = m[0];
      const embed = /<a:blip\b[^>]*\br:embed="([^"]*)"/.exec(block)?.[1];
      const imagePath = embed ? rels.get(embed) : undefined;
      if (!imagePath) continue;
      const xfrm = /<a:xfrm\b([^>]*)>\s*<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(block);
      const attrs = xfrm?.[1] ?? "";
      const rotated = /\brot="(?!0")[^"]+"/.test(attrs) || /\bflip[HV]="(1|true)"/.test(attrs);
      if (!xfrm || rotated || depthAt(m.index ?? 0) > 0) {
        skipped++;
        continue;
      }
      const src = /<a:srcRect\b([^>]*)\/?>/.exec(block)?.[1] ?? "";
      const crop = (k: string) => {
        const v = new RegExp(`\\b${k}="(-?\\d+)"`).exec(src)?.[1];
        return v ? Math.max(0, Number(v) / 100000) : 0;
      };
      const cropL = crop("l");
      const cropT = crop("t");
      const cropR = crop("r");
      const cropB = crop("b");
      if (cropL + cropR >= 0.98 || cropT + cropB >= 0.98) {
        skipped++;
        continue;
      }
      const cx = Number(xfrm[4]);
      const cy = Number(xfrm[5]);
      if (cx <= 0 || cy <= 0) continue;
      pictures.push({ slidePath: slide, imagePath, offX: Number(xfrm[2]), offY: Number(xfrm[3]), cx, cy, cropL, cropT, cropR, cropB });
    }
  }
  return { pictures, skipped };
}

/** 置き換える文字の1行（位置は、画像全体に対する割合） */
export interface ReplaceLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  underline: boolean;
  bold: boolean;
}

export interface ImageReplacement {
  /** パッケージ内の画像のパス（ppt/media/…） */
  imagePath: string;
  lines: ReplaceLine[];
}

export interface TextReplaceOptions {
  /** 文字の色（RRGGBB） */
  textColor: string;
  /** 画像から文字を消すときに塗る色（RRGGBB。反転後の背景色） */
  backgroundColor: string;
}

export interface TextReplaceReport {
  /** 本物の文字にした行の数 */
  lines: number;
  /** 文字を消した画像の数 */
  images: number;
  /** 位置が確実でないなどの理由で、置き換えなかった行の数 */
  skippedLines: number;
  notes: string[];
}

export class TextReplaceError extends Error {}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 文字列の幅の見積り（em）。半角の英数字は0.55、そのほかは1 */
export function estimateTextEm(text: string): number {
  let em = 0;
  for (const ch of text) em += ch.charCodeAt(0) <= 0x7f ? 0.55 : 1;
  return em;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 1行ぶんのテキストボックスのXML。位置・大きさは、画像がスライドの上で占める位置から求める */
export function buildTextBoxXml(id: number, pic: SlidePicture, line: ReplaceLine, textColor: string): string | null {
  const visW = 1 - pic.cropL - pic.cropR;
  const visH = 1 - pic.cropT - pic.cropB;
  // 行が、見えている範囲の外にはみ出すものは、位置が確実でないため置き換えない
  if (line.x < pic.cropL - 0.002 || line.y < pic.cropT - 0.002 || line.x + line.w > 1 - pic.cropR + 0.002 || line.y + line.h > 1 - pic.cropB + 0.002) return null;
  const emuX = pic.offX + ((line.x - pic.cropL) / visW) * pic.cx;
  const emuY = pic.offY + ((line.y - pic.cropT) / visH) * pic.cy;
  const boxW = (line.w / visW) * pic.cx;
  const boxH = (line.h / visH) * pic.cy;
  // 文字の大きさ: 行の高さの約8割。幅が収まらないときは、収まるまで小さくする（半分までは小さくしない）
  let pt = (boxH / 12700) * 0.82;
  const wantW = estimateTextEm(line.text) * pt * 12700;
  if (wantW > boxW) pt *= Math.max(0.6, boxW / wantW);
  const sz = clamp(Math.round(pt * 100), 400, 8000);
  const rgb = /^[0-9A-F]{6}$/.test(textColor) ? textColor : "FFFFFF";
  const attrs = `lang="ja-JP" sz="${sz}" b="${line.bold ? 1 : 0}"${line.underline ? ' u="sng"' : ""} dirty="0"`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="AI文字 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(emuX)}" y="${Math.round(emuY)}"/><a:ext cx="${Math.round(boxW * 1.2)}" cy="${Math.round(boxH)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="l"/><a:r><a:rPr ${attrs}><a:solidFill><a:srgbClr val="${rgb}"/></a:solidFill></a:rPr><a:t>${escapeXml(line.text)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

/** 画像の中の、行の長方形（少し広げる）を、背景色で塗りつぶす（透明度は変えない） */
export function paintLines(data: Uint8ClampedArray | Uint8Array, width: number, height: number, lines: ReplaceLine[], color: string): void {
  const rgb = parseHex(color) ?? { r: 0, g: 0, b: 0 };
  for (const line of lines) {
    const padX = Math.max(1, Math.round(width * 0.003));
    const padY = Math.max(1, Math.round(height * 0.003));
    const x0 = clamp(Math.floor(line.x * width) - padX, 0, width);
    const x1 = clamp(Math.ceil((line.x + line.w) * width) + padX, 0, width);
    const y0 = clamp(Math.floor(line.y * height) - padY, 0, height);
    const y1 = clamp(Math.ceil((line.y + line.h) * height) + padY, 0, height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        data[i] = rgb.r;
        data[i + 1] = rgb.g;
        data[i + 2] = rgb.b;
      }
    }
  }
}

/**
 * 変換後の .pptx（bytes）に、文字の置き換えを適用する。
 * 位置の対応が取れない画像（回転・グループの中など）の行は置き換えず、skippedLines に数える。
 */
export async function applyTextReplacements(bytes: Uint8Array, replacements: ImageReplacement[], options: TextReplaceOptions, codec?: ImageCodec): Promise<{ bytes: Uint8Array; report: TextReplaceReport }> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new TextReplaceError("変換後のファイルを開けませんでした。");
  }
  const activeCodec = codec ?? (typeof document !== "undefined" ? createBrowserImageCodec() : undefined);
  if (!activeCodec) throw new TextReplaceError("この環境では、画像を処理できません。");
  const { pictures } = scanSlidePictures(files);
  const out: Record<string, Uint8Array> = { ...files };
  const slideXml = new Map<string, string>();
  const additions = new Map<string, string[]>();
  const nextId = new Map<string, number>();
  const report: TextReplaceReport = { lines: 0, images: 0, skippedLines: 0, notes: [] };

  for (const rep of replacements) {
    if (rep.lines.length === 0) continue;
    const pics = pictures.filter((p) => p.imagePath === rep.imagePath);
    const original = files[rep.imagePath];
    const kind = original ? sniffRasterKind(original) : null;
    if (pics.length === 0 || !original || !kind) {
      report.skippedLines += rep.lines.length;
      continue;
    }
    // まず、テキストボックスにできる行を決める（どのスライドの画像でも作れない行は、画像からも消さない）
    const usable: ReplaceLine[] = [];
    for (const line of rep.lines) {
      const ok = pics.some((pic) => buildTextBoxXml(1, pic, line, options.textColor) !== null);
      if (ok) usable.push(line);
      else report.skippedLines++;
    }
    if (usable.length === 0) continue;
    // ① 画像から文字を消す
    const raster = await activeCodec.decode(original, kind);
    paintLines(raster.data, raster.width, raster.height, usable, options.backgroundColor);
    out[rep.imagePath] = await activeCodec.encode(raster, kind, 0.98);
    report.images++;
    // ② テキストボックスを重ねる
    for (const pic of pics) {
      let xml = slideXml.get(pic.slidePath);
      if (xml === undefined) {
        xml = decodeXmlBytes(files[pic.slidePath]) ?? "";
        slideXml.set(pic.slidePath, xml);
        let max = 1;
        for (const m of xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)) max = Math.max(max, Number(m[1]));
        nextId.set(pic.slidePath, max + 1);
      }
      const list = additions.get(pic.slidePath) ?? [];
      for (const line of usable) {
        const id = nextId.get(pic.slidePath) ?? 2;
        const box = buildTextBoxXml(id, pic, line, options.textColor);
        if (!box) continue;
        nextId.set(pic.slidePath, id + 1);
        list.push(box);
        report.lines++;
      }
      additions.set(pic.slidePath, list);
    }
  }
  for (const [slide, boxes] of additions) {
    const xml = slideXml.get(slide) ?? "";
    const at = xml.lastIndexOf("</p:spTree>");
    if (at < 0 || boxes.length === 0) continue;
    out[slide] = strToU8(xml.slice(0, at) + boxes.join("") + xml.slice(at));
  }
  if (report.skippedLines > 0) report.notes.push(`位置を確実に合わせられない${report.skippedLines}行（回転した画像・グループの中の画像など）は、置き換えていません。`);
  report.notes.push("置き換えた文字は、元の画像の文字のあとに重ねたテキストボックスです。フォントや文字の幅は元の画像と少し違うことがあります。PowerPointで確認・調整してください。");
  const zippable: Zippable = {};
  for (const name of Object.keys(out)) {
    if (name.endsWith("/")) continue;
    zippable[name] = [out[name], { level: COMPRESSED.has(ext(name)) ? 0 : 6 }];
  }
  void strFromU8;
  return { bytes: zipSync(zippable), report };
}
