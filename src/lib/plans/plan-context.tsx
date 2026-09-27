"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Plan } from "./types";
import { shouldShowAds } from "./access";

/**
 * Phase 20: ツール詳細ページ（Server Component）が getServerPlan() で確定させた
 * サーバー側のプランを、ページ配下の深い階層にあるクライアントコンポーネント
 * （例: 各ツール実装の内部で使われる RewardedDownloadGate）へ、個々のツール
 * 実装ファイル（約70ファイル）をプランに対応させて回るような大規模な変更
 * （プロップのバケツリレー）なしに受け渡すための、表示専用のコンテキスト。
 *
 * 重要:
 * - これは「（Free向けの）通常のAdSlot広告を表示するかどうか」という
 *   見た目だけの判断に使う。ツールの利用可否そのもの（アクセス制御）は、
 *   従来どおり必ず ToolAccessGate が、getServerPlan() の結果をpropsで
 *   直接受け取って判定する（本コンテキストはToolAccessGateの判定には
 *   一切関与しない。詳細は src/lib/plans/access.ts の canUseTool()）。
 * - Providerで囲まれていない場所（Providerの外、または単体テストなど）から
 *   呼ばれた場合は、プラン不明として「広告を表示する」（true）という
 *   従来どおりの安全側の挙動にフォールバックする。これにより、この
 *   コンテキストを導入する前から広告を表示していた既存の呼び出し箇所・
 *   テストの挙動は一切変わらない。
 */
const CurrentPlanContext = createContext<Plan | null>(null);

export function CurrentPlanProvider({ plan, children }: { plan: Plan; children: ReactNode }) {
  return <CurrentPlanContext.Provider value={plan}>{children}</CurrentPlanContext.Provider>;
}

/**
 * ダウンロード導線まわりの「（Free向け）通常広告を表示すべきか」を返す。
 * Standard/Premiumユーザー（広告なしプラン）では false になり、
 * Providerがない/プラン不明な場合は true（従来どおり表示）にフォールバックする。
 *
 * 注意: この結果でダウンロードボタン自体を非表示・disabledにしてはならない
 * （広告の有無とダウンロード可否を結び付けない。開発指示書12章）。
 */
export function useShouldShowDownloadAds(): boolean {
  const plan = useContext(CurrentPlanContext);
  if (plan === null) return true;
  return shouldShowAds(plan);
}
