/**
 * スライドの上に貼られた画像と、その位置を調べる（PowerPoint白黒反転の、AIの判断の対象の画像を選ぶために使う）。
 *
 * 位置の対応が確実なものだけを対象にする: 回転・反転した画像、グループの中の画像は対象外（変更しない）。
 * トリミング（srcRect）は考慮する。
 */
import { decodeXmlBytes, resolveTarget } from "./invert-pptx";

const SLIDE_RE = /^ppt\/slides\/[^/]+\.xml$/;

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
