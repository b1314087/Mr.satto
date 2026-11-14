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
  image: ["image-to-pdf", "pdf-to-text"],
};
