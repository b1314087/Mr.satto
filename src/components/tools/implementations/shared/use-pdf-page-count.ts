"use client";

import { useEffect, useState } from "react";
import { getPdfPageCount } from "@/lib/processors/browser/pdf";

/**
 * 選んだPDFのページ数をブラウザ内で読み取る（PDFページ削除・抽出・並べ替え・分割で共用）。
 * 読み込みの結果は「どのファイルの結果か」を一緒に持ち、いまのファイルと違う古い結果は返さない。
 * そのため、ファイルを差し替えたときの状態リセット用のeffectは要らない。
 */
export function usePdfPageCount(file: File | null): { pageCount: number | null; loadError: string | null } {
  const [loaded, setLoaded] = useState<{ file: File; pageCount: number | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setLoaded({ file, pageCount: count, error: null });
      })
      .catch((e) => {
        if (!cancelled) {
          setLoaded({ file, pageCount: null, error: e instanceof Error ? e.message : "PDFの読み込みに失敗しました" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!file || !loaded || loaded.file !== file) return { pageCount: null, loadError: null };
  return { pageCount: loaded.pageCount, loadError: loaded.error };
}
