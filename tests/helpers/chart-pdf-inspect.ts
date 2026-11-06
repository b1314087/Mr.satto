import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PDFの中身を調べるテスト用の道具(poppler の pdfinfo・pdftotext・pdftoppm を使う)。
 * 画像は72dpi(1画素=1pt)で、原点は左上。
 */

export function pageSizes(pdf: string): { w: number; h: number }[] {
  const out = execFileSync("pdfinfo", ["-f", "1", "-l", "9999", pdf]).toString();
  return [...out.matchAll(/Page\s+\d+\s+size:\s+([\d.]+) x ([\d.]+)/g)].map((m) => ({ w: Number(m[1]), h: Number(m[2]) }));
}

export function pageCount(pdf: string): number {
  const m = /Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [pdf]).toString());
  return m ? Number(m[1]) : 0;
}

export function pdfText(pdf: string, pageNo?: number): string {
  const args = ["-layout"];
  if (pageNo) args.push("-f", String(pageNo), "-l", String(pageNo));
  return execFileSync("pdftotext", [...args, pdf, "-"]).toString();
}

export interface Word {
  text: string;
  x: number;
  y: number;
  x2: number;
  y2: number;
}

export function words(pdf: string, pageNo = 1): Word[] {
  const out = execFileSync("pdftotext", ["-bbox", "-f", String(pageNo), "-l", String(pageNo), pdf, "-"]).toString();
  return [...out.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    x2: Number(m[3]),
    y2: Number(m[4]),
    text: m[5].replace(/&amp;/g, "&"),
  }));
}

export interface Img {
  w: number;
  h: number;
  data: Buffer;
}

export function render(pdf: string, pageNo = 1): Img {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfinspect-"));
  execFileSync("pdftoppm", ["-r", "72", "-f", String(pageNo), "-l", String(pageNo), pdf, path.join(dir, "p")]);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".ppm"))!;
  const buf = fs.readFileSync(path.join(dir, file));
  const m = buf.toString("latin1", 0, 30).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/)!;
  return { w: Number(m[1]), h: Number(m[2]), data: buf.subarray(m[0].length) };
}

export type Pred = (r: number, g: number, b: number) => boolean;
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function pixel(img: Img, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * img.w + Math.round(x)) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

export function countPixels(img: Img, pred: Pred, area?: Box): number {
  let n = 0;
  const a = area ?? { x0: 0, y0: 0, x1: img.w, y1: img.h };
  for (let y = Math.max(0, Math.floor(a.y0)); y < Math.min(img.h, Math.ceil(a.y1)); y++)
    for (let x = Math.max(0, Math.floor(a.x0)); x < Math.min(img.w, Math.ceil(a.x1)); x++) if (pred(...pixel(img, x, y))) n++;
  return n;
}

/** 同じ色のつながった塊(棒・扇形・マーカー)の外形。小さすぎる塊(文字の一部・線の端)は除く */
export function components(img: Img, pred: Pred, minPixels = 6, area?: Box): (Box & { n: number })[] {
  const seen = new Uint8Array(img.w * img.h);
  const out: (Box & { n: number })[] = [];
  const inArea = (x: number, y: number) => !area || (x >= area.x0 && x < area.x1 && y >= area.y0 && y < area.y1);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      if (seen[i] || !inArea(x, y) || !pred(...pixel(img, x, y))) continue;
      const stack = [i];
      seen[i] = 1;
      const c = { x0: x, y0: y, x1: x, y1: y, n: 0 };
      while (stack.length) {
        const j = stack.pop()!;
        const jx = j % img.w;
        const jy = (j - jx) / img.w;
        c.n++;
        c.x0 = Math.min(c.x0, jx);
        c.x1 = Math.max(c.x1, jx);
        c.y0 = Math.min(c.y0, jy);
        c.y1 = Math.max(c.y1, jy);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h || !inArea(nx, ny)) continue;
          const k = ny * img.w + nx;
          if (!seen[k] && pred(...pixel(img, nx, ny))) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      if (c.n >= minPixels) out.push(c);
    }
  }
  return out;
}

/** 棒らしい塊(幅・高さとも一定以上。凡例の小さな四角(約7pt角)は除く) */
export function bars(img: Img, pred: Pred, area?: Box, minSide = 4): (Box & { n: number })[] {
  return components(img, pred, 20, area).filter(
    (c) => c.x1 - c.x0 + 1 >= minSide && c.y1 - c.y0 + 1 >= minSide && !(c.x1 - c.x0 <= 9 && c.y1 - c.y0 <= 9)
  );
}
