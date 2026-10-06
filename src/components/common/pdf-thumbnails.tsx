"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { getPdfjs } from "@/lib/pdf/pdfjs-client";

export interface PdfThumbnailState {
  pageCount: number | null;
  /** ページ番号(1始まり)→サムネイルのdata URL。描画できたものから順に入る */
  urls: Record<number, string>;
  loading: boolean;
  error: string | null;
}

/**
 * PDFのページをサムネイル画像にして返すフック(pdfjs-dist。ブラウザ内で処理)。
 * 重くならないよう、先頭から maxPages ページまでを順番に描画する。
 * ファイルが変わると自動でやり直す。パスワード付きPDFは「開けない」と表示する。
 */
export function usePdfThumbnails(file: File | null, maxPages = 24, width = 140): PdfThumbnailState {
  const [state, setState] = useState<{ file: File; pageCount: number; urls: Record<number, string>; done: boolean; error: string | null } | null>(null);

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
        if (cancelled) return;
        setState({ file, pageCount: pdf.numPages, urls: {}, done: false, error: null });
        const limit = Math.min(pdf.numPages, maxPages);
        for (let n = 1; n <= limit; n++) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: width / base.width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvasの初期化に失敗しました");
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          const url = canvas.toDataURL("image/jpeg", 0.8);
          setState((cur) => (cur && cur.file === file ? { ...cur, urls: { ...cur.urls, [n]: url } } : cur));
        }
        if (!cancelled) setState((cur) => (cur && cur.file === file ? { ...cur, done: true } : cur));
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : "";
        setState({
          file,
          pageCount: 0,
          urls: {},
          done: true,
          error: /password/i.test(message)
            ? "パスワード保護されたPDFのため、プレビューを表示できません"
            : "プレビューを作成できませんでした(PDFが破損している可能性があります)",
        });
      }
    })();
    return () => {
      cancelled = true;
      void destroy?.();
    };
  }, [file, maxPages, width]);

  if (!file) return { pageCount: null, urls: {}, loading: false, error: null };
  if (!state || state.file !== file) return { pageCount: null, urls: {}, loading: true, error: null };
  return { pageCount: state.error ? null : state.pageCount, urls: state.urls, loading: !state.done, error: state.error };
}

/**
 * PDFのページのサムネイル一覧。ツールごとの見せ方(回転・削除予定・並び順・選択など)は
 * pageStyle / overlay / order で指定する。
 */
export function PdfThumbnails({
  file,
  maxPages = 24,
  width = 140,
  pages,
  pageStyle,
  overlay,
  onPageClick,
  title = "ページのプレビュー",
  className = "",
}: {
  file: File | null;
  maxPages?: number;
  width?: number;
  /** 表示するページ(1始まり)。省略すると先頭から順に全部 */
  pages?: number[];
  /** サムネイル画像に当てるスタイル(回転: transform など) */
  pageStyle?: (pageNumber: number) => CSSProperties | undefined;
  /** サムネイルの上に重ねる表示(バッジ・取り消し線など) */
  overlay?: (pageNumber: number) => ReactNode;
  onPageClick?: (pageNumber: number) => void;
  title?: string;
  className?: string;
}) {
  const { pageCount, urls, loading, error } = usePdfThumbnails(file, maxPages, width);
  if (!file) return null;
  const list = pages ?? Array.from({ length: Math.min(pageCount ?? 0, maxPages) }, (_, i) => i + 1);

  return (
    <section aria-label={title} data-testid="pdf-thumbnails" className={`flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800 ${className}`}>
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {title}
        {pageCount ? `(全${pageCount}ページ)` : ""}
      </p>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loading && pageCount === null && !error && <p className="text-xs text-neutral-400">読み込み中…</p>}
      <ul className="flex flex-wrap gap-3">
        {list.map((n) => (
          <li key={n} className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={onPageClick ? () => onPageClick(n) : undefined}
              disabled={!onPageClick}
              aria-label={`ページ${n}`}
              className="relative flex items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-700"
              style={{ width, minHeight: Math.round(width * 1.2) }}
            >
              {urls[n] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={urls[n]} alt={`ページ${n}のプレビュー`} data-testid="pdf-thumb" style={pageStyle?.(n)} className="h-auto w-full transition-transform" />
              ) : (
                <span className="text-xs text-neutral-300">…</span>
              )}
              {overlay?.(n)}
            </button>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{n}</span>
          </li>
        ))}
      </ul>
      {pageCount !== null && pageCount > maxPages && !pages && (
        <p className="text-xs text-neutral-400">先頭{maxPages}ページのみ表示しています(全{pageCount}ページ)</p>
      )}
    </section>
  );
}
