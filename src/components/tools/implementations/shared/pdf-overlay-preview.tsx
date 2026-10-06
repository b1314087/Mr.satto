"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { PDFFont } from "pdf-lib";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { loadPdfDoc } from "@/lib/processors/browser/pdf";

export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ページの大きさ・表示範囲・回転(PDFの座標。単位pt・原点は左下) */
export interface PageGeometry {
  media: PdfBox;
  crop: PdfBox;
  /** PDF側のページ回転(時計回りの度数) */
  rotate: 0 | 90 | 180 | 270;
}

/** 先頭 maxPages ページの大きさ・回転を読み取る(pdf-lib。ブラウザ内で処理)。ファイルが変わると読み直す */
export function usePdfPageGeometry(
  file: File | null,
  maxPages: number
): { pageCount: number; pages: Record<number, PageGeometry> } | null {
  const [state, setState] = useState<{ file: File; pageCount: number; pages: Record<number, PageGeometry> } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    loadPdfDoc(file)
      .then((doc) => {
        const pages: Record<number, PageGeometry> = {};
        const all = doc.getPages();
        all.slice(0, maxPages).forEach((page, i) => {
          const angle = (((page.getRotation().angle % 360) + 360) % 360) as number;
          pages[i + 1] = {
            media: page.getMediaBox(),
            crop: page.getCropBox(),
            rotate: angle === 90 || angle === 180 || angle === 270 ? angle : 0,
          };
        });
        if (!cancelled) setState({ file, pageCount: all.length, pages });
      })
      .catch(() => {
        if (!cancelled) setState({ file, pageCount: 0, pages: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [file, maxPages]);

  if (!file || !state || state.file !== file) return null;
  return { pageCount: state.pageCount, pages: state.pages };
}

/** pdf-libのフォントを非同期で読み込むフック(失敗したら failed=true) */
export function usePdfFont(loader: () => Promise<PDFFont>): { font: PDFFont | null; failed: boolean } {
  const [state, setState] = useState<{ font: PDFFont | null; failed: boolean }>({ font: null, failed: false });
  useEffect(() => {
    let cancelled = false;
    loader()
      .then((font) => {
        if (!cancelled) setState({ font, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ font: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [loader]);
  return state;
}

/**
 * PDFページのサムネイルの上に、PDFの座標(pt・原点左下)で図形・文字を重ねて表示する。
 * children にはSVGの中身を返す。viewBoxはページの表示範囲(CropBox)に合わせてあり、
 * ページ回転があっても向きを合わせて重ねる。sy(y) はPDFのy座標→SVGのy座標の変換。
 * ツール本体の出力と同じ計算(lib/pdf/overlay-layout)の結果を渡すことで、位置が一致する。
 */
export function PdfOverlayPreview({
  file,
  pages = [1],
  width = 200,
  title = "仕上がりのプレビュー",
  caption,
  children,
}: {
  file: File;
  /** 表示するページ(1始まり) */
  pages?: number[];
  width?: number;
  title?: string;
  caption?: ReactNode;
  children: (info: { page: number; geometry: PageGeometry; sy: (y: number) => number }) => ReactNode;
}) {
  const maxPage = Math.max(...pages);
  const geo = usePdfPageGeometry(file, maxPage);
  const shown = geo ? pages.filter((n) => n <= geo.pageCount) : [pages[0]];

  return (
    <div data-testid="tool-preview" className="flex flex-col gap-2">
      <PdfThumbnails
        file={file}
        pages={shown.length > 0 ? shown : [1]}
        maxPages={maxPage}
        width={width}
        title={title}
        overlay={(n) => {
          const g = geo?.pages[n];
          if (!g) return null;
          const swap = g.rotate === 90 || g.rotate === 270;
          const scale = (width - 2) / (swap ? g.crop.height : g.crop.width);
          const top = g.media.y + g.media.height;
          const content = children({ page: n, geometry: g, sy: (y) => top - y });
          return (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: g.crop.width * scale,
                  height: g.crop.height * scale,
                  transform: `translate(-50%, -50%) rotate(${g.rotate}deg)`,
                }}
              >
                <svg
                  viewBox={`${g.crop.x} ${top - (g.crop.y + g.crop.height)} ${g.crop.width} ${g.crop.height}`}
                  width="100%"
                  height="100%"
                  style={{ display: "block" }}
                >
                  {content}
                </svg>
              </div>
            </div>
          );
        }}
      />
      {caption && <div className="text-xs text-neutral-500 dark:text-neutral-400">{caption}</div>}
    </div>
  );
}
