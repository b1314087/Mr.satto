import fs from "node:fs";
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

/** 本文に書き込むラベル。元のページ番号を含む */
export function pageLabel(originalPageNumber: number): string {
  return `QA-ORIG-${originalPageNumber}`;
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
}

/** ページごとの識別ラベル・サイズ・回転角を持つ合成PDFを作ってファイルに保存する */
export async function writeSyntheticPdf(filePath: string, pages: SyntheticPageSpec[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const { width, height } = pageSizeFor(spec.original);
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
  /** 本文に含まれていた QA-ORIG-n の n の一覧（正常なら要素は1つだけ） */
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
    const originals = Array.from(text.matchAll(/QA-ORIG-(\d+)/g)).map((m) => Number(m[1]));
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
