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
    id: "video",
    name: "動画",
    description: "形式変換・圧縮・解像度変更などブラウザ完結の動画ツール",
    icon: "🎬",
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
    description: "QRコード・パスワード・配色パレットなどを新規生成するツール",
    icon: "🛠️",
  },
  {
    id: "other",
    name: "その他",
    description: "文字数カウントや日付計算、見積書・請求書作成など、特定のカテゴリに当てはまらない便利なツール",
    icon: "✨",
  },
];

export function getCategory(id: CategoryId): Category | undefined {
  return categories.find((c) => c.id === id);
}
