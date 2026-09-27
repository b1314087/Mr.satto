import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * OGP画像生成（next/ogのImageResponse）で使う日本語対応フォント(Noto Sans JP)の
 * サーバー側ローダー（Phase 21）。
 *
 * 既存の src/lib/pdf/japanese-font.ts は「ブラウザから相対URLでfetchする」実装で、
 * クライアント側のPDF生成専用に作られている（相対URLのfetchはNode.jsの
 * サーバー側実行では動かない）。opengraph-image.tsx はビルド時・サーバー側で
 * 実行されるNext.jsの特殊ファイルのため、Node.jsのfs経由でpublic/配下の
 * 同じフォント資産をそのまま再利用する、専用の読み込み口をここに用意する
 * （フォントファイル自体は新規追加していない。新規npmパッケージも追加していない）。
 *
 * ImageResponse に明示的にfontsを渡さない場合、Satoriの既定フォントには
 * 日本語グリフが含まれず、日本語テキストが空の四角（tofu）として描画される
 * ことをPhase 21の調査で確認済み（既存の src/app/opengraph-image.tsx で発生していた
 * 実際のバグ）。このローダーはその修正のために追加した。
 */
let fontDataPromise: Promise<Buffer> | null = null;

export function loadJapaneseOgFontData(): Promise<Buffer> {
  if (!fontDataPromise) {
    fontDataPromise = readFile(path.join(process.cwd(), "public/fonts/NotoSansJP-Regular.ttf")).catch((e) => {
      // 失敗時は次回の呼び出しで再読み込みできるようキャッシュをリセットする
      fontDataPromise = null;
      throw e;
    });
  }
  return fontDataPromise;
}
