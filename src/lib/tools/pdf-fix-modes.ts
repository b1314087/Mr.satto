/**
 * 「PDF修正」総合ツールの機能（モード）の定義（工程12）。
 *
 * PDF修正は、既存のPDF関連ツールを1つの画面にまとめた画面。各機能の中身は既存ツールの画面をそのまま使う。
 * 記入・注釈・白消し（旧 PDF記入・注釈）は工程2で、ページ番号（旧 PDFページ番号追加）・透かし（旧 PDF透かし）は工程3で、
 * 独立したページを廃止した。旧URLはPDF修正へ転送し、ページ番号・透かしは ?mode=<mode> で、その機能を選んだ状態で開く。
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
  /** 独立したページだったころの名前（旧URLから転送されてきた人への案内・テスト用） */
  formerName: string;
  /** 独立したページだったころのツールID（旧URL /tools/<formerToolId> は、PDF修正へ転送する） */
  formerToolId: string;
  /** 機能の説明（1文） */
  description: string;
}

export const PDF_FIX_MODES: PdfFixModeInfo[] = [
  {
    mode: "annotate",
    label: "記入・注釈・白消し",
    formerName: "PDF記入・注釈",
    formerToolId: "pdf-fill-annotate",
    description: "文字・チェック・図形・手書き・画像・印影を追加できます。白消しで文字を隠して、上から書き直すこともできます。黒塗り（見た目だけ）も置けます。",
  },
  {
    mode: "page-numbers",
    label: "ページ番号",
    formerName: "PDFページ番号追加",
    formerToolId: "pdf-add-page-numbers",
    description: "各ページに、開始番号・位置・大きさを選んでページ番号を入れます。",
  },
  {
    mode: "watermark",
    label: "透かし",
    formerName: "PDF透かし",
    formerToolId: "pdf-watermark",
    description: "各ページに、「社外秘」などの文字を透かしとして入れます。",
  },
];

export function getPdfFixMode(mode: PdfFixMode): PdfFixModeInfo {
  return PDF_FIX_MODES.find((m) => m.mode === mode) ?? PDF_FIX_MODES[0];
}

/** URLの ?mode= の値を、PDF修正の機能として読み取る（知らない値は null） */
export function parsePdfFixMode(value: string | null): PdfFixMode | null {
  return PDF_FIX_MODES.some((m) => m.mode === value) ? (value as PdfFixMode) : null;
}
