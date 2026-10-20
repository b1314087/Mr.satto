/**
 * 既存の年度カレンダーテーマ（ビジネス・ナチュラル）の出力が変わっていないことを確かめるための「出力の指紋」。
 *  - Excel: ZIPの中身（日時を含む docProps は除く）の各ファイルのSHA-256
 *  - PDF: 各ページの描画命令のうち、色・図形の命令と、文字の内容・位置のSHA-256
 * 色の指定が1つでも変わる、図形の位置が変わる、といった変化があれば指紋が変わる。
 * PDFには作成日時が入るため、ファイル全体のハッシュは使わない。
 */
import crypto from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";

const sha = (data: string | Uint8Array) => crypto.createHash("sha256").update(data).digest("hex");

export function excelFingerprint(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) {
    if (name.startsWith("docProps/")) continue;
    out[name] = sha(files[name]);
  }
  return out;
}

const STANDARD_FONT_DATA_URL = path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

export async function pdfFingerprint(bytes: Uint8Array): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const OPS = pdfjsLib.OPS;
  const keep = new Set<number>([
    OPS.setFillRGBColor, OPS.setStrokeRGBColor, OPS.setFillGray, OPS.setStrokeGray, OPS.setFillColor, OPS.setStrokeColor,
    OPS.constructPath, OPS.fill, OPS.stroke, OPS.fillStroke, OPS.eoFill, OPS.eoFillStroke, OPS.rectangle, OPS.setLineWidth,
  ]);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const ops = await page.getOperatorList();
    const seq: unknown[] = [];
    for (let k = 0; k < ops.fnArray.length; k++) {
      if (keep.has(ops.fnArray[k])) seq.push([ops.fnArray[k], JSON.parse(JSON.stringify(Array.from(ops.argsArray[k] ?? [], (v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v))))]);
    }
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const texts = (content.items as any[]).map((t) => [t.str, (t.transform as number[]).map((n) => Math.round(n * 100) / 100)]);
    pages.push(sha(JSON.stringify([seq, texts])));
  }
  return pages;
}
