import type { Plan } from "@/lib/plans/types";
import { featureFlags } from "@/lib/config/features";

/**
 * 複数ファイルの一括処理（Premium 一括処理の工程）の設定。
 *
 * - 一括処理（同じ処理を複数のファイルにまとめてかける）は、プレミアムプランの機能。
 *   無料・旧スタンダードでも、1ファイルずつの処理はこれまでどおり使える（単体処理は制限しない）。
 * - 課金の機能スイッチがオフ（プランが存在しない状態）の間は、だれでも一括処理を使える
 *   （プレミアムに加入する手段がないのに、機能だけを閉じないため）。
 * - 複数のファイルを1つにまとめるツール（PDF結合・画像結合・ZIP作成など）は一括処理ではないため、ここでは扱わない。
 *
 * 処理はすべてブラウザの中で、1ファイルずつ順番に行う（src/lib/batch/run-batch.ts）。
 */

/**
 * 一度に処理できるファイル数の上限（ツールごと）。
 * 1ファイルずつ順番に処理し、すべてを同時にメモリへ読み込むことはないが、
 * 処理結果は保存（ダウンロード）されるまで画面の中に残るため、重い処理ほど少なくしている。
 */
export const BATCH_LIMITS = {
  // 画像（1枚あたりの処理が軽く、結果も小さい）
  // 工程3：画像リサイズは画像圧縮に統合した（「画像リサイズ・圧縮」。この設定を使う）
  "image-compress": 50,
  // JPG変換・PNG変換・WebP変換・画像一括変換のページも、この設定を使う（同じ画面のため）
  "image-format-convert": 50,
  "image-adjust": 50,
  "image-padding-text": 50,
  "image-padding": 50,
  // 元の解像度で全画素を計算するため、1枚ごとの処理が重い（工程2でAIのモードは削除した）
  "background-remover": 20,
  // PDF（1ファイルが大きく、処理にも時間がかかる）
  "pdf-compress": 20,

  // 2026-11 料金プランの見直し：プレミアムの一括処理を15ツールに追加
  // 1回50枚（画像1枚ずつの処理が軽い。PDF→画像は1つのPDFから複数の画像ができるが、描画は1ページずつ）
  "pdf-to-image": 50,
  "image-crop": 50,
  "image-rotate-flip": 50,
  "image-metadata-remove": 50,
  "image-watermark": 50,
  // 1回30枚（1枚から多数の画像ができる・全画素を計算するため重め）
  "image-tile-split": 30,
  "image-mosaic": 30,
  // 1回20ファイル
  "pdf-fix": 20,
  // 1回10ファイル（変換・暗号化などで、1ファイルあたりの処理が重い）
  "word-to-pdf": 10,
  "excel-to-pdf": 10,
  "pdf-password-protect": 10,
  "pdf-resize-pages": 10,
  "pdf-metadata-remove": 10,
  "pdf-crop-pages": 10,
  "file-unzip": 10,
} as const satisfies Record<string, number>;

export type BatchToolKey = keyof typeof BATCH_LIMITS;

export function getBatchLimit(key: BatchToolKey): number {
  return BATCH_LIMITS[key];
}

/**
 * このプランで一括処理を使えるか（表示の出し分け用）。
 * 処理を始める直前には、サーバーでも確認する（src/lib/batch/batch-access-actions.ts）。
 */
export function canUseBatch(plan: Plan | null): boolean {
  if (!featureFlags.billing) return true;
  return plan === "premium";
}
