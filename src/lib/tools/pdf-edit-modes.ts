/**
 * 「PDF編集」総合ツールの操作（モード）の定義。
 *
 * 総合ツール（pdf-edit）と、統合済みの旧ツール（個別URLは維持）の対応表。
 * 画面（クライアント）から読むため、重いツール一覧データ（data.ts）には依存させず、
 * ここに軽い定数として持つ。data.ts の `mergedInto: "pdf-edit"` との一致は
 * tests/tools/pdf-edit.spec.ts で検証している。
 */

export const PDF_EDIT_TOOL_ID = "pdf-edit";

export type PdfEditMode = "merge" | "split" | "delete" | "extract" | "reorder" | "rotate";

export interface PdfEditModeInfo {
  mode: PdfEditMode;
  /** 操作の切り替えボタンの表示名 */
  label: string;
  /** この操作の個別ページ（統合済みの旧ツール）のツールID。URLは /tools/<toolId> のまま維持する */
  toolId: string;
  /** 個別ページへのリンクに表示する名前（旧ツール名と同じ） */
  pageName: string;
  /** 操作の説明（1文） */
  description: string;
}

export const PDF_EDIT_MODES: PdfEditModeInfo[] = [
  { mode: "merge", label: "結合", toolId: "pdf-merge", pageName: "PDF結合", description: "複数のPDFを、並べた順に1つのPDFにまとめます。" },
  { mode: "split", label: "分割", toolId: "pdf-split", pageName: "PDF分割", description: "1ページごと、または指定したページ範囲ごとに、PDFを分けます。" },
  { mode: "delete", label: "ページ削除", toolId: "pdf-delete-pages", pageName: "PDFページ削除", description: "選んだページを取り除いた、新しいPDFを作ります。" },
  { mode: "extract", label: "ページ抽出", toolId: "pdf-extract-pages", pageName: "PDFページ抽出", description: "指定したページだけを、指定した順で新しいPDFにします。" },
  { mode: "reorder", label: "並び替え", toolId: "pdf-reorder-pages", pageName: "PDFページ並び替え", description: "ページの順序を入れ替えた、新しいPDFを作ります。" },
  { mode: "rotate", label: "回転", toolId: "pdf-rotate", pageName: "PDF回転", description: "すべてのページを、時計回りに回転します。" },
];

export function getPdfEditMode(mode: PdfEditMode): PdfEditModeInfo {
  return PDF_EDIT_MODES.find((m) => m.mode === mode) ?? PDF_EDIT_MODES[0];
}
