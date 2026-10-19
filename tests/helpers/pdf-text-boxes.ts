/**
 * PDFの各ページから、文字列ごとの位置と大きさ（枠）を取り出すテスト用ヘルパー。
 * 年度カレンダーPDFの「文字切れ・重なり・マスからのはみ出し」の検証に使う。
 * 座標はページ左下が原点（pt）。枠は、ベースラインの位置 y から、文字の高さ（フォントサイズ）ぶん上までとする。
 */
import fs from "node:fs";
import path from "node:path";

export interface TextBox {
  str: string;
  x: number;
  /** ベースラインのY */
  y: number;
  width: number;
  /** フォントサイズ（pt） */
  size: number;
}

export interface PageBoxes {
  width: number;
  height: number;
  boxes: TextBox[];
}

const STANDARD_FONT_DATA_URL = path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

export async function extractTextBoxes(bytes: Uint8Array): Promise<PageBoxes[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const pages: PageBoxes[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const boxes: TextBox[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string" || item.str.trim() === "") continue;
      const t = item.transform as number[];
      boxes.push({ str: item.str, x: t[4], y: t[5], width: item.width as number, size: Math.hypot(t[2], t[3]) });
    }
    pages.push({ width: viewport.width, height: viewport.height, boxes });
  }
  return pages;
}

export function readFontBytes(): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "..", "public", "fonts", "NotoSansJP-Regular.ttf")));
}
