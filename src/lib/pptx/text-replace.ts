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
  /** AIの位置が実際の文字と合っていなかったため、画像の文字に合わせて位置・大きさを直した行の数 */
  snappedLines: number;
  /** 分数のような縦に2段以上の式とみなして、置き換えなかった行の数（skippedLines にも含む） */
  tallLines: number;
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

/** 見えている範囲の外にはみ出す行は、位置が確実でないため null */
function lineGeometry(pic: SlidePicture, line: ReplaceLine): { emuX: number; emuY: number; boxW: number; boxH: number } | null {
  const visW = 1 - pic.cropL - pic.cropR;
  const visH = 1 - pic.cropT - pic.cropB;
  if (line.x < pic.cropL - 0.002 || line.y < pic.cropT - 0.002 || line.x + line.w > 1 - pic.cropR + 0.002 || line.y + line.h > 1 - pic.cropB + 0.002) return null;
  return {
    emuX: pic.offX + ((line.x - pic.cropL) / visW) * pic.cx,
    emuY: pic.offY + ((line.y - pic.cropT) / visH) * pic.cy,
    boxW: (line.w / visW) * pic.cx,
    boxH: (line.h / visH) * pic.cy,
  };
}

/** 1行ぶんの文字の大きさ（pt）。行の高さの約8割。幅が収まらないときは、収まるまで小さくする（6割までは小さくしない） */
export function lineFontPt(pic: SlidePicture, line: ReplaceLine): number | null {
  const g = lineGeometry(pic, line);
  if (!g) return null;
  let pt = (g.boxH / 12700) * 0.82;
  const wantW = estimateTextEm(line.text) * pt * 12700;
  if (wantW > g.boxW) pt *= Math.max(0.6, g.boxW / wantW);
  return clamp(pt, 4, 80);
}

/**
 * 同じ大きさで書かれていた行の文字の大きさを、そろえる。
 * 行の高さは、AIの読み取りで少しずつずれるため、そのままだと、同じ段落の行で文字の大きさがばらつく。
 * 近い大きさ（約12%以内）の行を1つのまとまりとみなし、そのまとまりの中央値にする。
 * ただし、幅に収めるために自分だけ小さくなっていた行（中央値の88%未満）は、その大きさのままにする。
 * 戻り値は、入力と同じ順（null の行は null のまま）。
 */
export function unifyFontSizes(pts: (number | null)[]): (number | null)[] {
  const items = pts.map((pt, index) => ({ pt, index })).filter((it): it is { pt: number; index: number } => it.pt !== null);
  items.sort((a, b) => a.pt - b.pt);
  const out: (number | null)[] = pts.map(() => null);
  let i = 0;
  while (i < items.length) {
    let j = i + 1;
    while (j < items.length && items[j].pt <= items[i].pt * 1.12) j++;
    const group = items.slice(i, j);
    const median = group[Math.floor(group.length / 2)].pt;
    for (const it of group) out[it.index] = it.pt < median * 0.88 ? it.pt : median;
    i = j;
  }
  return out;
}

/**
 * 1行ぶんのテキストボックスのXML。位置・大きさは、画像がスライドの上で占める位置から求める。
 * fontPt を渡すと、その大きさ（pt）で作る（行どうしの大きさをそろえるため）。渡さないときは、その行だけで決める。
 */
export function buildTextBoxXml(id: number, pic: SlidePicture, line: ReplaceLine, textColor: string, fontPt?: number): string | null {
  const g = lineGeometry(pic, line);
  if (!g) return null;
  const pt = fontPt ?? lineFontPt(pic, line) ?? 8;
  const sz = clamp(Math.round(pt * 100), 400, 8000);
  const rgb = /^[0-9A-F]{6}$/.test(textColor) ? textColor : "FFFFFF";
  const attrs = `lang="ja-JP" sz="${sz}" b="${line.bold ? 1 : 0}"${line.underline ? ' u="sng"' : ""} dirty="0"`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="AI文字 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(g.emuX)}" y="${Math.round(g.emuY)}"/><a:ext cx="${Math.round(g.boxW * 1.2)}" cy="${Math.round(g.boxH)}"/></a:xfrm>` +
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

const lumaOf = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
const hexOf = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** 文字の長方形のすぐ外側（上下左右の細い帯）の、いちばん多い明るさの色（各色の中央値）。取れなければ null */
function sampleSurroundings(data: Uint8ClampedArray | Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number): { r: number; g: number; b: number } | null {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    if (data[i + 3] < 128) return;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  const band = 3;
  for (let d = 1; d <= band; d++) {
    for (let x = x0; x < x1; x++) {
      take(x, y0 - d);
      take(x, y1 - 1 + d);
    }
    for (let y = y0; y < y1; y++) {
      take(x0 - d, y);
      take(x1 - 1 + d, y);
    }
  }
  if (rs.length < 8) return null;
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/** 周りの色が、反転後の背景色に近いとみなす距離（赤・緑・青の差の合計）。これより遠いときは、周りの色で塗る */
const NEAR_BACKGROUND_DISTANCE = 90;
/** 文字の色と塗った色の明るさの差が、これより小さいと読みにくいので、文字の色を選び直す */
const MIN_TEXT_CONTRAST = 90;

export interface PaintResult {
  /** 行ごとに塗った色（RRGGBB）。入力の lines と同じ順 */
  fills: string[];
}

/**
 * 画像の中の、行の長方形（少し広げる）を塗りつぶして、文字を消す。
 * 周りが、反転後の背景色（color）に近いときは、その色で塗る。
 * 遠いとき（たとえば、元が白文字の帯だった見出し）は、周りの色で塗る。背景色で塗ると、帯の中に黒い四角が残るため。
 * 塗った色は、行ごとに返す（文字の色を選ぶのに使う）。
 */
export function paintLinesAdaptive(data: Uint8ClampedArray | Uint8Array, width: number, height: number, lines: ReplaceLine[], color: string): PaintResult {
  const base = parseHex(color) ?? { r: 0, g: 0, b: 0 };
  const fills: string[] = [];
  for (const line of lines) {
    const padX = Math.max(1, Math.round(width * 0.003));
    const padY = Math.max(1, Math.round(height * 0.003));
    const x0 = clamp(Math.floor(line.x * width) - padX, 0, width);
    const x1 = clamp(Math.ceil((line.x + line.w) * width) + padX, 0, width);
    const y0 = clamp(Math.floor(line.y * height) - padY, 0, height);
    const y1 = clamp(Math.ceil((line.y + line.h) * height) + padY, 0, height);
    const around = sampleSurroundings(data, width, height, x0, y0, x1, y1);
    const far = around !== null && Math.abs(around.r - base.r) + Math.abs(around.g - base.g) + Math.abs(around.b - base.b) > NEAR_BACKGROUND_DISTANCE;
    const rgb = far && around ? around : base;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        data[i] = rgb.r;
        data[i + 1] = rgb.g;
        data[i + 2] = rgb.b;
      }
    }
    fills.push(hexOf(rgb));
  }
  return { fills };
}

/** 塗った色の上で読める文字の色を選ぶ。指定の文字色で十分に読めるならそれ、読めないなら、背景色と文字色のうち差が大きいほう */
export function pickTextColor(fillHex: string, textColor: string, backgroundColor: string): string {
  const fill = parseHex(fillHex);
  const text = parseHex(textColor);
  const bg = parseHex(backgroundColor);
  if (!fill || !text) return textColor;
  if (Math.abs(lumaOf(fill) - lumaOf(text)) >= MIN_TEXT_CONTRAST) return textColor;
  if (!bg) return textColor;
  return Math.abs(lumaOf(fill) - lumaOf(bg)) > Math.abs(lumaOf(fill) - lumaOf(text)) ? backgroundColor : textColor;
}

/**
 * AIが返した行の位置・大きさは、実際の文字より小さい（または、ずれている）ことがある。
 * 小さいままだと、文字を消す範囲が足りず（元の文字が残って二重になる）、置く文字も小さくなる。
 * そこで、画像の中の「文字の画素」を実際に探して、行の位置・大きさを合わせ直す。
 *  - 文字の画素: 背景色との明るさの差が大きい画素（方眼のうすい線などは含まない）。
 *  - AIの位置の近くで、縦に並んだ文字の画素のまとまり（1行ぶん）を探し、その左右を、すき間が空くまで広げる。
 *  - 見つからない・まとまりが大きすぎる（図や、ほかの行とくっついている）ときは、AIの位置のまま。
 */
export interface SnapResult {
  line: ReplaceLine;
  /** 画像の文字に合わせて、位置・大きさを直した */
  snapped: boolean;
  /** 直した範囲の中の、文字の画素の割合（0〜1）。白い帯のような塗りは高く、文字・式はまばら */
  density: number;
}

const lumaRgb = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 画像の「文字の画素」の地図（1が文字）。背景色との明るさの差が、しきい値以上の画素 */
export function buildInkMask(data: Uint8ClampedArray | Uint8Array, width: number, height: number, backgroundColor: string, textColor: string): Uint8Array {
  const bg = parseHex(backgroundColor) ?? { r: 0, g: 0, b: 0 };
  const tx = parseHex(textColor) ?? { r: 255, g: 255, b: 255 };
  const bgL = lumaRgb(bg.r, bg.g, bg.b);
  const span = Math.abs(lumaRgb(tx.r, tx.g, tx.b) - bgL);
  const threshold = Math.max(50, span * 0.4);
  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (data[i + 3] < 128) continue;
    if (Math.abs(lumaRgb(data[i], data[i + 1], data[i + 2]) - bgL) >= threshold) mask[p] = 1;
  }
  return mask;
}

/** 位置を直す対象の行の高さの上限（AIの高さの何倍まで広げるか）。これを超えるまとまりは、図や別の行とくっついているとみなす */
const SNAP_MAX_GROWTH = 3.6;
/** 文字の画素の割合がこれを超えるまとまりは、塗りつぶし（帯など）とみなして、位置を直さない */
const SNAP_MAX_DENSITY = 0.85;

export function snapLineToInk(mask: Uint8Array, width: number, height: number, line: ReplaceLine): SnapResult {
  const keep: SnapResult = { line, snapped: false, density: 0 };
  const bx0 = line.x * width;
  const by0 = line.y * height;
  const bw = Math.max(1, line.w * width);
  const bh = Math.max(2, line.h * height);
  // 探す範囲: 縦は、AIの位置の少し上〜大きく下（AIが小さく・上にずれる場合が多い）。
  // 横は、AIの横の範囲だけ（広げると、隣の枠の線などを拾って、行がつながってしまう）
  const wx0 = clamp(Math.floor(bx0 - bh * 0.5), 0, width);
  const wx1 = clamp(Math.ceil(bx0 + bw + bh * 0.5), 0, width);
  const wy0 = clamp(Math.floor(by0 - bh * 1.2), 0, height);
  const wy1 = clamp(Math.ceil(by0 + bh * (1 + SNAP_MAX_GROWTH)), 0, height);
  if (wx1 - wx0 < 2 || wy1 - wy0 < 2) return keep;

  // 行ごとの文字の画素の数 → 縦のまとまり（すき間1行までは、つなげる）
  const rowHas = new Uint8Array(wy1 - wy0);
  for (let y = wy0; y < wy1; y++) {
    let n = 0;
    for (let x = wx0; x < wx1; x++) n += mask[y * width + x];
    // 画像の端の枠線のような、細い縦線だけの行は、文字の行とみなさない
    rowHas[y - wy0] = n >= Math.max(2, Math.ceil((wx1 - wx0) * 0.03)) ? 1 : 0;
  }
  const runs: { a: number; b: number }[] = [];
  let a = -1;
  let last = -1;
  for (let i = 0; i < rowHas.length; i++) {
    if (!rowHas[i]) continue;
    if (a >= 0 && i - last > 2) {
      runs.push({ a, b: last });
      a = -1;
    }
    if (a < 0) a = i;
    last = i;
  }
  if (a >= 0) runs.push({ a, b: last });
  // AIの行（by0〜by0+bh）といちばん重なるまとまりを選ぶ
  let best: { a: number; b: number } | null = null;
  let bestOverlap = 0;
  for (const run of runs) {
    const ya = wy0 + run.a;
    const yb = wy0 + run.b + 1;
    const overlap = Math.min(yb, by0 + bh) - Math.max(ya, by0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = run;
    }
  }
  if (!best || bestOverlap <= 0) return keep;
  const ry0 = wy0 + best.a;
  const ry1 = wy0 + best.b + 1;
  const rh = ry1 - ry0;
  if (rh > bh * SNAP_MAX_GROWTH || rh < 2) return keep;

  // 横: まとまりの行の範囲で、文字の画素がある列。AIの位置から、すき間が空くまで左右へ広げる
  const colHas = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    for (let y = ry0; y < ry1; y++) {
      if (mask[y * width + x]) {
        colHas[x] = 1;
        break;
      }
    }
  }
  const gap = Math.max(4, Math.round(rh));
  // 種になる列: AIの横の範囲の中の、いちばん左の文字の列
  let seed = -1;
  for (let x = clamp(Math.floor(bx0 - bh), 0, width); x < clamp(Math.ceil(bx0 + bw + bh), 0, width); x++) {
    if (colHas[x]) {
      seed = x;
      break;
    }
  }
  if (seed < 0) return keep;
  let left = seed;
  for (let x = seed - 1, miss = 0; x >= 0 && miss <= gap; x--) {
    if (colHas[x]) {
      left = x;
      miss = 0;
    } else miss++;
  }
  let right = seed;
  const maxRight = clamp(Math.ceil(bx0 + bw * SNAP_MAX_GROWTH + bh * 4), 0, width);
  for (let x = seed + 1, miss = 0; x < maxRight && miss <= gap; x++) {
    if (colHas[x]) {
      right = x;
      miss = 0;
    } else miss++;
  }
  const nx = left / width;
  const ny = ry0 / height;
  const nw = (right + 1 - left) / width;
  const nh = rh / height;
  // ほとんど変わらないときは、AIの位置のまま（わずかな差で、毎回動かさない）
  if (Math.abs(nx - line.x) < 0.004 && Math.abs(ny - line.y) < 0.004 && Math.abs(nw - line.w) < 0.01 && Math.abs(nh - line.h) < 0.006) return keep;
  let ink = 0;
  for (let y = ry0; y < ry1; y++) for (let x = left; x <= right; x++) ink += mask[y * width + x];
  const density = ink / ((right + 1 - left) * rh);
  // ほぼ全面が塗りつぶされているもの（帯・図形）は、文字ではなく塗り。文字の範囲を決められないので、AIの位置のまま
  if (density > SNAP_MAX_DENSITY) return keep;
  return { line: { ...line, x: nx, y: ny, w: nw, h: nh }, snapped: true, density };
}

/** 消す範囲を、上下左右に、行の高さの約15%（最低1px）広げる */
export function padLine(line: ReplaceLine, width: number, height: number): ReplaceLine {
  const px = Math.max(1, Math.round(line.h * height * 0.15));
  const x0 = Math.max(0, line.x - px / width);
  const y0 = Math.max(0, line.y - px / height);
  const x1 = Math.min(1, line.x + line.w + px / width);
  const y1 = Math.min(1, line.y + line.h + px / height);
  return { ...line, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 同じ画像の行のうち、ほかの行より極端に背の高い行（分数など、縦に2段以上の式）。文字の行として置き換えると崩れるので、画像のまま残す */
export const TALL_LINE_RATIO = 1.6;
/** 白い帯の見出しのような「塗り」は背が高くても文字として置き換えられる。まばらなもの（分数など）だけを、背の高い式とみなす */
export const TALL_LINE_MAX_DENSITY = 0.4;
export function findTallLines(heights: number[], densities: number[]): boolean[] {
  if (heights.length < 3) return heights.map(() => false);
  const sorted = [...heights].sort((p, q) => p - q);
  const med = sorted[Math.floor(sorted.length / 2)];
  return heights.map((h, i) => h > med * TALL_LINE_RATIO && densities[i] < TALL_LINE_MAX_DENSITY);
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
  const report: TextReplaceReport = { lines: 0, images: 0, skippedLines: 0, snappedLines: 0, tallLines: 0, notes: [] };

  for (const rep of replacements) {
    if (rep.lines.length === 0) continue;
    const pics = pictures.filter((p) => p.imagePath === rep.imagePath);
    const original = files[rep.imagePath];
    const kind = original ? sniffRasterKind(original) : null;
    if (pics.length === 0 || !original || !kind) {
      report.skippedLines += rep.lines.length;
      continue;
    }
    const raster = await activeCodec.decode(original, kind);
    // AIの位置が実際の文字より小さい・ずれているときは、画像の文字に合わせて直す
    const mask = buildInkMask(raster.data, raster.width, raster.height, options.backgroundColor, options.textColor);
    const snaps = rep.lines.map((line) => snapLineToInk(mask, raster.width, raster.height, line));
    const tall = findTallLines(snaps.map((r) => r.line.h), snaps.map((r) => r.density));
    let snappedCount = 0;
    let tallCount = 0;
    const candidates: ReplaceLine[] = [];
    const wasSnapped = new Map<ReplaceLine, boolean>();
    snaps.forEach((r, n) => {
      if (tall[n] && r.snapped) {
        tallCount++;
        return;
      }
      if (r.snapped) snappedCount++;
      candidates.push(r.line);
      wasSnapped.set(r.line, r.snapped);
    });
    report.snappedLines += snappedCount;
    report.tallLines += tallCount;
    report.skippedLines += tallCount;
    // まず、テキストボックスにできる行を決める（どのスライドの画像でも作れない行は、画像からも消さない）
    const usable: ReplaceLine[] = [];
    for (const line of candidates) {
      const ok = pics.some((pic) => buildTextBoxXml(1, pic, line, options.textColor) !== null);
      if (ok) usable.push(line);
      else report.skippedLines++;
    }
    if (usable.length === 0) continue;
    // ① 画像から文字を消す
    // 画像の文字に合わせて直した行は、文字のふちのうすい画素まで消すため、消す範囲だけ少し広げる（文字の大きさ・位置には影響しない）
    const erase = usable.map((line) => (wasSnapped.get(line) ? padLine(line, raster.width, raster.height) : line));
    const { fills } = paintLinesAdaptive(raster.data, raster.width, raster.height, erase, options.backgroundColor);
    const colors = usable.map((_, i) => pickTextColor(fills[i], options.textColor, options.backgroundColor));
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
      // 同じ大きさで書かれていた行は、文字の大きさをそろえる
      const sizes = unifyFontSizes(usable.map((line) => lineFontPt(pic, line)));
      for (let n = 0; n < usable.length; n++) {
        const line = usable[n];
        const id = nextId.get(pic.slidePath) ?? 2;
        const box = buildTextBoxXml(id, pic, line, colors[n], sizes[n] ?? undefined);
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
  if (report.tallLines > 0) report.notes.push(`分数など、縦に2段以上の式とみなした${report.tallLines}行は、文字にすると崩れるため、画像のまま残しています。`);
  if (report.skippedLines - report.tallLines > 0) report.notes.push(`位置を確実に合わせられない${report.skippedLines - report.tallLines}行（回転した画像・グループの中の画像など）は、置き換えていません。`);
  if (report.snappedLines > 0) report.notes.push(`AIが読み取った位置が実際の文字と合っていなかった${report.snappedLines}行は、画像の文字の位置に合わせて直しました。`);
  report.notes.push("置き換えた文字は、元の画像の文字を消したあとに重ねたテキストボックスです。同じ大きさの行は、文字の大きさをそろえています。フォントや文字の幅は元の画像と少し違うことがあります。PowerPointで確認・調整してください。");
  const zippable: Zippable = {};
  for (const name of Object.keys(out)) {
    if (name.endsWith("/")) continue;
    zippable[name] = [out[name], { level: COMPRESSED.has(ext(name)) ? 0 : 6 }];
  }
  void strFromU8;
  return { bytes: zipSync(zippable), report };
}
