"use client";

import { ImageFormatConvertTool } from "./image-format-convert-tool";

/**
 * 画像一括変換（/tools/image-batch-convert）。実装は共通の ImageFormatConvertTool に委譲する
 * （JPG変換・PNG変換・WebP変換のページと同じ画面。出力形式の初期選択だけが違う）。
 */
export function ImageBatchConvertTool() {
  return <ImageFormatConvertTool initialFormat="image/jpeg" />;
}
