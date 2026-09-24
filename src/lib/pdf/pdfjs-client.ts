/**
 * 共通PDF解析基盤（Phase 2-D ■21）。
 *
 * pdfjs-dist の読み込み・PDFドキュメントの読み込み・座標付きテキスト取得を
 * ここに集約し、OCR / PDF→Excel / PDF→Word / 既存のPDF→画像・PDF→テキスト
 * （Phase 2-A/B, src/lib/processors/browser/pdf-render.ts）が共通で利用する。
 *
 * 既存Phase 2-A/Bの動作を変えないよう、getPdfjs()/loadPdfDocument() は
 * pdf-render.ts に元々あったものをそのまま移設しただけで、ロジックは
 * 変更していない。
 */

let pdfjsLibPromise: ReturnType<typeof importPdfjs> | null = null;

/**
 * pdfjs-dist は比較的重いライブラリのため、実際に使われるまで読み込まない
 * （動的import）。Workerの参照先は public/pdf.worker.min.mjs に配置した
 * 静的ファイルとし、バンドラー依存のアセット解決に頼らない。
 *
 * バージョンは意図的に最新(6.x)ではなく 4.10.38 に固定している
 * （6.x系が前提とする `Map.prototype.getOrInsertComputed` を
 *  サポートしないブラウザで実行時エラーになることを実機検証で確認したため）。
 */
async function importPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjsLib;
}

export function getPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = importPdfjs();
  }
  return pdfjsLibPromise;
}

/**
 * PDFの読み込みエラーを日本語の分かりやすいメッセージへ変換する共通ヘルパー。
 * OCR / PDF→Excel / PDF→Word / PDF→画像 / PDF→テキストが同じ
 * pdfjs-dist の getDocument() を使うため、エラーハンドリングを共通化している。
 */
export async function loadPdfDocument(file: File) {
  const pdfjsLib = await getPdfjs();
  const bytes = await file.arrayBuffer();
  try {
    return await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/password/i.test(message)) {
      throw new Error(
        "パスワード保護されたPDFは処理できません。パスワードを解除してから再度お試しください。"
      );
    }
    throw new Error(
      `${file.name} の読み込みに失敗しました。PDFファイルが破損している可能性があります。`
    );
  }
}

/** pdfjsの1ページの型（動的importのため具体型を直接importせずダック typing で扱う） */
export type PdfjsPage = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfDocument>>["getPage"]>>;

/**
 * 座標付きのテキスト断片（PDF→Excel / PDF→Word / OCRのテキストPDF判定が共通で使う）。
 *
 * x, y は PDF のページ座標系（原点は左下、上方向が正）。
 * fontHeight は変換行列から推定したおおよそのフォントサイズで、
 * 行のグルーピング（許容誤差の基準）や見出し判定に使う。
 */
export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontHeight: number;
  hasEOL: boolean;
}

/**
 * ページからテキストを座標付きで取得する。
 * PDF→Excelの表構造推定・PDF→Wordの段落構造推定・OCRでの
 * 「文字情報を持つPDFかどうか」判定のすべてがこれを共通利用する。
 */
export async function getPositionedTextItems(page: PdfjsPage): Promise<PositionedTextItem[]> {
  const textContent = await page.getTextContent();
  const items: PositionedTextItem[] = [];
  for (const item of textContent.items) {
    if (!("str" in item)) continue;
    const transform = item.transform as number[];
    const [a, b, c, d, e, f] = transform;
    // 回転がない一般的なテキストでは transform[3](d) がフォントの縦スケールに
    // 相当するが、回転・斜体等でも崩れにくいよう (c,d) の大きさから推定する。
    const fontHeight = Math.hypot(c, d) || Math.hypot(a, b) || item.height || 1;
    items.push({
      str: item.str,
      x: e,
      y: f,
      width: item.width,
      height: item.height || fontHeight,
      fontHeight,
      hasEOL: Boolean(item.hasEOL),
    });
  }
  return items;
}

/** そのページに実質的なテキスト（空白以外の文字）があるか */
export function pageHasText(items: PositionedTextItem[]): boolean {
  return items.some((item) => item.str.trim().length > 0);
}
