"use server";

import { getServerPlan } from "@/lib/plans/current-plan";
import { canUsePremiumFeature, type PremiumFeatureScope } from "./premium-feature";

/**
 * ツールの中のプレミアム機能（電子印鑑の複数ページ押印、PDF→テキストの画像OCRなど）を使う直前に、
 * サーバーで現在のプランを確認する（画面の表示だけに頼らない）。
 * ファイルの中身はサーバーへ送らない（プランの確認だけを行う）。
 */
export async function checkPremiumFeatureAccess(scope: PremiumFeatureScope = "premium-only"): Promise<boolean> {
  const { plan } = await getServerPlan();
  return canUsePremiumFeature(plan, scope === "premium-tool" ? "premium-tool" : "premium-only");
}
