"use client";

import { useEffect, useState } from "react";
import { ImageSnsSizeTool } from "./image-sns-size-tool";
import { ImageCropTool } from "./image-crop-tool";
import { ImagePassportPhotoTool } from "./image-passport-photo-tool";

/**
 * 画像トリミング・SNSサイズ・証明写真（工程3で、SNSサイズ変換（旧 image-sns-size）・画像トリミング（image-crop）・
 * 証明写真サイズ変換（旧 image-passport-photo）を1つにまとめた画面）。
 *
 * 目的（SNSサイズ／自由トリミング／証明写真）を画面上のボタンで選ぶと、その目的に必要な設定だけを出す。
 * 各目的の中身は、これまでのツールの画面をそのまま使う（プリセット・寸法・プレビュー・書き出しは変えない）。
 * - 目的を切り替えると、前の目的の画像・設定・結果はリセットされる（古い結果をダウンロードさせない）。
 * - 旧「SNSサイズ変換」「証明写真サイズ変換」のアドレスからの転送（?mode=sns / ?mode=passport）では、
 *   その目的を選んだ状態で開く。直接開いたときは、これまでの画像トリミングと同じ「自由トリミング」から始める。
 * 処理はすべてブラウザ内で行い、画像は送信しない。
 */

export type ImageTrimMode = "sns" | "crop" | "passport";

export const IMAGE_TRIM_MODES: { mode: ImageTrimMode; label: string; description: string; formerToolId: string }[] = [
  {
    mode: "sns",
    label: "SNSサイズ",
    description: "Instagram・X・YouTubeなど、SNSでよく使う大きさ（正方形・縦長・横長・ストーリー）に合わせて切り抜きます。",
    formerToolId: "image-sns-size",
  },
  {
    mode: "crop",
    label: "自由トリミング",
    description: "画像の必要な部分だけを、ドラッグや縦横比の指定で切り抜きます。",
    formerToolId: "image-crop",
  },
  {
    mode: "passport",
    label: "証明写真",
    description: "30×40mmなどの証明写真の寸法に合わせて切り抜き、画像として保存したり、A4用紙にまとめてPDFで印刷したりできます。",
    formerToolId: "image-passport-photo",
  },
];

const DEFAULT_MODE: ImageTrimMode = "crop";

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function ImageTrimTool() {
  const [mode, setMode] = useState<ImageTrimMode>(DEFAULT_MODE);
  const info = IMAGE_TRIM_MODES.find((m) => m.mode === mode) ?? IMAGE_TRIM_MODES[1];

  // 旧アドレスから転送されてきたとき（?mode=sns / ?mode=passport）は、その目的を最初から選んでおく
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("mode");
    const found = IMAGE_TRIM_MODES.find((m) => m.mode === fromUrl);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (found) setMode(found.mode);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="画像の目的" data-testid="image-trim-modes" className="flex flex-wrap gap-2">
          {IMAGE_TRIM_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`image-trim-mode-${m.mode}`}
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="image-trim-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
      </div>

      {/* key: 目的を切り替えたら、前の目的の状態（画像・設定・結果）を必ず捨てて作り直す */}
      <div key={mode}>
        {mode === "sns" && <ImageSnsSizeTool />}
        {mode === "crop" && <ImageCropTool />}
        {mode === "passport" && <ImagePassportPhotoTool />}
      </div>
    </div>
  );
}
