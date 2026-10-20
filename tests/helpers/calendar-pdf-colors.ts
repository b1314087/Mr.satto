/**
 * PDFの描画命令から、使われている色と「塗り」の有無を読み取るテスト用ヘルパー（年度カレンダーの配色検証用）。
 * 色は #RRGGBB（大文字）で返す。
 */
import path from "node:path";

const STANDARD_FONT_DATA_URL = path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

export interface PdfPageColors {
  /** 塗り色（文字・図形）として設定された色 */
  fillColors: Set<string>;
  /** 線の色として設定された色 */
  strokeColors: Set<string>;
  /** 図形を塗りつぶす命令（fill / fillStroke 系）の数 */
  fillOpCount: number;
  /** 線を引く命令（stroke / fillStroke 系）の数 */
  strokeOpCount: number;
}

const hex = (a: ArrayLike<number>) =>
  `#${[0, 1, 2].map((i) => Math.round(a[i]).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

export async function readPdfColors(bytes: Uint8Array): Promise<PdfPageColors[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const O = pdfjsLib.OPS;
  const pages: PdfPageColors[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const ops = await (await doc.getPage(i)).getOperatorList();
    const res: PdfPageColors = { fillColors: new Set(), strokeColors: new Set(), fillOpCount: 0, strokeOpCount: 0 };
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k];
      const args = ops.argsArray[k];
      if (fn === O.setFillRGBColor) res.fillColors.add(hex(args));
      else if (fn === O.setStrokeRGBColor) res.strokeColors.add(hex(args));
      else if (fn === O.setFillGray) res.fillColors.add(hex([args[0], args[0], args[0]]));
      else if (fn === O.setStrokeGray) res.strokeColors.add(hex([args[0], args[0], args[0]]));
      else if (fn === O.fill || fn === O.eoFill) res.fillOpCount++;
      else if (fn === O.fillStroke || fn === O.eoFillStroke) {
        res.fillOpCount++;
        res.strokeOpCount++;
      } else if (fn === O.stroke || fn === O.closeStroke) res.strokeOpCount++;
    }
    pages.push(res);
  }
  return pages;
}
