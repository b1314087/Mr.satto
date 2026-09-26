import { PDFDocument, PDFPage, PDFString } from "pdf-lib";

/**
 * PDFへ「クリックできるリンク」を追加する小さな共通ヘルパー（Phase 9）。
 *
 * pdf-lib には drawText 等と同じ高レベルAPIとしてのリンク注釈作成機能が
 * 無いため、PDF仕様上のLink annotation（/Subtype /Link, /A << /S /URI >>）を
 * 低レベルAPI（doc.context.obj / page.node.addAnnot）で直接組み立てる。
 * これはpdf-libのコア機能（PDFDict/PDFArray/PDFString等）のみを使った
 * 標準的な手法であり、新しい依存ライブラリは必要ない。
 *
 * 注意: context.obj() は素のJS文字列を渡すと PDFName として解釈してしまう
 * （PDF上の「名前」構文用のエスケープになり、URLとしては壊れる）ため、
 * URIの値は必ず PDFString.of() で明示的に包む。
 */
export function addLinkAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  url: string,
  rect: { x: number; y: number; width: number; height: number }
): void {
  const annotRef = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFString.of(url),
      },
    })
  );
  page.node.addAnnot(annotRef);
}
