/**
 * 「PDF修正」総合ツールの機能（モード）の定義（工程12）。
 *
 * PDF修正は、既存のPDF関連ツールを1つの画面にまとめた入口。各機能の中身は既存ツールの画面をそのまま使い、
 * 個別URL（/tools/pdf-fill-annotate など）も維持する。
 * 画面（クライアント）から読むため、重いツール一覧データ（data.ts）には依存させず、ここに軽い定数として持つ。
 * data.ts のツールIDとの一致は tests/tools/pdf-fix.spec.ts で検証している。
 */

export const PDF_FIX_TOOL_ID = "pdf-fix";
export const PDF_FIX_TOOL_PATH = "/tools/pdf-fix";

export type PdfFixMode = "annotate" | "page-numbers" | "watermark";

export interface PdfFixModeInfo {
  mode: PdfFixMode;
  /** 切り替えボタンの表示名 */
  label: string;
  /** この機能に対応する既存ツール（個別URLは /tools/<toolId> のまま維持する） */
  toolId: string;
  /** 既存ツールの名前 */
  pageName: string;
  /** 機能の説明（1文） */
  description: string;
}

export const PDF_FIX_MODES: PdfFixModeInfo[] = [
  {
    mode: "annotate",
    label: "記入・注釈・白消し",
    toolId: "pdf-fill-annotate",
    pageName: "PDF記入・注釈",
    description: "文字・チェック・図形・手書き・画像・印影を追加できます。白消しで文字を隠して、上から書き直すこともできます。",
  },
  {
    mode: "page-numbers",
    label: "ページ番号",
    toolId: "pdf-add-page-numbers",
    pageName: "PDFページ番号追加",
    description: "各ページに、開始番号・位置・大きさを選んでページ番号を入れます。",
  },
  {
    mode: "watermark",
    label: "透かし",
    toolId: "pdf-watermark",
    pageName: "PDF透かし",
    description: "各ページに、「社外秘」などの文字を透かしとして入れます。",
  },
];

export function getPdfFixMode(mode: PdfFixMode): PdfFixModeInfo {
  return PDF_FIX_MODES.find((m) => m.mode === mode) ?? PDF_FIX_MODES[0];
}
