/**
 * 印刷用紙サイズの共通定義（Mr.Satto 次工程フェーズ）。
 *
 * これまで excel-to-pdf.ts が独自に PAPER_SIZES_PT（A4/A3/Letter/Legal/A5のみ）を、
 * pdf-resize-pages-tool.tsx がさらに別の限定リスト（a4/a3/letterのみ）を、
 * それぞれ個別に持っていた（開発指示書の「印刷物共通基盤」節で指摘されている重複）。
 *
 * このファイルは「画像レイアウト」ツールで新規に必要になった用紙サイズ定義を
 * 単一の場所へ集約したものであり、既存のexcel-to-pdf.ts / pdf-resize-pages-tool.tsx
 * の値は今回変更しない（既存ツールの回帰リスクを避けるため）。将来、
 * PDFページサイズ変更・余白調整ツールを強化するタイミングで、既存2箇所の
 * 定義をこちらへ統合することを検討する（このファイルの値はexcel-to-pdf.tsの
 * 既存4サイズと完全に一致する数値を採用しており、統合時の差分が出ない）。
 *
 * 単位はpt（1pt = 1/72インチ）。pdf-libの座標系と直接互換。
 * mm起点のサイズは 1mm = 2.834645669pt で算出し、小数第2位で丸めている
 * （excel-to-pdf.tsの既存A4/A3/A5/Letter/Legalの値と同じ丸め方針）。
 */

export type PaperSizeId =
  | "A0"
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "B0"
  | "B1"
  | "B2"
  | "B3"
  | "B4"
  | "B5"
  | "Letter"
  | "Legal"
  | "Postcard";

export interface PaperSizePt {
  width: number;
  height: number;
}

/** 縦向き（width < height）を基準値とする */
export const PAPER_SIZES_PT: Record<PaperSizeId, PaperSizePt> = {
  A0: { width: 2383.94, height: 3370.39 },
  A1: { width: 1683.78, height: 2383.94 },
  A2: { width: 1190.55, height: 1683.78 },
  A3: { width: 841.89, height: 1190.55 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  B0: { width: 2920.63, height: 4127.24 },
  B1: { width: 2063.62, height: 2920.63 },
  B2: { width: 1460.31, height: 2063.62 },
  B3: { width: 1031.81, height: 1460.31 },
  B4: { width: 728.5, height: 1031.81 },
  B5: { width: 515.91, height: 728.5 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  /** 日本の官製はがき（100mm × 148mm） */
  Postcard: { width: 283.46, height: 419.53 },
};

export const PAPER_SIZE_LABELS: Record<PaperSizeId, string> = {
  A0: "A0",
  A1: "A1",
  A2: "A2",
  A3: "A3",
  A4: "A4",
  A5: "A5",
  B0: "B0",
  B1: "B1",
  B2: "B2",
  B3: "B3",
  B4: "B4",
  B5: "B5",
  Letter: "Letter",
  Legal: "Legal",
  Postcard: "はがき",
};

export type PaperOrientation = "portrait" | "landscape";

export const MM_PER_PT = 1 / 2.834645669;
export const PT_PER_MM = 2.834645669;

export function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

export function ptToMm(pt: number): number {
  return pt * MM_PER_PT;
}

/** 用紙サイズ(pt, 縦向き基準)を、指定した向きに合わせて返す */
export function applyOrientation(size: PaperSizePt, orientation: PaperOrientation): PaperSizePt {
  if (orientation === "landscape") {
    return { width: size.height, height: size.width };
  }
  return size;
}

/** プリセットID + 向きから、最終的な用紙サイズ(pt)を求める */
export function resolvePaperSizePt(id: PaperSizeId, orientation: PaperOrientation): PaperSizePt {
  return applyOrientation(PAPER_SIZES_PT[id], orientation);
}

export const PAPER_SIZE_IDS: PaperSizeId[] = [
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "B0",
  "B1",
  "B2",
  "B3",
  "B4",
  "B5",
  "Letter",
  "Legal",
  "Postcard",
];
