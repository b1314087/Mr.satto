import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import type { TestInfo } from "@playwright/test";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { extractPdfContent } from "./pdf-inspect";

/**
 * PDFページ操作（削除・並べ替え・抽出・回転）の出力品質テスト用ヘルパー（工程7）。
 *
 * 方針:
 * - 入力PDFは、このファイルの関数でテストごとに合成する（実ファイルや個人情報は使わない）。
 *   各ページに「元のページ番号」を表す一意な文字列（QA-ORIG-n）を書き込み、さらに
 *   元のページ番号ごとに異なるページサイズ（MediaBox）を与える。
 *   これにより、出力PDFの各ページが「元の何ページ目か」を、本文とページサイズの
 *   2つの独立した手がかりで判定できる（本文の抽出に失敗しても取り違えに気づける）。
 * - 出力PDFは、ファイル全体のバイト一致では判定せず、ページ数・元ページの並び・
 *   回転角・ページサイズ・本文の保持といった「意味のある性質」で検証する。
 * - 本文は既存の pdf-inspect（pdfjs-dist）、回転角・ページサイズは pdf-lib で読む。
 *   どちらもアプリ本体が既に使っている既存ライブラリで、新しい依存は追加しない。
 */

/**
 * 本文に書き込むラベル。元のページ番号を含む。
 * 末尾に終端記号（-END）を付けている。ページ番号の追加のように、本文のすぐ後ろへ数字が追加される
 * 操作の出力では、ページのテキストが区切りなしで連結される（例: "QA-ORIG-1" + "1" → "QA-ORIG-11"）ため、
 * 終端記号がないと元ページ番号を正しく読み取れない。
 */
export function pageLabel(originalPageNumber: number): string {
  return `QA-ORIG-${originalPageNumber}-END`;
}

/** 元のページ番号ごとに異なるページサイズ（pt）。大きさの違いでも元ページを判別できるようにする */
export function pageSizeFor(originalPageNumber: number): { width: number; height: number } {
  return { width: 300 + 20 * originalPageNumber, height: 400 + 20 * originalPageNumber };
}

export interface SyntheticPageSpec {
  /** 元のページ番号（1始まり）。本文とページサイズの決定に使う */
  original: number;
  /** 入力PDFに最初から設定しておく回転角（0/90/180/270）。省略時は0 */
  rotation?: number;
  /** ページサイズ（pt）。省略時は pageSizeFor(original)。透かしのように、ある程度の大きさのページが要るテスト用 */
  size?: { width: number; height: number };
}

/** ページごとの識別ラベル・サイズ・回転角を持つ合成PDFを作ってファイルに保存する */
export async function writeSyntheticPdf(filePath: string, pages: SyntheticPageSpec[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const { width, height } = spec.size ?? pageSizeFor(spec.original);
    const page = doc.addPage([width, height]);
    page.drawText(pageLabel(spec.original), { x: 20, y: height - 40, size: 14, font, color: rgb(0, 0, 0) });
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
  }
  fs.writeFileSync(filePath, await doc.save());
}

/** 1〜count ページの合成PDF（回転なし）を作る */
export async function writeSequentialPdf(filePath: string, count: number): Promise<void> {
  await writeSyntheticPdf(
    filePath,
    Array.from({ length: count }, (_, i) => ({ original: i + 1 }))
  );
}

export interface OutputPageInfo {
  /** 本文に含まれていた QA-ORIG-n-END の n の一覧（正常なら要素は1つだけ） */
  originals: number[];
  text: string;
  /** PDF内の回転角（/Rotate）。pdf-libのgetRotation().angle */
  rotation: number;
  /** MediaBoxの幅・高さ（回転は含まない、PDF内の値そのもの） */
  width: number;
  height: number;
}

export interface OutputPdfInfo {
  pageCount: number;
  pages: OutputPageInfo[];
  /** 各ページが元の何ページ目か（本文から判定）。1ページに複数ラベルがあれば誤りとして例外にする */
  originalOrder: number[];
}

/** 出力PDFを実際にパースし、ページ数・各ページの元ページ番号・回転角・サイズ・本文を取り出す */
export async function inspectOutputPdf(filePath: string): Promise<OutputPdfInfo> {
  const bytes = fs.readFileSync(filePath);
  // updateMetadata:false … 読み込みだけでメタデータを書き換えないため（検証が読み取り専用になる）
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const extracted = await extractPdfContent(filePath);

  if (extracted.pageCount !== doc.getPageCount()) {
    throw new Error(
      `ページ数の読み取り結果が食い違っています（pdfjs: ${extracted.pageCount}, pdf-lib: ${doc.getPageCount()}）`
    );
  }

  const pages: OutputPageInfo[] = doc.getPages().map((page, i) => {
    const text = extracted.pages[i].text;
    const originals = Array.from(text.matchAll(/QA-ORIG-(\d+)-END/g)).map((m) => Number(m[1]));
    const { width, height } = page.getSize();
    return { originals, text, rotation: page.getRotation().angle, width, height };
  });

  const originalOrder = pages.map((p, i) => {
    if (p.originals.length !== 1) {
      throw new Error(
        `出力の${i + 1}ページ目に、元ページを示すラベルが${p.originals.length}個あります（本文: ${JSON.stringify(p.text)}）`
      );
    }
    return p.originals[0];
  });

  return { pageCount: doc.getPageCount(), pages, originalOrder };
}

/** サイズの比較で許す誤差（pt）。PDFの数値表現の丸めだけを許容する */
export const SIZE_TOLERANCE_PT = 0.5;

// ---------------------------------------------------------------------------
// 一時フォルダ（入力・ダウンロードしたPDFの置き場）
// ---------------------------------------------------------------------------

/**
 * テスト用PDFの置き場（短い英数字だけのパス）を作る。
 * testInfo.outputPath() の「テスト名（日本語・長い）」を含む深いパスに置いたPDFは、
 * ファイル入力欄へ選んでも黙って無視されることを工程7で確認している。
 */
export function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pdfqa-"));
}

/** 一時フォルダを削除する。テストが失敗していたときは、調査用に中身をテスト結果へ添付してから消す */
export async function cleanupWorkDir(dir: string, testInfo: TestInfo): Promise<void> {
  try {
    if (dir && testInfo.status !== testInfo.expectedStatus) {
      for (const name of fs.readdirSync(dir)) {
        await testInfo.attach(name, { path: path.join(dir, name) });
      }
    }
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 文字の描画命令の解析（ページ番号・透かしの位置・回転・不透明度の検証用）
// ---------------------------------------------------------------------------

/**
 * ページの描画命令（pdfjsのオペレータリスト）から読み取った、1回の文字描画。
 *
 * extractPdfContent（getTextContent）は、ページの外にはみ出した文字を結果に含めないため
 * （はみ出した透かしの末尾1文字が欠けることを実験で確認）、位置・回転・不透明度の検証には、
 * 描画命令そのものを読むこの方法を使う。
 *
 * 対象は pdf-lib の drawText が出力する形式（save → setGState(ca) → 塗り色 → setFont →
 * setTextMatrix → showText → restore）。想定外の形式（座標変換 cm など）を見つけたら、
 * 値を推測せず例外にして「検証方法が出力形式に対応できなかった」ことを明示する。
 */
export interface TextDrawCall {
  /** 描画された文字列（グリフのUnicode） */
  text: string;
  /** 文字列の左端・ベースラインの位置（ページ座標、原点左下、pt） */
  x: number;
  y: number;
  /** 文字列の向き（度、反時計回りが正）。pdf-libの rotate に渡した値に対応 */
  angleDeg: number;
  /** 実効フォントサイズ（setFont のサイズ × テキスト行列の拡大率） */
  fontSize: number;
  /** 塗りの不透明度（ExtGStateの ca。指定がなければ1） */
  opacity: number;
  /** 塗り色（0〜255の整数。pdfjsが丸めた値） */
  fill: { r: number; g: number; b: number } | null;
}

const STANDARD_FONT_DATA_URL =
  path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

/** 出力PDFの全ページについて、文字の描画一覧（描画された順）を取り出す。配列の添字はページ番号-1 */
export async function extractTextDrawCalls(filePath: string): Promise<TextDrawCall[][]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjsLib: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjsLib.OPS;
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL }).promise;

  const result: TextDrawCall[][] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const opList = await page.getOperatorList();
    const fn = opList.fnArray as number[];
    const args = opList.argsArray as unknown[][];

    type GState = { opacity: number; fill: TextDrawCall["fill"] };
    const stack: GState[] = [];
    let state: GState = { opacity: 1, fill: null };
    let fontSize = 0;
    let matrix: number[] | null = null;
    const calls: TextDrawCall[] = [];

    for (let i = 0; i < fn.length; i++) {
      const op = fn[i];
      if (op === OPS.save) {
        stack.push({ ...state });
      } else if (op === OPS.restore) {
        state = stack.pop() ?? { opacity: 1, fill: null };
      } else if (op === OPS.transform) {
        throw new Error(
          `ページ${pageNo}に座標変換(cm)があり、文字の描画位置を推測せずに読み取ることができません`
        );
      } else if (op === OPS.setGState) {
        const pairs = (args[i][0] ?? []) as [string, unknown][];
        for (const [key, value] of pairs) {
          if (key === "ca" && typeof value === "number") state = { ...state, opacity: value };
        }
      } else if (op === OPS.setFillRGBColor) {
        const a = args[i] as unknown as ArrayLike<number>;
        state = { ...state, fill: { r: a[0], g: a[1], b: a[2] } };
      } else if (op === OPS.setFont) {
        fontSize = Number(args[i][1]);
      } else if (op === OPS.setTextMatrix) {
        matrix = (args[i] as number[]).slice(0, 6);
      } else if (op === OPS.showText) {
        if (!matrix) throw new Error(`ページ${pageNo}: テキスト行列が設定される前に文字が描画されています`);
        const glyphs = (args[i][0] ?? []) as { unicode?: string }[];
        const text = glyphs.map((g) => (typeof g === "object" && g ? (g.unicode ?? "") : "")).join("");
        const [a, b, , , e, f] = matrix;
        calls.push({
          text,
          x: e,
          y: f,
          angleDeg: (Math.atan2(b, a) * 180) / Math.PI,
          fontSize: fontSize * Math.hypot(a, b),
          opacity: state.opacity,
          fill: state.fill,
        });
      }
    }
    result.push(calls);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 文字幅の測定（期待する配置位置の計算用）
// ---------------------------------------------------------------------------

/** 文字の幅・高さを測る関数（アプリが使うのと同じ pdf-lib のフォント測定） */
export interface TextMeasure {
  widthOfTextAtSize(text: string, size: number): number;
  heightAtSize(size: number): number;
}

let helveticaMeasure: Promise<TextMeasure> | null = null;
let japaneseMeasure: Promise<TextMeasure> | null = null;

/** ページ番号で使う標準フォント(Helvetica)の測定。通信は不要 */
export function getHelveticaMeasure(): Promise<TextMeasure> {
  helveticaMeasure ??= PDFDocument.create().then((doc) => doc.embedFont(StandardFonts.Helvetica));
  return helveticaMeasure;
}

/**
 * 透かしで使う日本語フォント(Noto Sans JP)の測定。
 * アプリが配信しているのと同じ、リポジトリ内のフォントファイル(public/fonts)を直接読むため、通信は不要。
 * 新しいフォントファイルは追加しない。
 */
export function getJapaneseMeasure(): Promise<TextMeasure> {
  japaneseMeasure ??= (async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const bytes = fs.readFileSync(path.join(__dirname, "..", "..", "public", "fonts", "NotoSansJP-Regular.ttf"));
    return doc.embedFont(new Uint8Array(bytes), { subset: false });
  })();
  return japaneseMeasure;
}
