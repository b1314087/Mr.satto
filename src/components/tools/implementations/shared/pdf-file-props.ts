/**
 * 「PDF編集」「PDF修正」の総合画面から、1つのPDFを扱う各操作（分割・ページ削除・ページ抽出・並び替え・回転、
 * 記入・注釈・白消し、ページ番号、透かし）へ渡す props。
 * 操作を切り替えても、最初に選んだPDFをそのまま使えるようにする。
 * 単独で使うときは省略できる。
 */
export interface SharedPdfFileProps {
  /** 最初から選択済みにするPDF（総合画面で操作を切り替えたとき、選択済みのPDFを引き継ぐ） */
  initialFile?: File | null;
  /** PDFが選ばれた・外されたときに呼ばれる（総合画面が選択中のPDFを覚えておくため） */
  onFileChange?: (file: File | null) => void;
}
