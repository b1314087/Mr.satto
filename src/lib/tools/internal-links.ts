import type { CategoryId } from "./types";

/**
 * サイト内リンク（内部リンク）の設定（内部リンク・検索導線改善の工程）。
 *
 * 背景：Search Console で、PDF→Excel などのツールページが「検出 - インデックス未登録」だった。
 * 調べると、規約・料金などのページは全ページ（ヘッダー・フッター）からリンクされているのに、
 * ツールページの多くは5〜6ページからしかリンクされておらず、トップページからのリンクもなかった。
 * Google はサイト内で多くリンクされているページほど重要だと考えるため、ツールページへの導線を増やす。
 *
 * ここでは「どのページから、どのツールへリンクするか」だけを決める（表示は各ページの部品が行う）。
 * SEO 目的だけのリンクは置かない。利用者がそのページから実際に移りたくなる、関係の深いツールに限る。
 */

/**
 * トップページの「よく使われるツール」。
 *
 * 選び方：Search Console で表示実績がある作業（見積書のPDF化・H.264変換・PDF回転など）と、
 * 一般に検索の多い作業（PDFの結合・圧縮・変換、画像の圧縮・サイズ変更）を中心に、カテゴリが偏らないように選んだ。
 * 一覧・検索に出る、使えるツールだけを並べる（テストで確認している）。
 */
export const POPULAR_TOOL_IDS: readonly string[] = [
  "pdf-to-excel",
  "pdf-to-word",
  "pdf-edit",
  "pdf-compress",
  "image-compress",
  "image-resize",
  "image-format-convert",
  "excel-csv-convert",
  "estimate-generator",
  "video-compress",
  "video-h264",
  "ocr",
];

/**
 * カテゴリページに「ほかのカテゴリにある関連ツール」として並べるツール。
 *
 * ツールの所属カテゴリは1つだけ（URL・パンくずリストはそのまま）。ただ、変換ツールは利用者が
 * どちらのカテゴリで探すか分からない（例：PDF→Excel は「Excel・CSV」にあるが、「PDF」で探す人も多い）。
 * そこで、関係する側のカテゴリページからもリンクする。
 */
export const CATEGORY_CROSS_LINKS: Partial<Record<CategoryId, readonly string[]>> = {
  pdf: ["pdf-to-excel", "pdf-to-word", "pdf-to-image", "filled-pdf-to-excel"],
  "csv-excel": ["excel-to-pdf", "excel-label", "office-compare"],
  word: ["word-to-pdf", "office-compare"],
  image: ["image-to-pdf", "ocr"],
};
