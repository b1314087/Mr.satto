/**
 * 日本語TrueTypeフォント(Noto Sans JP)の読み込み（Phase 2-C / Phase 6で共有化）。
 *
 * 帳票PDF生成（document-pdf.ts）が最初に導入したロジックを、
 * Phase 6のPDFページ番号・PDF透かしツールでも同じフォント資産を再利用できるよう
 * 独立したモジュールに切り出した。新しいフォントファイルは追加していない。
 *
 * ブラウザから1回だけ取得し、以後はモジュール内でキャッシュする。
 */
let fontBytesPromise: Promise<ArrayBuffer> | null = null;

export function loadJapaneseFontBytes(): Promise<ArrayBuffer> {
  if (!fontBytesPromise) {
    fontBytesPromise = fetch("/fonts/NotoSansJP-Regular.ttf")
      .then((res) => {
        if (!res.ok) throw new Error(`font fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .catch((e) => {
        // 失敗時は次回の呼び出しで再取得できるようキャッシュをリセットする
        fontBytesPromise = null;
        throw e;
      });
  }
  return fontBytesPromise;
}
