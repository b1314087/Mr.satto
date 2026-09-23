/**
 * ツール・カテゴリのデータ構造定義
 *
 * ツール一覧は各ページにベタ書きせず、このデータ構造に基づいて
 * データ駆動で表示する（開発指示書 14 章）。
 */

/** どこで処理するか。将来 "auto" で条件に応じた自動切り替えも可能にする */
export type ProcessorEngine = "browser" | "server" | "auto";

/** ツールの実装状況 */
export type ToolStatus = "available" | "coming-soon";

export type CategoryId =
  | "image"
  | "pdf"
  | "file"
  | "csv-excel"
  | "student"
  | "work"
  | "creator"
  | "other";

export interface Category {
  id: CategoryId;
  name: string;
  description: string;
  /** lucide-react 等を導入しない Phase 1 では簡易的な絵文字アイコンを使う */
  icon: string;
}

export interface Tool {
  /** URL に使う一意な ID (kebab-case, 半角英数字) */
  id: string;
  name: string;
  category: CategoryId;
  description: string;
  status: ToolStatus;
  /** この機能が将来的に処理を行うエンジン */
  processor: ProcessorEngine;
  /** 検索用キーワード（ひらがな/カタカナ/英語などの表記ゆれを吸収） */
  keywords?: string[];
  /** トップページ「おすすめツール」に出すか */
  featured?: boolean;
}
