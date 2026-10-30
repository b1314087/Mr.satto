import type { Category, CategoryId } from "./types";

export const categories: Category[] = [
  {
    id: "image",
    name: "画像",
    description: "リサイズ・圧縮・形式変換など画像の加工ツール",
    icon: "🖼️",
  },
  {
    id: "pdf",
    name: "PDF",
    description: "結合・分割・変換・抽出などPDFの編集ツール",
    icon: "📄",
  },
  {
    id: "csv-excel",
    name: "Excel・CSV",
    description: "表データの整形・変換・結合ツール",
    icon: "📊",
  },
  {
    id: "word",
    name: "Word",
    description: "Word文書の変換・編集ツール",
    icon: "📝",
  },
  {
    id: "pptx",
    name: "PowerPoint",
    description: "PowerPoint（.pptx）の色の変換など、スライド資料の加工ツール",
    icon: "📽️",
  },
  {
    id: "video",
    name: "動画",
    description: "形式変換・圧縮・解像度変更などブラウザ完結の動画ツール",
    icon: "🎬",
  },
  {
    id: "audio",
    name: "音声",
    description: "形式変換・カット・結合・音量調整・圧縮などブラウザ完結の音声ツール",
    icon: "🎧",
  },
  {
    id: "file",
    name: "ファイル",
    description: "ファイル名の一括変更やZIP作成など",
    icon: "🗂️",
  },
  {
    id: "generator",
    name: "生成ツール",
    description: "見積書・請求書などの書類、二次元コード、パスワード、配色パレットなどを新規生成するツール",
    icon: "🛠️",
  },
  {
    id: "other",
    name: "その他",
    description: "文字数カウントや日付計算など、特定のカテゴリに当てはまらない便利なツール",
    icon: "✨",
  },
];

export function getCategory(id: CategoryId): Category | undefined {
  return categories.find((c) => c.id === id);
}

/**
 * カテゴリページの見出し・パンくず・パンくずの構造化データに使う名称（例: 「画像ツール」「PDFツール」）。
 * カテゴリ名が最初から「ツール」で終わる場合（例: 「生成ツール」）は、「ツール」を重ねて付けない。
 * 画面表示・パンくず・構造化データがずれないよう、必ずこの関数を通す。
 */
export function getCategoryToolsLabel(category: Pick<Category, "name">): string {
  return category.name.endsWith("ツール") ? category.name : `${category.name}ツール`;
}

/** ツールページの関連ツールの見出し（例: 「PDFの他のツール」）。カテゴリ名が「その他」のときは「その他の他の…」と重ならないようにする */
export function getRelatedToolsHeading(category: Pick<Category, "name">): string {
  return category.name.endsWith("その他") ? `${category.name}カテゴリの他のツール` : `${category.name}の他のツール`;
}
