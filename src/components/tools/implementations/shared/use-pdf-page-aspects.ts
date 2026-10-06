"use client";

import { useEffect, useState } from "react";
import { getPdfjs } from "@/lib/pdf/pdfjs-client";

/**
 * PDFの各ページの縦横比(高さ/幅。ページの回転込み)を先頭 maxPages ページ分だけ返すフック。
 * 描画はしないので軽い。回転プレビューで、90°/270°回転したページを枠に収める縮小率の計算に使う。
 * 読み込めない場合は空のままで、呼び出し側は既定値で表示する(プレビュー専用のため失敗は無視)。
 */
export function usePdfPageAspects(file: File | null, maxPages = 40): Record<number, number> {
  const [state, setState] = useState<{ file: File; ratios: Record<number, number> } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let destroy: (() => Promise<void>) | null = null;
    (async () => {
      try {
        const pdfjs = await getPdfjs();
        const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
        destroy = () => task.destroy();
        const pdf = await task.promise;
        const ratios: Record<number, number> = {};
        const limit = Math.min(pdf.numPages, maxPages);
        for (let n = 1; n <= limit; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          ratios[n] = viewport.height / viewport.width;
        }
        if (!cancelled) setState({ file, ratios });
      } catch {
        // プレビュー専用。失敗しても本処理には影響しない
      }
    })();
    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [file, maxPages]);

  if (!file || !state || state.file !== file) return {};
  return state.ratios;
}
