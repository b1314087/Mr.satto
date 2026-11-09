/**
 * 背景除去(背景透過)。すべてブラウザ内で処理し、画像は外部へ送信しない。
 *
 * 指定した色(白い背景など)に近い部分を透明にする(色指定)。単色の背景なら高速で正確。
 * （AIで背景を判定するモードは、工程2で削除した。AIのモデル・実行ファイルは読み込まない）
 *
 * 色→透明度の計算は純粋な関数に分けてあり、プレビュー(縮小画像)と書き出し(元の解像度)で
 * 同じ関数を使うので、プレビューどおりの結果が出力される。
 */

export type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// 純粋関数(DOM不要)
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 0〜1に滑らかに変化する補間(edge0以下で0、edge1以上で1) */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 2色のRGB距離(0〜約441) */
export function colorDistance(r: number, g: number, b: number, key: RGB): number {
  const dr = r - key[0];
  const dg = g - key[1];
  const db = b - key[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 指定色に近い部分を透明にする。
 * tolerance(0〜100): どこまで近い色を消すか。softness(0〜100): 境界のなだらかさ。
 */
export function applyColorKey(image: ImageData, key: RGB, tolerance: number, softness: number): ImageData {
  const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  applyColorKeyInPlace(out.data, key, tolerance, softness);
  return out;
}

/** applyColorKey と同じ計算を、画像データ（RGBA）に直接書き込む（複製しない。ロードマップC 工程3） */
export function applyColorKeyInPlace(d: Uint8ClampedArray, key: RGB, tolerance: number, softness: number): void {
  const maxDist = Math.sqrt(3 * 255 * 255);
  const cut = (tolerance / 100) * maxDist;
  const feather = (softness / 100) * maxDist * 0.5;
  for (let i = 0; i < d.length; i += 4) {
    const dist = colorDistance(d[i], d[i + 1], d[i + 2], key);
    const a = feather <= 0 ? (dist <= cut ? 0 : 1) : smoothstep(cut, cut + feather, dist);
    d[i + 3] = Math.round(d[i + 3] * a);
  }
}

/** estimateBackgroundColor と同じ計算を、RGBAの配列と大きさから行う（Worker の中で使う） */
export function estimateBackgroundColorOf(data: Uint8ClampedArray, width: number, height: number): RGB {
  return estimateBackgroundColor({ data, width, height } as ImageData);
}

/** 画像の四隅の平均色(単色背景の色を自動で推定するのに使う) */
export function estimateBackgroundColor(image: ImageData): RGB {
  const { width: w, height: h, data } = image;
  const pts: [number, number][] = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  const sum: RGB = [0, 0, 0];
  for (const [x, y] of pts) {
    const i = (y * w + x) * 4;
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
  }
  return [Math.round(sum[0] / 4), Math.round(sum[1] / 4), Math.round(sum[2] / 4)];
}

export function rgbToHex(c: RGB): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// ブラウザ依存(Canvas)
// ---------------------------------------------------------------------------

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** キャンバスを作る（画面では <canvas>、Worker の中では OffscreenCanvas。描き方・結果は同じ） */
function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof document === "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** 書き出しの設定（消す色と、許容する色の差・境界のぼかし） */
export interface RemoveRenderOptions {
  key: RGB | null;
  tolerance: number;
  softness: number;
}

/**
 * 元の解像度で背景を透明にして、PNGにする（画面側・Worker の中のどちらでも同じ計算）。
 * 画像の複製を作らず、読み出した画像データに直接書き込む。使ったキャンバスは最後に手放す。
 * 色指定で key が null のときは、画像の四隅から背景色を推定する（従来と同じ）。
 */
export async function renderRemovedPng(source: CanvasImageSource, width: number, height: number, opts: RemoveRenderOptions): Promise<Blob> {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as AnyCtx | null;
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  try {
    ctx.drawImage(source, 0, 0);
    const full = ctx.getImageData(0, 0, width, height);
    const key = opts.key ?? estimateBackgroundColorOf(full.data, width, height);
    applyColorKeyInPlace(full.data, key, opts.tolerance, opts.softness);
    ctx.putImageData(full, 0, 0);
    if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
      return await canvas.convertToBlob({ type: "image/png" });
    }
    return await new Promise<Blob>((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("画像の書き出しに失敗しました"))), "image/png")
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 書き出し可能な最大ピクセル数(これを超える画像はCanvasで扱えない端末があるため止める) */
export const MAX_REMOVE_PIXELS = 36_000_000;
