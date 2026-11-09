import type { Plan } from "./types";
import { featureFlags } from "@/lib/config/features";
import { canUseTool } from "./access";
import { effectiveRequiredPlan } from "@/lib/tools/data";

/**
 * ツールの中の「一部の機能」だけをプレミアム限定にするときの判定（工程4）。
 *
 * ツールそのものの利用可否は、これまでどおり ToolAccessGate（src/lib/plans/access.ts の canUseTool）が
 * ツール単位で判定する。ToolAccessGate はツール全体を開く／閉じるだけで、ツールの中の一部の機能だけを
 * 閉じる仕組みは持っていないため、ツールの中のプレミアム機能は、ツールの画面の中でこの関数を使って出し分ける。
 *
 * 機能の種類（scope）:
 * - "premium-only"：新しく追加したプレミアムの機能（電子印鑑の複数ページ押印）。
 *   Premium 一括処理（src/lib/batch/batch-config.ts の canUseBatch）と同じルール：プレミアムだけが使える。
 * - "premium-tool"：もともとプレミアム限定のツールだった機能を、統合でほかのツールの一部にしたもの（旧OCR）。
 *   元のツールと同じ条件で使える（全ツールをスタンダード扱いにする運用スイッチ ALL_TOOLS_STANDARD がオンの間は、
 *   スタンダードのツールと同じ条件。統合によって、今まで使えていた人が使えなくなることはない）。
 * どちらも、課金の機能スイッチがオフ（プランが存在しない状態）の間は、だれでも使える。
 *
 * - これは画面の出し分け用。処理を始める直前には、サーバーでもプランを確認する
 *   （src/lib/plans/premium-feature-actions.ts の checkPremiumFeatureAccess）。
 * - 新しい課金・新しいプラン・Stripe/Supabase の変更は行わない（既存のプラン判定をそのまま使う）。
 */
export type PremiumFeatureScope = "premium-only" | "premium-tool";

export function canUsePremiumFeature(plan: Plan | null, scope: PremiumFeatureScope = "premium-only"): boolean {
  if (!featureFlags.billing) return true;
  if (scope === "premium-tool") return canUseTool(plan ?? "free", effectiveRequiredPlan("premium")).allowed;
  return plan === "premium";
}
