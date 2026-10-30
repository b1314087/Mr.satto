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
  /**
   * 以下はPDF→Word（書式の再現）用の付加情報。取得できた場合だけ入る。
   * PDF→Excel等、これらを使わない処理には影響しない。
   */
  /** pdfjs内部のフォントID（getFontStyles でフォントの太字・斜体などを引くのに使う） */
  fontName?: string;
  bold?: boolean;
  italic?: boolean;
  /** 明朝系（セリフ）フォントか */
  serif?: boolean;
  /** 等幅フォントか */
  mono?: boolean;
  /** 文字色（"RRGGBB"）。黒または判別できない場合は未設定 */
  color?: string;
  /** この文字がリンク（ハイパーリンク）の範囲内にあるときのURL */
  link?: string;
}

/**
 * PDFから取り出した文字の、見た目は同じだが別の文字コードになっているものを、普通の文字に直す。
 * 一部のPDF(Chrome等で印刷したもの)では、「会」「日」「月」「金」などの漢字が
 * 「康熙部首」(U+2F00〜2FDF。例: ⽇ ⽉ ⾦ ⽅)や「CJK部首補助」(U+2E80〜2EFF)という
 * 見た目がそっくりな別の文字として入っており、Excelに貼ると検索や並べ替えで
 * 普通の漢字と一致しなくなる。対応する漢字に直す(この範囲の文字だけ)。
 * また、中黒に似た「ハイフネーションポイント」(U+2027)は「・」に直す。
 */
// CJK部首補助(U+2E80〜2EFF)は、NFKC正規化では普通の漢字に直らない(対応表が無い)ため、
// 日本語の書類で実際に出てくる、見た目が同じ漢字の対応を自前で持つ。
const CJK_RADICAL_SUPPLEMENT_TO_KANJI: Record<string, string> = {
  "\u2e9c": "日", "\u2e9d": "月", "\u2e9f": "母", "\u2ea0": "民", "\u2ebc": "月",
  "\u2ec1": "虎", "\u2ec3": "西", "\u2ec4": "西", "\u2eca": "足", "\u2ed1": "長",
  "\u2ed2": "長", "\u2ed7": "雨", "\u2ed8": "青", "\u2ee1": "頁", "\u2ee3": "骨",
  "\u2ee4": "鬼", "\u2ee8": "麦", "\u2ee9": "黄", "\u2eed": "歯", "\u2eef": "竜",
  "\u2ef2": "亀",
};

export function normalizeExtractedText(text: string): string {
  if (!/[\u2e80-\u2fdf\u2027]/.test(text)) return text;
  return text
    .replace(/[\u2e80-\u2fdf]/g, (ch) => CJK_RADICAL_SUPPLEMENT_TO_KANJI[ch] ?? ch.normalize("NFKC"))
    .replace(/\u2027/g, "・");
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
      str: normalizeExtractedText(item.str),
      x: e,
      y: f,
      width: item.width,
      height: item.height || fontHeight,
      fontHeight,
      hasEOL: Boolean(item.hasEOL),
      fontName: typeof item.fontName === "string" ? item.fontName : undefined,
    });
  }
  return items;
}

/** そのページに実質的なテキスト（空白以外の文字）があるか */
export function pageHasText(items: PositionedTextItem[]): boolean {
  return items.some((item) => item.str.trim().length > 0);
}

/**
 * ページをcanvasへ描画する共通ヘルパー（Phase 18で新設）。
 * OCR用のページ画像化（filled-pdf-to-excel.ts, pdf-fill-annotate-template等）や
 * PDF→画像で個別に実装されていたcanvas生成処理のうち、今回新しく追加する
 * テンプレートモードの実装から共通利用する。既存の各Processorは、動作中の
 * コードへの不要な変更を避けるため、今回はこちらへの移行を行っていない。
 *
 * longestSideMax を指定すると、ページの長辺がその値を超えないよう
 * scale を自動的に縮小する（スマートフォン等でのメモリ超過を防ぐ、
 * 開発指示書40章のパフォーマンス方針）。
 */
export interface RenderedPageCanvas {
  canvas: HTMLCanvasElement;
  /** 実際に描画へ使ったスケール（longestSideMaxにより要求値から縮小された場合がある） */
  scale: number;
}

export async function renderPageToCanvas(
  page: PdfjsPage,
  scale: number,
  longestSideMax?: number
): Promise<RenderedPageCanvas> {
  let effectiveScale = scale;
  if (longestSideMax) {
    const base = page.getViewport({ scale });
    const longest = Math.max(base.width, base.height);
    if (longest > longestSideMax) {
      effectiveScale = scale * (longestSideMax / longest);
    }
  }
  const viewport = page.getViewport({ scale: effectiveScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new Error("Canvasの初期化に失敗しました");
  await page.render({ canvasContext, viewport }).promise;
  return { canvas, scale: effectiveScale };
}
