/**
 * ツール・カテゴリのデータ構造定義
 *
 * ツール一覧は各ページにベタ書きせず、このデータ構造に基づいて
 * データ駆動で表示する（開発指示書 14 章）。
 */

import type { RequiredPlan } from "@/lib/plans/types";

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
  /**
   * このツールを利用するために最低限必要なプラン区分（Phase 2-0）。
   *
   * "standard" -> 無料ユーザーも広告視聴で利用可能。スタンダード/プレミアム会員は広告なしで利用可能
   * "premium"  -> プレミアム会員のみ利用可能
   *
   * "free" は存在しない（standardが実質的な下限のため）。
   * 各ツールのUI側でプラン判定を直接書かず、必ず canUseTool() 経由で判定すること。
   */
  requiredPlan: RequiredPlan;
}
