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

export interface PageOpSummary {
  /** 画像(paintImageXObject等)を描画する命令が含まれるか（追加した画像・印影の検証用） */
  hasImage: boolean;
  /** パス構築系の命令が1つでも含まれるか（追加した図形・手書き・チェック枠の検証用） */
  hasPath: boolean;
  /**
   * パスの部分区間(moveToで始まる区間)の数のおおよその目安。
   * pdf-libはre命令(矩形専用オペレータ)を使わず、drawRectangle/drawLine/drawEllipse
   * いずれもmoveTo+lineTo/curveTo+(closePath)の組み合わせで描画するため、正確な
   * 「矩形が何個・直線が何本」という区別はできないが、「配置した図形の数に応じて
   * パス区間の数が増える」ことの検証には十分使える（詳細はverify-opsummary系の
   * 手動検証で確認済み。実装報告書を参照）。
   */
  pathSegmentCount: number;
  /** closePath命令の回数（矩形など「閉じた」パスの目安） */
  closePathCount: number;
  /** curveTo系命令の回数（楕円/円の描画は12個前後のベジェ曲線に分解されるため、円の存在の目安になる） */
  curveSegmentCount: number;
}

/**
 * Phase 17: テキスト以外（図形・画像・印影など、pdfjsのgetTextContent()では見えない
 * ベクター/画像描画）がPDFへ実際に書き出されているかを検証するためのヘルパー。
 *
 * 「ダウンロードイベントが発火しただけ」を成功と見なさない方針を、テキスト以外の
 * オブジェクト（矩形・円・直線・画像・印影）にも適用するために、pdfjs-dist
 * （新規依存の追加なし、既存のextractPdfContentと同じNode向けビルド）の
 * getOperatorList()を使い、ページの描画命令の内訳を集計する。
 *
 * 注意: pdf-libは矩形・直線・楕円のいずれも、PDFの専用オペレータ(re等)ではなく
 * moveTo/lineTo/curveTo/closePathの組み合わせで描画する（node_modules/pdf-lib/
 * cjs/api/operations.js で確認済み）。そのため「矩形が何個・直線が何本」を
 * 厳密に区別することはできないが、本ヘルパーは「そもそも図形が描画されたか」
 * 「配置数に応じて増えるか」の検証を目的としており、その用途には十分な精度を持つ。
 */
export async function getPageOpSummary(filePath: string, pageNumber: number): Promise<PageOpSummary> {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const page = await doc.getPage(pageNumber);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;

  let hasImage = false;
  let pathSegmentCount = 0;
  let closePathCount = 0;
  let curveSegmentCount = 0;

  const fnArray = opList.fnArray as number[];
  const argsArray = opList.argsArray as unknown[];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintImageMaskXObject
    ) {
      hasImage = true;
    } else if (fn === OPS.constructPath) {
      const args = argsArray[i] as [number[], number[], number[]] | undefined;
      const subOps = args?.[0] ?? [];
      for (const sub of subOps) {
        if (sub === OPS.moveTo) pathSegmentCount++;
        else if (sub === OPS.closePath) closePathCount++;
        else if (sub === OPS.curveTo || sub === OPS.curveTo2 || sub === OPS.curveTo3) curveSegmentCount++;
      }
    } else if (fn === OPS.moveTo) {
      pathSegmentCount++;
    } else if (fn === OPS.closePath) {
      closePathCount++;
    } else if (fn === OPS.curveTo || fn === OPS.curveTo2 || fn === OPS.curveTo3) {
      curveSegmentCount++;
    }
  }

  return {
    hasImage,
    hasPath: pathSegmentCount > 0 || curveSegmentCount > 0,
    pathSegmentCount,
    closePathCount,
    curveSegmentCount,
  };
}

/**
 * 外出先PC修正指示書§29-31（excel-to-pdfのセル背景色・文字色反映）検証用。
 * ページの描画命令から、実際に使われた塗り色(非ストローク色。"rg"オペレータ=
 * OPS.setFillRGBColor)を"#RRGGBB"の集合として取り出す。セルの背景矩形も
 * 文字の描画色もどちらも同じ"rg"で色を指定するため、このヘルパー1つで両方を
 * 検証できる（個々の矩形・文字がどのセルに対応するかまでは追わず、
 * 「そのページのどこかで実際にその色が使われたか」を確認する用途に絞る）。
 */
export async function getFillColorsUsed(filePath: string, pageNumber: number): Promise<Set<string>> {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;
  const page = await doc.getPage(pageNumber);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;

  const colors = new Set<string>();
  const fnArray = opList.fnArray as number[];
  const argsArray = opList.argsArray as unknown[];
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] !== OPS.setFillRGBColor) continue;
    const args = argsArray[i] as number[] | undefined;
    if (!args || args.length < 3) continue;
    const toHex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
    colors.add(`#${toHex(args[0])}${toHex(args[1])}${toHex(args[2])}`.toLowerCase());
  }
  return colors;
}
