/**
 * スキャンした名簿（表）の画像から、罫線の位置を読み取って
 * 列の幅・行の高さを求める処理（ブラウザ内で完結。画像はどこにも送信しない）。
 *
 * 手順:
 *  1. 暗い画素（黒い線・文字）を集める
 *  2. スキャンの傾き（±3度）を、罫線が最も鮮明にそろう角度として推定する
 *  3. 水平・垂直方向に暗い画素を数え、表の端から端まで続く線を罫線とみなす
 *  4. 隣り合う罫線の間隔を、列の幅・行の高さとして返す
 *
 * 文字や結合セルの内側の線は無視する（罫線の「枠」だけを再現する用途）。
 */

export interface GrayImage {
  width: number;
  height: number;
  /** 1画素1バイトの明るさ（0=黒〜255=白） */
  data: ArrayLike<number>;
}

export interface DetectedGrid {
  /** 縦の罫線の位置(px)。左から右へ。2本以上 */
  xs: number[];
  /** 横の罫線の位置(px)。上から下へ。2本以上 */
  ys: number[];
  /** 推定したスキャンの傾き(度) */
  angleDeg: number;
  colWidthsPx: number[];
  rowHeightsPx: number[];
}

export interface DetectOptions {
  /** これより近い罫線は1本にまとめる(px) */
  minCellPx?: number;
}

/** 大津の方法で、黒と白を分ける明るさのしきい値を求める（極端な値は丸める） */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Array<number>(256).fill(0);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, Math.round(img.data[i])))]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return Math.min(200, Math.max(90, bestT));
}

interface Points {
  xs: Float32Array;
  ys: Float32Array;
  count: number;
}

function collectDarkPoints(img: GrayImage, threshold: number): Points {
  const { width, height, data } = img;
  let total = 0;
  for (let i = 0; i < width * height; i++) if (data[i] < threshold) total++;
  const xs = new Float32Array(total);
  const ys = new Float32Array(total);
  let k = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] < threshold) {
        xs[k] = x;
        ys[k] = y;
        k++;
      }
    }
  }
  return { xs, ys, count: total };
}

function rotate(p: Points, angleRad: number, cx: number, cy: number): { rx: Float32Array; ry: Float32Array } {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const rx = new Float32Array(p.count);
  const ry = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const dx = p.xs[i] - cx;
    const dy = p.ys[i] - cy;
    rx[i] = dx * cos + dy * sin;
    ry[i] = -dx * sin + dy * cos;
  }
  return { rx, ry };
}

/** 傾きの候補ごとの「線のそろい具合」。水平・垂直の投影の二乗和が大きいほど鮮明 */
function alignmentScore(rx: Float32Array, ry: Float32Array, step: number, size: number): number {
  const rowHist = new Uint32Array(size);
  const colHist = new Uint32Array(size);
  const half = size / 2;
  for (let i = 0; i < rx.length; i += step) {
    const xi = Math.round(rx[i] + half);
    const yi = Math.round(ry[i] + half);
    if (xi >= 0 && xi < size) colHist[xi]++;
    if (yi >= 0 && yi < size) rowHist[yi]++;
  }
  let s = 0;
  for (let i = 0; i < size; i++) s += rowHist[i] * rowHist[i] + colHist[i] * colHist[i];
  return s;
}

function estimateAngle(p: Points, width: number, height: number): number {
  const cx = width / 2;
  const cy = height / 2;
  const size = Math.ceil(Math.hypot(width, height)) + 4;
  const step = Math.max(1, Math.floor(p.count / 120000));
  const score = (deg: number) => {
    const { rx, ry } = rotate(p, (deg * Math.PI) / 180, cx, cy);
    return alignmentScore(rx, ry, step, size);
  };
  let best = 0;
  let bestScore = -1;
  for (let d = -3; d <= 3.0001; d += 0.5) {
    const s = score(d);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  const center = best;
  for (let d = center - 0.5; d <= center + 0.5001; d += 0.1) {
    const s = score(d);
    if (s > bestScore) {
      bestScore = s;
      best = d;
    }
  }
  return Math.round(best * 10) / 10;
}

/** ヒストグラムから「しきい値以上が続く区間」を線として取り出し、その中心位置を返す */
function pickLines(hist: Float64Array, threshold: number, mergeGap: number): number[] {
  const groups: { start: number; end: number; weight: number; weighted: number }[] = [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] >= threshold) {
      const last = groups[groups.length - 1];
      if (last && i - last.end <= 2) {
        last.end = i;
        last.weight += hist[i];
        last.weighted += hist[i] * i;
      } else {
        groups.push({ start: i, end: i, weight: hist[i], weighted: hist[i] * i });
      }
    }
  }
  const centers = groups.map((g) => g.weighted / g.weight);
  // 近すぎる線は1本にまとめる
  const merged: number[] = [];
  for (const c of centers) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && c - prev < mergeGap) merged[merged.length - 1] = (prev + c) / 2;
    else merged.push(c);
  }
  return merged;
}

function buildHist(coords: Float32Array, limit: Float32Array, lo: number, hi: number, offset: number, size: number, include: (i: number) => boolean): Float64Array {
  const hist = new Float64Array(size);
  for (let i = 0; i < coords.length; i++) {
    if (!include(i)) continue;
    if (limit[i] < lo || limit[i] > hi) continue;
    const b = Math.round(coords[i] + offset);
    if (b >= 0 && b < size) hist[b]++;
  }
  return hist;
}

/**
 * 画像から罫線を検出する。表が見つからないときは Error を投げる。
 * 戻り値の座標は「傾きを補正したあとの座標系」（表の左上基準ではなく画像の中心を原点にした値に offset を足したもの）。
 * 幅・高さ(px)は colWidthsPx / rowHeightsPx を使うこと。
 */
export function detectGrid(img: GrayImage, options: DetectOptions = {}): DetectedGrid {
  const minCell = options.minCellPx ?? Math.max(6, Math.round(Math.min(img.width, img.height) * 0.006));
  const threshold = otsuThreshold(img);
  const points = collectDarkPoints(img, threshold);
  if (points.count < 200) throw new Error("罫線を検出できませんでした（線がほとんど見つかりません）");

  const angle = estimateAngle(points, img.width, img.height);
  const { rx, ry } = rotate(points, (angle * Math.PI) / 180, img.width / 2, img.height / 2);
  const size = Math.ceil(Math.hypot(img.width, img.height)) + 4;
  const offset = size / 2;
  const all = () => true;

  // 1回目: 画像全体から、はっきりした線を探して表の範囲を決める
  const h0 = buildHist(ry, rx, -Infinity, Infinity, offset, size, all);
  const v0 = buildHist(rx, ry, -Infinity, Infinity, offset, size, all);
  const maxOf = (h: Float64Array) => h.reduce((m, v) => (v > m ? v : m), 0);
  const hLines0 = pickLines(h0, maxOf(h0) * 0.5, minCell);
  const vLines0 = pickLines(v0, maxOf(v0) * 0.5, minCell);
  if (hLines0.length < 2 || vLines0.length < 2) {
    throw new Error("罫線を検出できませんでした。線がはっきり写っている、傾きの小さいスキャンでお試しください");
  }
  const top = hLines0[0];
  const bottom = hLines0[hLines0.length - 1];
  const left = vLines0[0];
  const right = vLines0[vLines0.length - 1];

  // 2回目: 表の範囲の中だけで数え直し、端から端まで続く線だけを罫線とする
  const margin = 3;
  const hHist = buildHist(ry, rx, left - offset - margin, right - offset + margin, offset, size, all);
  const vHist = buildHist(rx, ry, top - offset - margin, bottom - offset + margin, offset, size, all);
  const ys = pickLines(hHist, (right - left) * 0.5, minCell);
  const xs = pickLines(vHist, (bottom - top) * 0.5, minCell);
  if (ys.length < 2 || xs.length < 2) {
    throw new Error("罫線を検出できませんでした。線がはっきり写っている、傾きの小さいスキャンでお試しください");
  }
  const diff = (a: number[]) => a.slice(1).map((v, i) => v - a[i]);
  return { xs, ys, angleDeg: angle, colWidthsPx: diff(xs), rowHeightsPx: diff(ys) };
}
