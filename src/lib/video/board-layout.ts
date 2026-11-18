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
