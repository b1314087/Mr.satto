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
    description: "結合・分割・変換などPDFの編集ツール",
    icon: "📄",
  },
  {
    id: "file",
    name: "ファイル",
    description: "ファイル名の一括変更やZIP作成など",
    icon: "🗂️",
  },
  {
    id: "csv-excel",
    name: "CSV・Excel",
    description: "表データの整形・変換・結合ツール",
    icon: "📊",
  },
  {
    id: "video",
    name: "動画",
    description: "形式変換・圧縮・解像度変更などブラウザ完結の動画ツール",
    icon: "🎬",
  },
  {
    id: "student",
    name: "学生向け",
    description: "レポートや勉強に役立つツール",
    icon: "🎓",
  },
  {
    id: "work",
    name: "仕事",
    description: "ビジネスシーンで使えるツール",
    icon: "💼",
  },
  {
    id: "creator",
    name: "クリエイター",
    description: "制作・デザインに役立つツール",
    icon: "🎨",
  },
  {
    id: "other",
    name: "その他",
    description: "QRコードやパスワード生成など便利ツール",
    icon: "✨",
  },
];

export function getCategory(id: CategoryId): Category | undefined {
  return categories.find((c) => c.id === id);
}
