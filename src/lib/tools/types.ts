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
  | "csv-excel"
  | "word"
  | "pptx"
  | "video"
  | "audio"
  | "file"
  | "generator"
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
   * 指定した総合ツール（ツールID）に統合済みであること。
   * 統合済みのツールは、個別URL・SEOページ・実装はそのまま残すが、ツール一覧・検索・
   * カテゴリ一覧・関連ツール・おすすめには「独立したカード」として出さない
   * （総合ツールの画面から操作を切り替えて使える。総合ツールのページに専用ページへのリンクを置く）。
   */
  mergedInto?: string;
  /**
   * 関連ツールに、同じカテゴリのツールより先に出したいツールのID（最大2件程度）。
   * 単独のカテゴリなどで、他のページからの導線が自然に生まれにくいツールへ、使う場面が近いツールから
   * リンクするために使う（例: Officeの書類を扱うツール同士）。存在しない・準備中のIDは無視される。
   * 選び方は src/lib/tools/related-tools.ts。
   */
  relatedToolIds?: string[];
  /**
   * AI機能が入っているツールの印（一覧のカードに「AI実装」と出す）。
   * - "local": 端末（ブラウザ）の中で動くAIモデルを使う。いつでも表示する。
   * - "cloud": 利用者の同意のうえで外部のAIサービスへ送信する補助機能（プレミアム限定）。
   *   課金の機能スイッチがオフの間はこの機能自体が使えないため、印も出さない。
   * 指定しないツールは、AIを使わない。
   */
  hasAi?: "local" | "cloud";
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
