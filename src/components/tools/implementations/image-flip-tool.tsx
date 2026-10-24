"use client";

import { ImageRotateFlipTool } from "./image-rotate-flip-tool";

/**
 * 画像反転（/tools/image-flip）。実装は共通の ImageRotateFlipTool に委譲する
 * （画像回転のページと同じ画面。操作の初期モードだけが違う）。
 */
export function ImageFlipTool() {
  return <ImageRotateFlipTool initialMode="flip" />;
}
