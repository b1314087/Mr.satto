/**
 * OCRの前処理: 表の罫線（長い水平線・垂直線）を白で塗りつぶして消す。
 *
 * 背景（スキャンPDF→Excelの検証で判明）:
 *  罫線のあるスキャン表をそのままtesseract.jsに渡すと、罫線を文字（「|」など）と
 *  誤認して行全体の読み取りが崩れ、「|時」「[em[ale|c|o|e|」のような文字化けだけが
 *  返ることがある（表の文字はきれいに印刷されていても起こる）。
 *  罫線を消した画像で読み取ると、同じ画像で文字が正しく読めた。
 *  罫線の位置自体は、表の列・行の推定（table-reconstruction.ts）が文字の座標から
 *  行うため、OCRに罫線の情報は不要。
 *
 * 方法: 画像を2値化（周囲の明るさとの差で「インク」を判定）し、
 *  水平方向・垂直方向に一定以上つながった、細いインクの連なりだけを「罫線」として消す。
 *  文字の一画は短い（行の高さ程度）ため、長さの基準を「ページの幅・高さに対する割合」に
 *  することで文字を消さないようにしている。大きな太い文字（見出し・大きな活字）は
 *  一画が長くなることがあるため、線の太さが基準を超えるものは罫線とみなさず残す。
 *  スキャン時の少しの傾き（〜1.5度）で罫線が途中で段差になっても、段差ごとの連なりが
 *  基準より長ければ消える。
 *
 * 純粋関数（DOM非依存）にしてあり、テストからも直接呼べる。
 */

export interface GrayImage {
  width: number;
  height: number;
  /** 0(黒)〜255(白)のグレースケール */
  gray: Uint8Array | Uint8ClampedArray;
}

export interface RemoveLinesOptions {
  /** 水平線とみなす最小の長さ(ページ幅に対する割合)。既定 1/10 */
  minHorizontalRatio?: number;
  /** 垂直線とみなす最小の長さ(ページ高さに対する割合)。既定 1/12 */
  minVerticalRatio?: number;
  /** 罫線とみなす最大の太さ(ページの短辺に対する割合)。既定 1/100。これより太い線は文字として残す */
  maxThicknessRatio?: number;
}

export interface RemoveLinesResult {
  /** 罫線を白く塗ったグレースケール画像 */
  gray: Uint8Array;
  /** 消した罫線の画素数 */
  removedPixels: number;
}

/** 周囲(boxRadius四方)の平均より一定以上暗い画素を「インク」とする */
function buildInkMask(img: GrayImage, boxRadius: number, margin: number): Uint8Array {
  const { width: w, height: h, gray } = img;
  // 積分画像(平均の高速計算)。sum は最大 255*w*h なので Float64 で保持
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - boxRadius);
    const y1 = Math.min(h, y + boxRadius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - boxRadius);
      const x1 = Math.min(w, x + boxRadius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const sum =
        integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / area;
      // 平均より margin 以上暗く、かつ絶対値としても極端に明るくない画素
      if (gray[y * w + x] < mean - margin && gray[y * w + x] < 200) ink[y * w + x] = 1;
    }
  }
  return ink;
}

/** 横方向に minLen 以上つながったインクの画素を mark に立てる */
function markHorizontalRuns(
  ink: Uint8Array,
  w: number,
  h: number,
  minLen: number,
  maxThickness: number,
  mark: Uint8Array
): void {
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!ink[y * w + x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < w && ink[y * w + end]) end++;
      if (end - x >= minLen) {
        // 連なりの何か所かで上下に何画素インクが続くか(線の太さ)を調べ、太すぎるものは文字として残す。
        // 他の線と交わる位置では見かけ上太くなるため、調べた中で最も細い値を使う。
        let thickness = Infinity;
        for (let k = 1; k <= 5; k++) {
          const at = x + Math.floor(((end - x) * k) / 6);
          let up = y;
          while (up > 0 && ink[(up - 1) * w + at]) up--;
          let down = y;
          while (down < h - 1 && ink[(down + 1) * w + at]) down++;
          thickness = Math.min(thickness, down - up + 1);
        }
        if (thickness <= maxThickness) for (let i = x; i < end; i++) mark[y * w + i] = 1;
      }
      x = end;
    }
  }
}

/** 縦方向に minLen 以上つながったインクの画素を mark に立てる */
function markVerticalRuns(
  ink: Uint8Array,
  w: number,
  h: number,
  minLen: number,
  maxThickness: number,
  mark: Uint8Array
): void {
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!ink[y * w + x]) {
        y++;
        continue;
      }
      let end = y;
      while (end < h && ink[end * w + x]) end++;
      if (end - y >= minLen) {
        let thickness = Infinity;
        for (let k = 1; k <= 5; k++) {
          const at = y + Math.floor(((end - y) * k) / 6);
          let left = x;
          while (left > 0 && ink[at * w + left - 1]) left--;
          let right = x;
          while (right < w - 1 && ink[at * w + right + 1]) right++;
          thickness = Math.min(thickness, right - left + 1);
        }
        if (thickness <= maxThickness) for (let i = y; i < end; i++) mark[i * w + x] = 1;
      }
      y = end;
    }
  }
}

/**
 * 影・照明のムラ(スマホ撮影や端のスキャンで、紙の一部が暗くなる)をならす。
 *
 * 紙の明るさ(背景)を、縮小した画像の「近くの最も明るい値」から推定し、各画素を
 * その背景で割って、背景が一様に白になるようにする。文字の太さより十分大きい範囲の
 * 最大値を使うため、文字そのものは背景として扱われない。
 * 背景のムラが小さい(ほぼ一様)画像は、changed=false で元のまま返す。
 */
export function normalizeIllumination(img: GrayImage): { gray: Uint8Array; changed: boolean } {
  const { width: w, height: h, gray } = img;
  const f = 8;
  const sw = Math.max(1, Math.ceil(w / f));
  const sh = Math.max(1, Math.ceil(h / f));
  // 縮小(区画の平均)
  const small = new Float32Array(sw * sh);
  const cnt = new Uint16Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, (y / f) | 0);
    for (let x = 0; x < w; x++) {
      const si = sy * sw + Math.min(sw - 1, (x / f) | 0);
      small[si] += gray[y * w + x];
      cnt[si]++;
    }
  }
  for (let i = 0; i < small.length; i++) small[i] = cnt[i] ? small[i] / cnt[i] : 255;

  // 最大値フィルタ(横→縦)と平滑化。窓は文字の高さより大きく取る
  const r = Math.max(4, Math.round(Math.min(w, h) / 150));
  const maxFilter = (src: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        let m = 0;
        if (horizontal) for (let k = Math.max(0, x - r); k <= Math.min(sw - 1, x + r); k++) m = Math.max(m, src[y * sw + k]);
        else for (let k = Math.max(0, y - r); k <= Math.min(sh - 1, y + r); k++) m = Math.max(m, src[k * sw + x]);
        out[y * sw + x] = m;
      }
    }
    return out;
  };
  const boxBlur = (src: Float32Array, rad: number): Float32Array => {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let sum = 0;
        let n = 0;
        for (let k = Math.max(0, x - rad); k <= Math.min(sw - 1, x + rad); k++) {
          sum += src[y * sw + k];
          n++;
        }
        tmp[y * sw + x] = sum / n;
      }
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        let sum = 0;
        let n = 0;
        for (let k = Math.max(0, y - rad); k <= Math.min(sh - 1, y + rad); k++) {
          sum += tmp[k * sw + x];
          n++;
        }
        out[y * sw + x] = sum / n;
      }
    return out;
  };
  const bg = boxBlur(maxFilter(maxFilter(small, true), false), 2);

  let bgMin = 255;
  let bgMax = 0;
  for (const v of bg) {
    bgMin = Math.min(bgMin, v);
    bgMax = Math.max(bgMax, v);
  }
  if (bgMax <= 0 || (bgMax - bgMin) / bgMax < 0.08) return { gray: new Uint8Array(gray), changed: false };

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // 背景は縮小画像の区画中心に対する双一次補間
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const top = bg[y0 * sw + x0] * (1 - tx) + bg[y0 * sw + x1] * tx;
      const bot = bg[y1 * sw + x0] * (1 - tx) + bg[y1 * sw + x1] * tx;
      const b = Math.max(1, top * (1 - ty) + bot * ty);
      out[y * w + x] = Math.min(255, Math.round((gray[y * w + x] * 255) / b));
    }
  }
  return { gray: out, changed: true };
}

/**
 * 紙の傾き(度)を推定する。文字の行や罫線が水平にそろう角度を、-3〜+3度の範囲で探す。
 * 縮小した画像のインク画素を、各角度で行方向に投影し、行ごとの偏りが最も大きい角度を選ぶ
 * (水平にそろうほど、文字の行と行の間に何もない行が増え、偏りが大きくなる)。
 * 返す角度は「画像の上で右下がり(y下向きが正)の傾き」を正とする。
 * 傾きがほとんど無い(根拠が弱い)場合は0を返す。
 */
export function estimateSkewDegrees(img: GrayImage): number {
  const { width: w, height: h, gray } = img;
  const f = Math.max(1, Math.round(Math.max(w, h) / 900));
  const sw = Math.floor(w / f);
  const sh = Math.floor(h / f);
  if (sw < 50 || sh < 50) return 0;
  // 縮小(平均)
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) sum += gray[(y * f + dy) * w + (x * f + dx)];
      small[y * sw + x] = sum / (f * f);
    }
  const ink = buildInkMask({ width: sw, height: sh, gray: small }, Math.max(6, Math.round(Math.min(sw, sh) / 40)), 20);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (ink[y * sw + x]) {
      xs.push(x);
      ys.push(y);
    }
  if (xs.length < 200) return 0;

  const score = (deg: number): number => {
    const rad = (deg * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    const bins = new Float64Array(sh + sw + 4);
    const offset = sw + 2;
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] * cos - xs[i] * sin) + offset]++;
    let total = 0;
    for (const v of bins) total += v * v;
    return total;
  };
  let best = 0;
  let bestScore = score(0);
  const base = bestScore;
  for (let deg = -3; deg <= 3.001; deg += 0.25) {
    const sc = score(deg);
    if (sc > bestScore) {
      bestScore = sc;
      best = deg;
    }
  }
  for (let deg = best - 0.2; deg <= best + 0.201; deg += 0.05) {
    const sc = score(deg);
    if (sc > bestScore) {
      bestScore = sc;
      best = deg;
    }
  }
  // 0度に比べて偏りが5%以上大きくならなければ、傾きなしとみなす
  return bestScore > base * 1.05 ? best : 0;
}

/** 画像を中心のまわりに -deg 度回して、傾きを直す(双一次補間・空白は白)。estimateSkewDegreesの返した角度を渡す */
export function deskewGray(img: GrayImage, deg: number): Uint8Array {
  const { width: w, height: h, gray } = img;
  const rad = (deg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const out = new Uint8Array(w * h).fill(255);
  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      const dx = X - cx;
      const dy = Y - cy;
      const sx = dx * cos - dy * sin + cx;
      const sy = dx * sin + dy * cos + cy;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const tx = sx - x0;
      const ty = sy - y0;
      const top = gray[y0 * w + x0] * (1 - tx) + gray[y0 * w + x1] * tx;
      const bot = gray[y1 * w + x0] * (1 - tx) + gray[y1 * w + x1] * tx;
      out[Y * w + X] = Math.round(top * (1 - ty) + bot * ty);
    }
  }
  return out;
}

/**
 * 濃い色で塗りつぶした帯(表の見出し行など)の上の白い文字を、読める向きにする。
 *
 * 濃い塗りに白抜きの文字は、そのままだとOCRに読まれない。画像の中の「濃い画素のつながり」のうち、
 * 十分に大きい長方形に近いもの(幅と高さが文字より大きく、領域の過半が濃い画素)を探し、
 * その長方形の中だけを白黒反転する(塗り=白に近い色、白抜きの文字=黒になる)。
 * 文字そのもの(小さい)や、ただの太い線(細長い)は対象にしない。
 * 反転した長方形の数を返す。
 */
export function invertDarkBlocks(img: GrayImage, gray: Uint8Array): number {
  const { width: w, height: h } = img;
  const minW = Math.max(60, Math.round(w / 25));
  const minH = Math.max(20, Math.round(h / 80));
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = gray[i] < 128 ? 1 : 0;
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blocks: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && dark[p - 1] && !visited[p - 1]) {
        visited[p - 1] = 1;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && dark[p + 1] && !visited[p + 1]) {
        visited[p + 1] = 1;
        stack[sp++] = p + 1;
      }
      if (y > 0 && dark[p - w] && !visited[p - w]) {
        visited[p - w] = 1;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && dark[p + w] && !visited[p + w]) {
        visited[p + w] = 1;
        stack[sp++] = p + w;
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    // 十分に大きく、領域の過半が濃い(=白抜き文字の穴があっても、ほぼ塗りつぶされた長方形)
    // 表の罫線がつながった大きな格子は、領域に占める濃い画素が少ないので対象にならない
    if (bw >= minW && bh >= minH && count / (bw * bh) >= 0.55) blocks.push({ x0, y0, x1, y1 });
  }
  for (const b of blocks) {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) gray[y * w + x] = Math.min(255, Math.round((255 - gray[y * w + x]) * 1.3)); // 塗りの色を白に近づける
  }
  return blocks.length;
}

export function removeRuledLines(img: GrayImage, options: RemoveLinesOptions = {}): RemoveLinesResult {
  const { width: w, height: h } = img;
  const minH = Math.max(24, Math.round(w * (options.minHorizontalRatio ?? 1 / 10)));
  const minV = Math.max(24, Math.round(h * (options.minVerticalRatio ?? 1 / 12)));
  // 平均を取る範囲は「文字の太さ・罫線の太さより十分大きい」値にする(ページ幅に比例)
  const boxRadius = Math.max(10, Math.round(Math.min(w, h) / 60));
  const ink = buildInkMask(img, boxRadius, 15);

  const maxThickness = Math.max(8, Math.round(Math.min(w, h) * (options.maxThicknessRatio ?? 1 / 100)));

  const mark = new Uint8Array(w * h);
  markHorizontalRuns(ink, w, h, minH, maxThickness, mark);
  markVerticalRuns(ink, w, h, minV, maxThickness, mark);

  // 罫線のふち(アンチエイリアスの薄い部分)も消すため、1画素分太らせて塗る
  const out = new Uint8Array(img.gray);
  let removed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mark[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (out[yy * w + xx] !== 255) {
            out[yy * w + xx] = 255;
            removed++;
          }
        }
      }
    }
  }
  return { gray: out, removedPixels: removed };
}

/**
 * Canvas版: 罫線を消した新しいCanvasを返す。失敗した場合は元のCanvasをそのまま返す
 * (前処理に失敗してもOCR自体は止めない)。
 */
export function removeRuledLinesFromCanvas(canvas: HTMLCanvasElement, options?: RemoveLinesOptions): HTMLCanvasElement {
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    const { width: w, height: h } = canvas;
    const src = ctx.getImageData(0, 0, w, h);
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = src.data[i * 4];
      const g = src.data[i * 4 + 1];
      const b = src.data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    // 影・照明のムラをならし、紙の傾き(0.4度以上)を直してから、罫線を消す
    const { gray: even, changed } = normalizeIllumination({ width: w, height: h, gray });
    const skew = estimateSkewDegrees({ width: w, height: h, gray: even });
    const straight = Math.abs(skew) >= 0.4 ? deskewGray({ width: w, height: h, gray: even }, skew) : even;
    // 濃い帯の上の白い文字を反転する(straightはevenと同じ配列のことがあるため、コピーに対して行う)
    const prepared = new Uint8Array(straight);
    const inverted = invertDarkBlocks({ width: w, height: h, gray: prepared }, prepared);
    const { gray: cleaned, removedPixels } = removeRuledLines({ width: w, height: h, gray: prepared }, options);
    if (removedPixels === 0 && !changed && straight === even && inverted === 0) return canvas;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const octx = out.getContext("2d");
    if (!octx) return canvas;
    const dst = octx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      dst.data[i * 4] = dst.data[i * 4 + 1] = dst.data[i * 4 + 2] = cleaned[i];
      dst.data[i * 4 + 3] = 255;
    }
    octx.putImageData(dst, 0, 0);
    return out;
  } catch {
    return canvas;
  }
}
