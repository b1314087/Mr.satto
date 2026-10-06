/**
 * 背景除去(背景透過)。すべてブラウザ内で処理し、画像は外部へ送信しない。
 *
 * - AIモード: U²-Net(軽量版 u2netp, Apache-2.0)をonnxruntime-web(MIT)のWebAssemblyで実行し、
 *   「前景らしさ」のマスクを作る。モデル(約4.5MB)と実行ファイル(約14MB)は自サイトの
 *   /models と /ort から読み込む(初回のみダウンロードされ、以後はブラウザにキャッシュされる)。
 * - 色指定モード: 指定した色(白い背景など)に近い部分を透明にする。単色の背景なら高速で正確。
 *
 * マスク→透明度の計算は純粋な関数に分けてあり、プレビュー(縮小画像)と書き出し(元の解像度)で
 * 同じ関数を使うので、プレビューどおりの結果が出力される。
 */

export const MODEL_URL = "/models/u2netp.onnx";
export const ORT_BASE_URL = "/ort/";
export const MODEL_INPUT_SIZE = 320;

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

/**
 * AIマスク(0〜255、255=前景)を透明度へ変換して画像データのαに書き込む。
 * threshold(0〜1): どこから前景とみなすか。大きいほど背景として消える範囲が広がる。
 * softness(0〜1): 境界のぼかし幅。0で硬い境界。
 */
export function applyMaskToImage(
  image: ImageData,
  mask: Uint8ClampedArray,
  threshold: number,
  softness: number
): ImageData {
  if (mask.length !== image.width * image.height) throw new Error("マスクのサイズが画像と一致しません");
  const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const half = Math.max(0, Math.min(1, softness)) / 2;
  const lo = threshold - half;
  const hi = threshold + half;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i] / 255;
    const a = softness <= 0 ? (m >= threshold ? 1 : 0) : smoothstep(lo, hi, m);
    out.data[i * 4 + 3] = Math.round(out.data[i * 4 + 3] * a);
  }
  return out;
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
  const maxDist = Math.sqrt(3 * 255 * 255);
  const cut = (tolerance / 100) * maxDist;
  const feather = (softness / 100) * maxDist * 0.5;
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = colorDistance(d[i], d[i + 1], d[i + 2], key);
    const a = feather <= 0 ? (dist <= cut ? 0 : 1) : smoothstep(cut, cut + feather, dist);
    d[i + 3] = Math.round(d[i + 3] * a);
  }
  return out;
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

/**
 * モデル入力用の前処理。RGBA(320×320)→ NCHW・float32。
 * U²-Netの学習時と同じく、最大値で割ってからImageNetの平均・標準偏差で正規化する。
 */
export function preprocessForModel(rgba: Uint8ClampedArray, size: number = MODEL_INPUT_SIZE): Float32Array {
  const pixels = size * size;
  let max = 0;
  for (let i = 0; i < pixels; i++) {
    max = Math.max(max, rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  if (max === 0) max = 1;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * pixels + i] = (rgba[i * 4 + c] / max - mean[c]) / std[c];
    }
  }
  return out;
}

/** モデル出力を最小〜最大で0〜255へ正規化する */
export function normalizeMaskOutput(output: ArrayLike<number>): Uint8ClampedArray {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < output.length; i++) {
    const v = output[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const out = new Uint8ClampedArray(output.length);
  for (let i = 0; i < output.length; i++) out[i] = Math.round(((output[i] - min) / range) * 255);
  return out;
}

// ---------------------------------------------------------------------------
// ブラウザ依存(onnxruntime-web / Canvas)
// ---------------------------------------------------------------------------

type OrtModule = typeof import("onnxruntime-web/wasm");
type OrtSession = import("onnxruntime-web/wasm").InferenceSession;

let sessionPromise: Promise<{ ort: OrtModule; session: OrtSession }> | null = null;

async function createSession() {
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = {
    mjs: `${ORT_BASE_URL}ort-wasm-simd-threaded.mjs`,
    wasm: `${ORT_BASE_URL}ort-wasm-simd-threaded.wasm`,
  };
  // 複数スレッドにはcross-origin isolation(SharedArrayBuffer)が必要になるため、1スレッドで動かす
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error("背景除去モデルの読み込みに失敗しました");
  const buffer = await res.arrayBuffer();
  const session = await ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
  return { ort, session };
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = createSession().catch((e) => {
      sessionPromise = null; // 失敗したら次回やり直せるようにする
      throw e;
    });
  }
  return sessionPromise;
}

/** 画像からAIマスク(320×320・0〜255)を推論する */
export async function predictMask(source: CanvasImageSource): Promise<Uint8ClampedArray> {
  const size = MODEL_INPUT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  ctx.drawImage(source, 0, 0, size, size);
  const input = preprocessForModel(ctx.getImageData(0, 0, size, size).data, size);

  const { ort, session } = await getSession();
  const tensor = new ort.Tensor("float32", input, [1, 3, size, size]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const output = results[session.outputNames[0]];
  return normalizeMaskOutput(output.data as Float32Array);
}

/** 320×320のマスクを、指定サイズへなめらかに拡大する(1ピクセル1値) */
export function upscaleMask(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const size = MODEL_INPUT_SIZE;
  const small = document.createElement("canvas");
  small.width = size;
  small.height = size;
  const sctx = small.getContext("2d");
  const big = document.createElement("canvas");
  big.width = width;
  big.height = height;
  const bctx = big.getContext("2d", { willReadFrequently: true });
  if (!sctx || !bctx) throw new Error("Canvasの初期化に失敗しました");
  const img = sctx.createImageData(size, size);
  for (let i = 0; i < mask.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = mask[i];
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(small, 0, 0, width, height);
  const data = bctx.getImageData(0, 0, width, height).data;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
  return out;
}

/** 書き出し可能な最大ピクセル数(これを超える画像はCanvasで扱えない端末があるため止める) */
export const MAX_REMOVE_PIXELS = 36_000_000;
