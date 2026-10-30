import { getPdfjs, type PdfjsPage, type PositionedTextItem } from "./pdfjs-client";

/**
 * PDFに実際に描かれている縦の罫線から、表の列の区切りを求める（PDF→Excel用）。
 *
 * 文字の隙間だけから列を推定すると、罫線で区切られた表でも、セルいっぱいに文字が入っていて
 * 隙間が小さい（例: 「2026/10/01」の直後に店舗名が続く、右揃えの金額の隣に左揃えの文字が来る）と、
 * 隣り合う列が1つのセルにくっついてしまう。罫線は列の境目そのものなので、描かれていれば
 * それを列の区切りとして使う。AIは使わず、PDFの描画命令（線・矩形）を読むだけの決定的な処理。
 *
 * 座標はすべてPDFのページ座標系（原点は左下、上方向が正）。文字（PositionedTextItem）と同じ。
 */

export interface VerticalRule {
  x: number;
  /** 線の下端・上端（y0 <= y1） */
  y0: number;
  y1: number;
}

type Matrix = [number, number, number, number, number, number];

function multiply(a: Matrix, b: Matrix): Matrix {
  // pdfjsのtransform: 新しいCTM = b × a（a=現在のCTM、b=追加の変換）
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 明るさ(0〜255)。白に近い線・塗りは「見えない線」（セルを隠す白い矩形など）なので罫線とみなさない */
function luminanceOf(color: ArrayLike<number> | null | undefined, kind: "rgb" | "gray"): number {
  if (!color) return 0;
  if (kind === "gray") return (color[0] ?? 0) * 255 <= 1 ? (color[0] ?? 0) * 255 : (color[0] ?? 0);
  const r = color[0] ?? 0;
  const g = color[1] ?? 0;
  const b = color[2] ?? 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const WHITE_LUMINANCE = 225;
/** 縦の線とみなす、x方向のずれの許容(pt) */
const STRAIGHT_TOLERANCE_PT = 0.6;
/** 1本の線分として拾う最小の長さ(pt)。点線・記号の一部のような短いものは除く */
const MIN_SEGMENT_PT = 3;
/** 塗りの矩形を「太い罫線」とみなす最大の幅(pt) */
const MAX_FILLED_RULE_WIDTH_PT = 2.5;

interface GState {
  ctm: Matrix;
  strokeLum: number;
  fillLum: number;
}

/** ページの描画命令から、縦の罫線を取り出す。回転したページ・取り出せないPDFは null */
export async function extractVerticalRules(page: PdfjsPage): Promise<VerticalRule[] | null> {
  const pdfjs = await getPdfjs();
  const OPS = pdfjs.OPS;
  const rotate = (page as unknown as { rotate?: number }).rotate ?? 0;
  if (rotate % 360 !== 0) return null;

  let opList: { fnArray: number[]; argsArray: unknown[] };
  try {
    opList = await page.getOperatorList();
  } catch {
    return null;
  }

  const paintOps = new Set<number>([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.eoFillStroke,
    OPS.closeFillStroke,
    OPS.closeEOFillStroke,
  ]);
  const strokeOps = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const fillOps = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

  let state: GState = { ctm: [1, 0, 0, 1, 0, 0], strokeLum: 0, fillLum: 0 };
  const stack: GState[] = [];
  const rules: VerticalRule[] = [];

  const addVertical = (xa: number, ya: number, xb: number, yb: number) => {
    if (Math.abs(xa - xb) > STRAIGHT_TOLERANCE_PT) return;
    const y0 = Math.min(ya, yb);
    const y1 = Math.max(ya, yb);
    if (y1 - y0 < MIN_SEGMENT_PT) return;
    rules.push({ x: (xa + xb) / 2, y0, y1 });
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown;
    if (fn === OPS.save) {
      stack.push({ ...state });
    } else if (fn === OPS.restore) {
      state = stack.pop() ?? state;
    } else if (fn === OPS.transform) {
      state = { ...state, ctm: multiply(state.ctm, args as Matrix) };
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...state });
      const m = (args as unknown[])[0];
      if (Array.isArray(m) && m.length === 6) state = { ...state, ctm: multiply(state.ctm, m as Matrix) };
    } else if (fn === OPS.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
    } else if (fn === OPS.setStrokeRGBColor) {
      state = { ...state, strokeLum: luminanceOf(args as ArrayLike<number>, "rgb") };
    } else if (fn === OPS.setFillRGBColor) {
      state = { ...state, fillLum: luminanceOf(args as ArrayLike<number>, "rgb") };
    } else if (fn === OPS.setStrokeGray) {
      state = { ...state, strokeLum: luminanceOf(args as ArrayLike<number>, "gray") };
    } else if (fn === OPS.setFillGray) {
      state = { ...state, fillLum: luminanceOf(args as ArrayLike<number>, "gray") };
    } else if (fn === OPS.constructPath) {
      const next = opList.fnArray[i + 1];
      if (!paintOps.has(next)) continue; // クリップ(W n)など、描かない経路
      const [ops, coords] = args as [number[], ArrayLike<number>];
      if (!Array.isArray(ops) || !coords) continue;
      const stroked = strokeOps.has(next) && state.strokeLum < WHITE_LUMINANCE;
      const filled = fillOps.has(next) && state.fillLum < WHITE_LUMINANCE;
      if (!stroked && !filled) continue;

      let ci = 0;
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      for (const op of ops) {
        if (op === OPS.moveTo) {
          cur = apply(state.ctm, coords[ci], coords[ci + 1]);
          start = cur;
          ci += 2;
        } else if (op === OPS.lineTo) {
          const p = apply(state.ctm, coords[ci], coords[ci + 1]);
          ci += 2;
          if (stroked && cur) addVertical(cur[0], cur[1], p[0], p[1]);
          cur = p;
        } else if (op === OPS.curveTo) {
          cur = apply(state.ctm, coords[ci + 4], coords[ci + 5]);
          ci += 6;
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          cur = apply(state.ctm, coords[ci + 2], coords[ci + 3]);
          ci += 4;
        } else if (op === OPS.closePath) {
          if (stroked && cur && start) addVertical(cur[0], cur[1], start[0], start[1]);
          cur = start;
        } else if (op === OPS.rectangle) {
          const x = coords[ci];
          const y = coords[ci + 1];
          const w = coords[ci + 2];
          const h = coords[ci + 3];
          ci += 4;
          const c1 = apply(state.ctm, x, y);
          const c2 = apply(state.ctm, x + w, y + h);
          const left = Math.min(c1[0], c2[0]);
          const right = Math.max(c1[0], c2[0]);
          const bottom = Math.min(c1[1], c2[1]);
          const top = Math.max(c1[1], c2[1]);
          if (stroked) {
            // 枠線の矩形（セルの輪郭）の左右の辺
            addVertical(left, bottom, left, top);
            addVertical(right, bottom, right, top);
          } else if (filled && right - left <= MAX_FILLED_RULE_WIDTH_PT && top - bottom >= MIN_SEGMENT_PT) {
            // 細い塗りの矩形で描かれた罫線
            const cx = (left + right) / 2;
            addVertical(cx, bottom, cx, top);
          }
          cur = null;
          start = null;
        }
      }
    }
  }
  return rules;
}

/** 近い位置の罫線を、1本の列の境目にまとめる範囲(pt)。太い罫線を2本の細い線で描く場合も1本にする */
const CLUSTER_PT = 1.5;
/** 列の境目と認める、縦の長さの下限(pt)。短い飾りの縦線・記号を除く */
const MIN_RULE_TOTAL_PT = 24;
/** 表として扱うために必要な縦の罫線の本数（外枠の左右だけ=2本では、列を決めるには足りない） */
const MIN_RULE_COUNT = 3;

export interface RuledColumnBreaks {
  /** 列の区切りにするx座標（昇順）。表の左端・右端の外枠は含まない */
  breaks: number[];
  /** 縦の罫線が描かれているxの範囲。この中では、文字の隙間から推定した区切りは使わない */
  range: [number, number];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 縦の罫線と、そのページの文字から、列の区切りを決める。
 * 罫線が足りない（外枠だけ・短い線だけ）ときは null を返し、呼び出し側は文字の隙間による推定を使う。
 */
export function computeRuledColumnBreaks(rules: VerticalRule[] | null, items: PositionedTextItem[]): RuledColumnBreaks | null {
  if (!rules || rules.length < MIN_RULE_COUNT || items.length === 0) return null;

  // x座標が近い罫線をまとめ、それぞれの縦方向の範囲の和（重なりを1回だけ数える）を求める
  const sorted = [...rules].sort((a, b) => a.x - b.x);
  const clusters: VerticalRule[][] = [];
  for (const r of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && r.x - last[last.length - 1].x <= CLUSTER_PT) last.push(r);
    else clusters.push([r]);
  }

  const fontHeight = median(items.map((it) => it.fontHeight).filter((h) => h > 0)) || 10;
  const minTotal = Math.max(MIN_RULE_TOTAL_PT, fontHeight * 2.2);

  interface Kept {
    x: number;
    y0: number;
    y1: number;
  }
  const kept: Kept[] = [];
  for (const cluster of clusters) {
    const spans = cluster.map((r) => [r.y0, r.y1] as [number, number]).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curStart = spans[0][0];
    let curEnd = spans[0][1];
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] <= curEnd + 1) curEnd = Math.max(curEnd, spans[i][1]);
      else {
        total += curEnd - curStart;
        curStart = spans[i][0];
        curEnd = spans[i][1];
      }
    }
    total += curEnd - curStart;
    if (total < minTotal) continue;
    const x = cluster.reduce((s, r) => s + r.x, 0) / cluster.length;
    kept.push({ x, y0: Math.min(...cluster.map((r) => r.y0)), y1: Math.max(...cluster.map((r) => r.y1)) });
  }
  if (kept.length < MIN_RULE_COUNT) return null;

  const lo = kept[0].x;
  const hi = kept[kept.length - 1].x;
  const yLo = Math.min(...kept.map((k) => k.y0));
  const yHi = Math.max(...kept.map((k) => k.y1));

  // 外枠（一番左・一番右の罫線）は、その外側に表の文字が無ければ列の区切りにしない（空の列ができるため）
  const tableItems = items.filter((it) => it.str.trim() !== "" && it.y >= yLo - 2 && it.y <= yHi + 2);
  const anyLeft = tableItems.some((it) => it.x + it.width <= lo + 0.5);
  const anyRight = tableItems.some((it) => it.x >= hi - 0.5);
  const interior = kept.map((k) => k.x);
  const breaks = interior.filter((x, i) => {
    if (i === 0) return anyLeft;
    if (i === interior.length - 1) return anyRight;
    return true;
  });
  if (breaks.length === 0) return null;
  return { breaks, range: [lo, hi] };
}

/**
 * 文字の隙間から推定した区切り(textBreaks)と、罫線から決めた区切りを合わせる。
 * 罫線のある範囲では、罫線の位置だけを使う（セルの中の文字の隙間を、列の境目と取り違えないため）。
 * 範囲の外（表の左右にある文字など）は、これまでどおり文字の隙間から推定した区切りを使う。
 */
export function mergeRuledBreaks(textBreaks: number[], ruled: RuledColumnBreaks): number[] {
  const [lo, hi] = ruled.range;
  const outside = textBreaks.filter((b) => b < lo - 1 || b > hi + 1);
  return [...ruled.breaks, ...outside].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 塗りの矩形（表の見出しの背景色・蛍光ペン）
// ---------------------------------------------------------------------------

export interface FilledRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 塗りの色（6桁の16進、#なし） */
  color: string;
}

/** 白に近い塗り（背景と同じで見えない）は除く。明るさ(0〜255)がこれ以上なら無視 */
const FILL_IGNORE_LUMINANCE = 247;
/** 小さすぎる塗り（点・記号の一部）は除く(pt) */
const MIN_FILL_SIDE_PT = 2;

function toHexColor(args: ArrayLike<number> | null | undefined, kind: "rgb" | "gray"): string | null {
  if (!args) return null;
  let r: number;
  let g: number;
  let b: number;
  if (kind === "gray") {
    const v0 = args[0] ?? 0;
    const v = v0 <= 1 ? v0 * 255 : v0;
    r = g = b = v;
  } else {
    r = args[0] ?? 0;
    g = args[1] ?? 0;
    b = args[2] ?? 0;
    if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0) && !(r === 1 && g === 1 && b === 1)) {
      // 0〜1の値で渡された場合
      r *= 255;
      g *= 255;
      b *= 255;
    }
  }
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** ページの描画命令から、塗りの矩形（表の見出しの背景色・蛍光ペンなど）を取り出す。回転したページ・取り出せないPDFは null */
export async function extractFilledRects(page: PdfjsPage): Promise<FilledRect[] | null> {
  const pdfjs = await getPdfjs();
  const OPS = pdfjs.OPS;
  const rotate = (page as unknown as { rotate?: number }).rotate ?? 0;
  if (rotate % 360 !== 0) return null;
  let opList: { fnArray: number[]; argsArray: unknown[] };
  try {
    opList = await page.getOperatorList();
  } catch {
    return null;
  }
  const fillOps = new Set<number>([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let fill: string | null = "000000";
  const stack: { ctm: Matrix; fill: string | null }[] = [];
  const rects: FilledRect[] = [];

  const add = (xa: number, ya: number, xb: number, yb: number) => {
    const x0 = Math.min(xa, xb);
    const x1 = Math.max(xa, xb);
    const y0 = Math.min(ya, yb);
    const y1 = Math.max(ya, yb);
    if (x1 - x0 < MIN_FILL_SIDE_PT || y1 - y0 < MIN_FILL_SIDE_PT || !fill) return;
    const lum = 0.299 * parseInt(fill.slice(0, 2), 16) + 0.587 * parseInt(fill.slice(2, 4), 16) + 0.114 * parseInt(fill.slice(4, 6), 16);
    if (lum >= FILL_IGNORE_LUMINANCE) return;
    rects.push({ x0, y0, x1, y1, color: fill });
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown;
    if (fn === OPS.save) stack.push({ ctm, fill });
    else if (fn === OPS.restore) {
      const s = stack.pop();
      if (s) {
        ctm = s.ctm;
        fill = s.fill;
      }
    } else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm, fill });
      const m = (args as unknown[])[0];
      if (Array.isArray(m) && m.length === 6) ctm = multiply(ctm, m as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) {
      const s = stack.pop();
      if (s) {
        ctm = s.ctm;
        fill = s.fill;
      }
    } else if (fn === OPS.setFillRGBColor) fill = toHexColor(args as ArrayLike<number>, "rgb");
    else if (fn === OPS.setFillGray) fill = toHexColor(args as ArrayLike<number>, "gray");
    else if (fn === OPS.constructPath) {
      if (!fillOps.has(opList.fnArray[i + 1])) continue;
      const [ops, coords] = args as [number[], ArrayLike<number>];
      if (!Array.isArray(ops) || !coords) continue;
      let ci = 0;
      let pts: [number, number][] = [];
      const flush = () => {
        // 4点（または、始点に戻る5点）が縦横の辺だけでできていれば、矩形として扱う
        const p = pts.length === 5 && Math.abs(pts[4][0] - pts[0][0]) < 0.01 && Math.abs(pts[4][1] - pts[0][1]) < 0.01 ? pts.slice(0, 4) : pts;
        if (p.length === 4) {
          const axis = [0, 1, 2, 3].every((k) => {
            const a = p[k];
            const b = p[(k + 1) % 4];
            return Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01;
          });
          if (axis) add(p[0][0], p[0][1], p[2][0], p[2][1]);
        }
        pts = [];
      };
      for (const op of ops) {
        if (op === OPS.moveTo) {
          flush();
          pts = [apply(ctm, coords[ci], coords[ci + 1])];
          ci += 2;
        } else if (op === OPS.lineTo) {
          pts.push(apply(ctm, coords[ci], coords[ci + 1]));
          ci += 2;
        } else if (op === OPS.curveTo) {
          pts.push([NaN, NaN], [NaN, NaN]);
          ci += 6;
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          pts.push([NaN, NaN]);
          ci += 4;
        } else if (op === OPS.closePath) {
          flush();
        } else if (op === OPS.rectangle) {
          const c1 = apply(ctm, coords[ci], coords[ci + 1]);
          const c2 = apply(ctm, coords[ci] + coords[ci + 2], coords[ci + 1] + coords[ci + 3]);
          ci += 4;
          add(c1[0], c1[1], c2[0], c2[1]);
        }
      }
      flush();
    }
  }
  return rects;
}
