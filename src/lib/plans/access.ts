import type { Plan, RequiredPlan } from "./types";
import { PLAN_DEFINITIONS } from "./types";

/**
 * 「利用できるか」と「利用できるが広告が必要か」は別概念として分離する。
 *
 * allowed:false のとき adRequired は常に false（不可の理由は広告ではなくプラン不足）。
 */
export type ToolAccessResult =
  | { allowed: true; adRequired: boolean }
  | { allowed: false; adRequired: false };

/**
 * 権限判定ロジックの唯一の場所。
 * 「現在のユーザープランで、このrequiredPlanのツールを使えるか」をここでのみ判定し、
 * 各ツールのUIへ判定ロジックをバラバラに書かないこと（コンポーネント側は
 * この関数の戻り値を見て表示を出し分けるだけにする）。
 *
 * ルール:
 *   free    × standard tool → 利用可能・広告必要
 *   free    × premium tool  → 利用不可
 *   standard× standard tool → 利用可能・広告不要
 *   standard× premium tool  → 利用不可
 *   premium × standard tool → 利用可能・広告不要
 *   premium × premium tool  → 利用可能・広告不要
 */
export function canUseTool(plan: Plan, requiredPlan: RequiredPlan): ToolAccessResult {
  if (requiredPlan === "premium") {
    if (plan === "premium") return { allowed: true, adRequired: false };
    return { allowed: false, adRequired: false };
  }

  // requiredPlan === "standard"
  if (plan === "free") return { allowed: true, adRequired: true };
  return { allowed: true, adRequired: false }; // standard / premium
}

/**
 * このプランのユーザーに（通常の）広告を表示すべきか。
 * free → true / standard → false / premium → false。
 *
 * 各ページへ直接 `plan === "free"` のような判定を書かず、必ずこの関数を経由する。
 * 注意: 現時点ではAdSense広告枠（Header/Tool page/Footer/Before/After download）の
 * 表示・非表示切り替えには未接続。既存のAdSense実装を壊さないため、
 * 接続は将来（ログイン・決済基盤が揃った時点）に行う想定。
 */
export function shouldShowAds(plan: Plan): boolean {
  return PLAN_DEFINITIONS[plan].adsRequired;
}
