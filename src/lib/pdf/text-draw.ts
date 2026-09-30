/**
 * pdf-lib でのテキスト折り返し・整列描画の共通ヘルパー
 * （Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * document-pdf.ts（見積書・請求書・注文書）が同じ考え方のローカル関数
 * （wrapTextByWidth / drawText）をファイル内に個別で持っているが、
 * 動作中の既存ツールへの回帰リスクを避けるためそちらは変更せず、
 * 今回追加する封筒宛名作成・整理券/金券/引換券作成・名簿テンプレート作成の
 * 3ツールが共通で使う新しいモジュールとして切り出す。
 */
import type { PDFFont, PDFPage } from "pdf-lib";
import { rgb } from "pdf-lib";

/** 日本語は単語区切りが無いため1文字単位で幅計測して折り返す */
export function wrapTextByWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const candidate = current + ch;
      if (current !== "" && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

export type TextAlign = "left" | "right" | "center";

export interface DrawTextOptions {
  color?: [number, number, number];
  align?: TextAlign;
}

/** 指定したページ・フォントに対して drawText / drawLine を束縛したヘルパー一式を返す */
export function createTextDrawer(page: PDFPage, font: PDFFont) {
  function drawText(value: string, x: number, y: number, size: number, opts: DrawTextOptions = {}) {
    const color = opts.color ?? [0.13, 0.13, 0.15];
    const width = font.widthOfTextAtSize(value, size);
    let drawX = x;
    if (opts.align === "right") drawX = x - width;
    else if (opts.align === "center") drawX = x - width / 2;
    page.drawText(value, { x: drawX, y, size, font, color: rgb(...color) });
  }

  function drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: [number, number, number] = [0.8, 0.8, 0.82],
    thickness = 0.75,
    dashArray?: number[]
  ) {
    page.drawLine({
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      thickness,
      color: rgb(...color),
      dashArray,
    });
  }

  return { drawText, drawLine };
}
