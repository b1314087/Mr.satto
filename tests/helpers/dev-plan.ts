import type { BrowserContext } from "@playwright/test";

/**
 * Phase 11で追加された開発専用Cookie（NODE_ENV=development限定）を使い、
 * 本物のStripe/Supabaseに一切触れずにプラン状態・広告視聴結果を切り替えるヘルパー。
 *
 * 注意: これらのCookieは本番ビルド（NODE_ENV=production）では効果を持たない
 * ガードが本体コード側に入っている前提（Phase 11で確認済み）。
 * pricing/plan回帰テストは、このヘルパー経由のみで状態を作り、
 * 実際の課金・DB更新は一切発生させない。
 */

export type DevPlanOverride = "free" | "standard" | "premium";
/**
 * 疑似広告の結果。
 *   granted / granted-twice : 報酬付与イベントを受信した（後者は二重イベント）
 *   denied                  : 広告は配信されたが、報酬付与イベントなしで閉じられた（代替付与しない）
 *   unavailable             : 広告スロットを作成できない（slot-unavailable）
 *   sdk-failed              : GPT(gpt.js)の読み込みに失敗した
 *   timeout                 : 広告の準備完了が一定時間内に来なかった（在庫なし等）
 *   display-failed          : 広告の表示処理が失敗した
 *   not-configured          : 広告ユニット未設定（広告を要求すらしていない。代替付与しない）
 */
export type DevAdOutcome =
  | "granted"
  | "granted-twice"
  | "denied"
  | "unavailable"
  | "sdk-failed"
  | "timeout"
  | "display-failed"
  | "not-configured";

export async function setDevPlanOverride(context: BrowserContext, plan: DevPlanOverride, baseUrl: string) {
  await context.addCookies([
    {
      name: "mrsatto-dev-plan-override",
      value: plan,
      url: baseUrl,
    },
  ]);
}

export async function setDevAdOutcome(context: BrowserContext, outcome: DevAdOutcome, baseUrl: string) {
  await context.addCookies([
    {
      name: "mrsatto-dev-ad-outcome",
      value: outcome,
      url: baseUrl,
    },
  ]);
}

export async function clearDevOverrides(context: BrowserContext) {
  await context.clearCookies({ name: "mrsatto-dev-plan-override" });
  await context.clearCookies({ name: "mrsatto-dev-ad-outcome" });
}
