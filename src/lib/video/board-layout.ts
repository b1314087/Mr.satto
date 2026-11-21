/**
 * 動画ホワイトボードの、キャンバスの形・並べ方の計算（純粋な計算だけ。画面・動画の処理に依存しない）。
 */

export type BoardShape = "vertical" | "horizontal" | "square";

export const BOARD_SHAPES: { value: BoardShape; label: string; hint: string; width: number; height: number }[] = [
  { value: "vertical", label: "縦動画（9:16）", hint: "リール・TikTok・ショート向け", width: 1080, height: 1920 },
  { value: "horizontal", label: "横動画（16:9）", hint: "YouTube・パソコン向け", width: 1920, height: 1080 },
  { value: "square", label: "正方形（1:1）", hint: "Instagramの投稿向け", width: 1080, height: 1080 },
];

export function boardSize(shape: BoardShape): { width: number; height: number } {
  const s = BOARD_SHAPES.find((b) => b.value === shape) ?? BOARD_SHAPES[0];
  return { width: s.width, height: s.height };
}

/** 一度に置ける動画の数（同時に読み込んで書き出すため、多すぎるとブラウザが重くなる） */
export const BOARD_MAX_VIDEOS = 6;
/** 書き出せる長さの上限（秒）。音声をまとめて混ぜるため、メモリを使いすぎないように */
export const BOARD_MAX_SECONDS = 10 * 60;
/** 書き出しのフレームレート */
export const BOARD_FPS = 30;

/** 短い動画が終わったあと：最後の場面で止める／最初からくり返す */
export type BoardEndBehavior = "hold" | "loop";

/** キャンバスに置いた動画1つ（位置・大きさはキャンバスの画素。中心の位置で持つ） */
export interface BoardPlacement {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** 回転（度、時計回り） */
  rotation: number;
}

/** 縦横比を保ったまま、枠の中に収まる大きさ（中央に置く） */
export function containIn(aspect: number, box: { x: number; y: number; w: number; h: number }): BoardPlacement {
  let w = box.w;
  let h = w / aspect;
  if (h > box.h) {
    h = box.h;
    w = h * aspect;
  }
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, w, h, rotation: 0 };
}

/**
 * 動画をキャンバスに並べる（同じ大きさのマスに分けて、各マスに縦横比を保って収める）。
 * 列数は、動画が画面をいちばん広く使える数を選ぶ（縦動画に2本なら上下、横動画に2本なら左右になる）。
 */
export function arrangeInGrid(aspects: number[], canvas: { width: number; height: number }, gap = 0): BoardPlacement[] {
  const n = aspects.length;
  if (n === 0) return [];
  let best = { cols: 1, rows: n, area: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (canvas.width - gap * (cols - 1)) / cols;
    const cellH = (canvas.height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const area = aspects.reduce((sum, a) => {
      const p = containIn(a, { x: 0, y: 0, w: cellW, h: cellH });
      return sum + p.w * p.h;
    }, 0);
    // 同じくらいなら、マスの並び（列÷行）がキャンバスの形に近いほうを選ぶ（横長なら左右、縦長なら上下）
    const fit = (c: number, r: number) => Math.abs(Math.log(c / r / (canvas.width / canvas.height)));
    const tie = Math.abs(area - best.area) <= best.area * 0.001;
    if (area > best.area * 1.001 || (tie && fit(cols, rows) < fit(best.cols, best.rows))) best = { cols, rows, area };
  }
  const { cols, rows } = best;
  const cellW = (canvas.width - gap * (cols - 1)) / cols;
  const cellH = (canvas.height - gap * (rows - 1)) / rows;
  return aspects.map((a, i) => {
    const r = Math.floor(i / cols);
    // 最後の行の数が少ないときは、その行を真ん中に寄せる
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
    const c = i % cols;
    const rowOffset = ((cols - inRow) * (cellW + gap)) / 2;
    return containIn(a, { x: rowOffset + c * (cellW + gap), y: r * (cellH + gap), w: cellW, h: cellH });
  });
}

/** 書き出す長さ：いちばん長い動画の長さ（上限あり） */
export function boardDuration(durations: number[]): number {
  if (durations.length === 0) return 0;
  return Math.min(BOARD_MAX_SECONDS, Math.max(...durations));
}

/** キャンバス全体の時刻 t のとき、その動画の中のどの時刻を見せるか */
export function localTime(t: number, duration: number, end: BoardEndBehavior): number {
  if (duration <= 0) return 0;
  if (end === "loop") return t % duration;
  return Math.min(t, Math.max(0, duration - 0.001));
}

// ───────────── 端・ほかの動画への吸い付き、端に寄せる（2026-11-21） ─────────────

/** 回転を含めた、見た目の外枠（キャンバスの画素） */
export function itemBounds(p: BoardPlacement): { left: number; right: number; top: number; bottom: number; w: number; h: number } {
  const rad = (p.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const w = p.w * c + p.h * s;
  const h = p.w * s + p.h * c;
  return { left: p.cx - w / 2, right: p.cx + w / 2, top: p.cy - h / 2, bottom: p.cy + h / 2, w, h };
}

/** 吸い付いたときに画面に出す、目安の線（キャンバスの画素） */
export interface SnapGuides {
  x: number[];
  y: number[];
}

/**
 * 動かしている動画を、キャンバスの端・真ん中、ほかの動画の端・真ん中に吸い付ける。
 * 動画の外枠の「左・真ん中・右」（縦は「上・真ん中・下」）のどれかが、近くの線から threshold 以内なら、その線にぴったり合わせる。
 */
export function snapMove(
  p: BoardPlacement,
  others: BoardPlacement[],
  canvas: { width: number; height: number },
  threshold: number,
): { cx: number; cy: number; guides: SnapGuides } {
  const b = itemBounds(p);
  const xs = [0, canvas.width / 2, canvas.width];
  const ys = [0, canvas.height / 2, canvas.height];
  for (const o of others) {
    const ob = itemBounds(o);
    xs.push(ob.left, o.cx, ob.right);
    ys.push(ob.top, o.cy, ob.bottom);
  }
  const pick = (mine: number[], lines: number[]) => {
    let best: { delta: number; line: number } | null = null;
    for (const m of mine)
      for (const l of lines) {
        const d = l - m;
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, line: l };
      }
    return best;
  };
  const sx = pick([b.left, p.cx, b.right], xs);
  const sy = pick([b.top, p.cy, b.bottom], ys);
  return {
    cx: p.cx + (sx?.delta ?? 0),
    cy: p.cy + (sy?.delta ?? 0),
    guides: { x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] },
  };
}

/**
 * 大きさを変えているとき、外枠の端がキャンバスの端から threshold 以内に来たら、ちょうど端に合う大きさにする
 * （中心は動かさず、縦横比を保ったまま）。返すのは新しい幅 w。
 */
export function snapResize(p: BoardPlacement, canvas: { width: number; height: number }, threshold: number): { w: number; guides: SnapGuides } {
  const rad = (p.rotation * Math.PI) / 180;
  const ratio = p.h / Math.max(1e-6, p.w);
  const kx = Math.abs(Math.cos(rad)) + ratio * Math.abs(Math.sin(rad));
  const ky = Math.abs(Math.sin(rad)) + ratio * Math.abs(Math.cos(rad));
  const candidates: { w: number; gx?: number; gy?: number }[] = [
    { w: (2 * p.cx) / kx, gx: 0 },
    { w: (2 * (canvas.width - p.cx)) / kx, gx: canvas.width },
    { w: (2 * p.cy) / ky, gy: 0 },
    { w: (2 * (canvas.height - p.cy)) / ky, gy: canvas.height },
  ];
  let best: { w: number; gx?: number; gy?: number; d: number } | null = null;
  for (const c of candidates) {
    if (!(c.w > 0)) continue;
    // 端の位置のずれ（画素）＝ 幅の差 × 外枠の倍率 ÷ 2
    const d = (Math.abs(c.w - p.w) * (c.gx !== undefined ? kx : ky)) / 2;
    if (d <= threshold && (!best || d < best.d)) best = { ...c, d };
  }
  if (!best) return { w: p.w, guides: { x: [], y: [] } };
  return { w: best.w, guides: { x: best.gx !== undefined ? [best.gx] : [], y: best.gy !== undefined ? [best.gy] : [] } };
}

/** 端に寄せる位置（9か所） */
export type BoardAlign = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";

export const BOARD_ALIGNS: { value: BoardAlign; label: string; symbol: string }[] = [
  { value: "top-left", label: "左上に寄せる", symbol: "◤" },
  { value: "top", label: "上に寄せる", symbol: "▲" },
  { value: "top-right", label: "右上に寄せる", symbol: "◥" },
  { value: "left", label: "左に寄せる", symbol: "◀" },
  { value: "center", label: "真ん中に置く", symbol: "●" },
  { value: "right", label: "右に寄せる", symbol: "▶" },
  { value: "bottom-left", label: "左下に寄せる", symbol: "◣" },
  { value: "bottom", label: "下に寄せる", symbol: "▼" },
  { value: "bottom-right", label: "右下に寄せる", symbol: "◢" },
];

/**
 * 動画を、キャンバスの端（9か所のどれか）にぴったり寄せる（外枠がキャンバスの端に接する）。
 * 「上」「下」は横を真ん中に、「左」「右」は縦を真ん中にそろえる。大きさは変えない。
 */
export function alignOnBoard(p: BoardPlacement, canvas: { width: number; height: number }, align: BoardAlign): { cx: number; cy: number } {
  const b = itemBounds(p);
  const h = align.includes("left") ? "left" : align.includes("right") ? "right" : "center";
  const v = align.startsWith("top") ? "top" : align.startsWith("bottom") ? "bottom" : "center";
  const cx = h === "left" ? b.w / 2 : h === "right" ? canvas.width - b.w / 2 : canvas.width / 2;
  const cy = v === "top" ? b.h / 2 : v === "bottom" ? canvas.height - b.h / 2 : canvas.height / 2;
  return { cx, cy };
}

/**
 * 動画を、キャンバスの幅（または高さ）いっぱいに広げる（縦横比はそのまま。もう一方の向きは今の位置のまま、はみ出さないように寄せる）。
 */
export function fillOnBoard(p: BoardPlacement, canvas: { width: number; height: number }, axis: "width" | "height"): BoardPlacement {
  const b = itemBounds(p);
  const k = axis === "width" ? canvas.width / b.w : canvas.height / b.h;
  const next = { ...p, w: p.w * k, h: p.h * k };
  const nb = itemBounds(next);
  const clamp = (v: number, half: number, size: number) => (half * 2 >= size ? size / 2 : Math.min(size - half, Math.max(half, v)));
  return {
    ...next,
    cx: axis === "width" ? canvas.width / 2 : clamp(p.cx, nb.w / 2, canvas.width),
    cy: axis === "height" ? canvas.height / 2 : clamp(p.cy, nb.h / 2, canvas.height),
  };
}
