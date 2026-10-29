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
    const { gray: cleaned, removedPixels } = removeRuledLines({ width: w, height: h, gray }, options);
    if (removedPixels === 0) return canvas;
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
