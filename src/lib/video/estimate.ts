import { resolutionOptionsFor, type CompressionLevel } from "@/lib/video/shared";

/**
 * 動画ツールのプレビュー用の「出力の目安」を計算する純粋関数群。
 * 実際の変換は行わない（処理ロジックは各Processor・mediabunnyのまま）。
 * サイズは入力動画の情報からの概算で、実際の出力は動画の中身により前後する。
 */

/** 偶数に丸める（動画エンコードは偶数サイズが基本のため） */
function toEven(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/** 短辺を target に縮小した場合の出力解像度（アスペクト比維持） */
export function resizedDimensions(
  width: number,
  height: number,
  shortSideTarget: number
): { width: number; height: number } {
  const opt = resolutionOptionsFor(width, height, shortSideTarget);
  if (opt.width !== undefined) {
    return { width: opt.width, height: toEven((height * opt.width) / width) };
  }
  const h = opt.height ?? shortSideTarget;
  return { width: toEven((width * h) / height), height: h };
}

/** 解像度変更後のおおよそのファイルサイズ（画素数に比例すると仮定） */
export function estimateResizedBytes(
  inputBytes: number,
  inW: number,
  inH: number,
  outW: number,
  outH: number
): number {
  if (inW <= 0 || inH <= 0) return inputBytes;
  return Math.round(inputBytes * Math.min(1, (outW * outH) / (inW * inH)));
}

/** フレームレート変更後のおおよそのファイルサイズ（映像部分がfpsに比例すると仮定） */
export function estimateFrameRateBytes(inputBytes: number, sourceFps: number, targetFps: number): number {
  if (sourceFps <= 0) return inputBytes;
  return Math.round(inputBytes * Math.min(1, targetFps / sourceFps));
}

/** 圧縮レベルごとの、元のサイズに対するおおよその割合の範囲 */
export const COMPRESSION_RATIO_RANGE: Record<CompressionLevel, [number, number]> = {
  low: [0.6, 0.95],
  medium: [0.35, 0.7],
  high: [0.2, 0.45],
};

export function estimateCompressedRange(inputBytes: number, level: CompressionLevel): [number, number] {
  const [lo, hi] = COMPRESSION_RATIO_RANGE[level];
  return [Math.round(inputBytes * lo), Math.round(inputBytes * hi)];
}

/** 秒数を m:ss（1時間以上は h:mm:ss）に整形する */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "-";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
    : `${m}:${s.toString().padStart(2, "0")}`;
}

/** ファイル名の拡張子から入力形式の表示名を作る（例: movie.mov → MOV） */
export function inputFormatLabel(file: File): string {
  const dot = file.name.lastIndexOf(".");
  return dot === -1 ? "動画" : file.name.slice(dot + 1).toUpperCase();
}
