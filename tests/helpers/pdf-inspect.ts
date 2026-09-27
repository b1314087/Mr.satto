import fs from "node:fs";
import path from "node:path";

/**
 * テスト側（Node.js実行環境）でのPDF内容検証ヘルパー（Phase 15）。
 *
 * 「ダウンロードイベントが発火した」だけを成功と見なさない、という方針に沿い、
 * PDF記入・注釈ツールが生成したPDFを実際にパースして、ページ数・追加した
 * テキスト（日本語を含む）が正しく含まれているかまで確認するために使う。
 *
 * 新しいnpm依存は追加せず、アプリ本体も使っている既存の pdfjs-dist の
 * Node向けビルド（legacy/build/pdf.mjs）をテストコードから直接呼び出す。
 * ブラウザ向けのGlobalWorkerOptions.workerSrc設定（src/lib/pdf/pdfjs-client.ts）
 * とは別に、Node実行環境向けにこのファイル内だけで完結させる。
 */

let pdfjsPromise: ReturnType<typeof importPdfjs> | null = null;

async function importPdfjs() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
}

function getPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = importPdfjs();
  return pdfjsPromise;
}

const STANDARD_FONT_DATA_URL = path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

export interface ExtractedTextItem {
  str: string;
  /** PDFページ座標系（原点左下）でのX,Y（pdfjsのtransform[4],[5]） */
  x: number;
  y: number;
}

export interface ExtractedPage {
  text: string;
  items: ExtractedTextItem[];
  width: number;
  height: number;
}

export interface ExtractedPdf {
  pageCount: number;
  /** 全ページのテキストを連結したもの */
  text: string;
  /** ページごとの詳細（座標つき。配置位置の回帰確認に使う） */
  pages: ExtractedPage[];
}

/** 生成されたPDFファイルを実際にパースし、ページ数・テキスト内容・座標を取得する */
export async function extractPdfContent(filePath: string): Promise<ExtractedPdf> {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;

  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let pageText = "";
    const items: ExtractedTextItem[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string") continue;
      pageText += item.str;
      const transform = item.transform as number[];
      items.push({ str: item.str, x: transform[4], y: transform[5] });
    }
    pages.push({ text: pageText, items, width: viewport.width, height: viewport.height });
  }

  return { pageCount: doc.numPages, text: pages.map((p) => p.text).join("\n"), pages };
}

/** PDFの先頭が正しい%PDF-マジックバイトであること等、最低限の妥当性を確認する */
export function isValidPdfFile(filePath: string): boolean {
  const buf = fs.readFileSync(filePath);
  return buf.subarray(0, 5).toString("latin1") === "%PDF-" && buf.length > 0;
}
