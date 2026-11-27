import { itemBounds, type BoardPlacement, type SnapGuides } from "@/lib/video/board-layout";

/**
 * 画像ホワイトボードの吸い付き（2026-11-27）。動画ホワイトボードの仕組み（src/lib/video/board-layout.ts）を、
 * 画像ホワイトボードの「左上の位置＋幅・高さ」で持つアイテムに合わせて使う。
 */

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** 左上の位置で持つアイテムを、中心の位置で持つ形（動画ホワイトボードと同じ形）にする */
export function toPlacement(b: LayoutBox): BoardPlacement {
  return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height, rotation: b.rotation };
}

/** 吸い付く相手の線：キャンバスの端・真ん中と、ほかのアイテムの外枠の端・真ん中 */
export function snapLines(others: LayoutBox[], canvas: { width: number; height: number }): { xs: number[]; ys: number[] } {
  const xs = [0, canvas.width / 2, canvas.width];
  const ys = [0, canvas.height / 2, canvas.height];
  for (const o of others) {
    const p = toPlacement(o);
    const b = itemBounds(p);
    xs.push(b.left, p.cx, b.right);
    ys.push(b.top, p.cy, b.bottom);
  }
  return { xs, ys };
}

type Corner = "nw" | "ne" | "sw" | "se";

/**
 * 角をつかんで大きさを変えているとき、動かしている辺（例：右下の角なら右と下の辺）が、
 * 近くの線から threshold 以内に来たら、その線にぴったり合わせる。回転していない（0°・180°）アイテムだけが対象。
 * 返すのは、合わせたあとの位置・大きさと、画面に出す目安の線。
 */
export function snapResizeEdges(
  box: LayoutBox,
  corner: Corner,
  lines: { xs: number[]; ys: number[] },
  threshold: number,
  minSize: number,
): { x: number; y: number; width: number; height: number; guides: SnapGuides } {
  let { x, y, width, height } = box;
  const guides: SnapGuides = { x: [], y: [] };
  if (((box.rotation % 180) + 180) % 180 !== 0) return { x, y, width, height, guides };
  const nearest = (v: number, ls: number[]) => {
    let best: number | null = null;
    for (const l of ls) if (Math.abs(l - v) <= threshold && (best === null || Math.abs(l - v) < Math.abs(best - v))) best = l;
    return best;
  };
  if (corner.includes("e")) {
    const l = nearest(x + width, lines.xs);
    if (l !== null && l - x >= minSize) {
      width = l - x;
      guides.x.push(l);
    }
  } else {
    const l = nearest(x, lines.xs);
    if (l !== null && x + width - l >= minSize) {
      width = x + width - l;
      x = l;
      guides.x.push(l);
    }
  }
  if (corner.includes("s")) {
    const l = nearest(y + height, lines.ys);
    if (l !== null && l - y >= minSize) {
      height = l - y;
      guides.y.push(l);
    }
  } else {
    const l = nearest(y, lines.ys);
    if (l !== null && y + height - l >= minSize) {
      height = y + height - l;
      y = l;
      guides.y.push(l);
    }
  }
  return { x, y, width, height, guides };
}
