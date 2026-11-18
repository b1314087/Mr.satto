/**
 * PDFにもともと書かれている文字の「書き始めの位置（左端）」と「基準線の高さ」を、位置合わせの目印（ガイド）にする（2026-11-18）。
 *
 * 文字を書き込むときや、置いた文字を動かすときに、目印の近くに来たら点線を出して、その位置にぴったり合わせる。
 * 座標は、画面のページの座標（左下が原点、上が正。pt）。
 */

export interface GuideTextItem {
  /** 文字のかたまりの左端・右端（画面のページの座標） */
  x0: number;
  x1: number;
  /** 基準線の高さ */
  baseY: number;
  /** だいたいの文字の大きさ（pt） */
  size: number;
}

export interface TextGuides {
  /** 書き始めの位置（左端）の候補 */
  xs: number[];
  /** 基準線の高さの候補 */
  ys: number[];
}

/** 文字のかたまりから、目印の位置を作る（行の先頭と、同じ行の中で大きく離れて始まる位置。近い値は1つにまとめる） */
export function buildTextGuides(items: GuideTextItem[]): TextGuides {
  const visible = items.filter((i) => i.x1 > i.x0 && i.size > 0);
  // 基準線の高さで、行にまとめる
  const sorted = [...visible].sort((a, b) => b.baseY - a.baseY || a.x0 - b.x0);
  const lines: GuideTextItem[][] = [];
  for (const item of sorted) {
    const line = lines.find((l) => Math.abs(l[0].baseY - item.baseY) <= Math.max(l[0].size, item.size) * 0.3);
    if (line) line.push(item);
    else lines.push([item]);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x0 - b.x0);
    ys.push(line[0].baseY);
    let right = Number.NEGATIVE_INFINITY;
    for (const item of line) {
      // 行の先頭と、前の文字から文字2つ分より離れて始まるかたまり（表の別のマスなど）を、書き始めの位置にする
      if (item.x0 - right > item.size * 2) xs.push(item.x0);
      right = Math.max(right, item.x1);
    }
  }
  return { xs: dedupe(xs), ys: dedupe(ys) };
}

function dedupe(values: number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (out.length === 0 || v - out[out.length - 1] > 0.75) out.push(v);
  }
  return out;
}

/** いちばん近い目印を返す（threshold より離れていれば null） */
export function nearestGuide(value: number, guides: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const g of guides) {
    const d = Math.abs(g - value);
    if (d <= bestDist) {
      best = g;
      bestDist = d;
    }
  }
  return best;
}
