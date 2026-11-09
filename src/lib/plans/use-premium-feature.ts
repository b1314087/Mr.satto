"use client";

import { useState } from "react";
import { useCurrentPlan } from "./plan-context";
import { featureFlags } from "@/lib/config/features";
import { canUsePremiumFeature, type PremiumFeatureScope } from "./premium-feature";
import { checkPremiumFeatureAccess } from "./premium-feature-actions";

/**
 * ツールの中のプレミアム機能を出し分ける（工程4。src/lib/plans/premium-feature.ts）。
 * - allowed：画面に出すかどうか（ページを開いた時点のプラン）
 * - confirm()：プレミアム機能で処理を始める直前に呼ぶ。サーバーでプランを確かめ、使えなければ false
 *   （その後は allowed も false になる）
 */
export function usePremiumFeature(scope: PremiumFeatureScope = "premium-only") {
  const plan = useCurrentPlan();
  const [revoked, setRevoked] = useState(false);
  const allowed = canUsePremiumFeature(plan, scope) && !revoked;

  async function confirm(): Promise<boolean> {
    if (!featureFlags.billing) return true;
    let ok = false;
    try {
      ok = await checkPremiumFeatureAccess(scope);
    } catch {
      ok = false;
    }
    if (!ok) setRevoked(true);
    return ok;
  }

  return { allowed, revoked, confirm };
}
