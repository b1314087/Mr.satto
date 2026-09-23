/**
 * Phase 1 で実際に動作する（"available"）ツールIDの一覧。
 * サーバー・クライアント双方から参照できるよう、
 * "use client" を付けないプレーンなモジュールに分離している。
 */
export const AVAILABLE_TOOL_IDS: string[] = [
  "image-resize",
  "image-compress",
  "image-compress-to-size",
  "image-jpg-convert",
  "image-png-convert",
  "image-webp-convert",
  "image-rotate",
  "qr-generator",
  "business-card-qr",
  "password-generator",
  "char-count",
  "json-formatter",
  "csv-format",
  "pomodoro-timer",
  "color-palette-generator",
];

export function hasImplementation(toolId: string): boolean {
  return AVAILABLE_TOOL_IDS.includes(toolId);
}
