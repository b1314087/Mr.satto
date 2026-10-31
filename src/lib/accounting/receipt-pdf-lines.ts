import type { TextLine } from "./receipt-types";

/**
 * PDFの文字情報（座標つきの断片）を、見た目の「行」にまとめる（工程8）。
 * 純粋な関数。pdfjsの座標系（原点は左下、上方向が正）を前提にする。
 */

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontHeight: number;
}

/** 断片を、上から下、左から右の順に並べて、同じ高さのものを1行にまとめる */
export function linesFromTextItems(items: PdfTextItem[]): TextLine[] {
  const usable = items.filter((i) => i.str.trim() !== "");
  if (usable.length === 0) return [];
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: PdfTextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const tolerance = Math.max(1, item.fontHeight * 0.5);
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  return rows.map((row) => {
    const ordered = [...row].sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd: number | null = null;
    for (const item of ordered) {
      if (prevEnd !== null) {
        const gap = item.x - prevEnd;
        // 文字の間が大きく空いている（桁をそろえた表など）ときは空白を入れる
        if (gap > item.fontHeight * 0.3) text += " ";
      }
      text += item.str;
      prevEnd = item.x + item.width;
    }
    return { text: text.trim(), confidence: null };
  });
}

/**
 * 文字情報が、書類の内容として使えそうかを大まかに判定する。
 * 文字が極端に少ない、文字化け（置換文字・私用領域の文字）が多い場合は使えないと判断し、画像を読み取る（OCR）側に回す。
 * 「文字情報がある」ことは、書類の内容を正しく読めていることを意味しないため、この判定は最低限の確認にとどまる
 * （読み取った結果は、画像と並べて利用者が確認する）。
 */
export function isTextLayerUsable(lines: TextLine[]): boolean {
  const text = lines.map((l) => l.text).join("").replace(/\s/g, "");
  if (text.length < 8) return false;
  const broken = text.match(/[\ufffd\ue000-\uf8ff\u0000-\u001f]/g)?.length ?? 0;
  return broken / text.length < 0.2;
}
