import type { FallbackGrantReason } from "./temporary-access-kinds";

/**
 * 広告が配信されなかった場合の「救済」（代替付与）を許可するかどうかの判定（ポリシー）。
 *
 * 判定（このファイル）と付与（src/lib/plans/temporary-access-actions.ts の grantFallbackTemporaryAccess）を分けてある。
 *
 * 2026-11（総合改修）：救済は「1人につき1日1回」（日本時間の日付で切り替わる）。
 * - 広告ブロッカー・広告配信のエラーで広告が出ないときだけ使える（理由は temporary-access-kinds.ts の FALLBACK_GRANT_REASONS）。
 *   広告を途中で閉じた（広告は出ている）場合は、救済の対象にしない。
 * - 「今日もう使ったか」は、サーバーで2つの記録を見て決める（src/lib/plans/fallback-claim.ts）：
 *     1. データベース（Supabase の ad_fallback_daily。1日だけ有効な、元に戻せない識別値だけを保存）
 *        ログイン中はユーザーごと、未ログインは接続元とブラウザの情報から作る、その日だけの識別値ごと。
 *        同じ識別値の行は1日1つしか作れないので、連打・複数タブで同時に実行しても、1回しか通らない。
 *     2. 署名付きのCookie（今日使った印）。データベースを使えない間も、同じブラウザでは1日1回にする。
 *   Cookieは利用者が消せるので、Cookieだけでは完全な不正防止にならない（データベースの記録が本命）。
 */
export interface FallbackPolicyConfig {
  /** 1日（日本時間）に救済できる回数。null = 制限なし */
  perDay: number | null;
}

export const FALLBACK_GRANT_POLICY: FallbackPolicyConfig = {
  perDay: 1,
};

export interface FallbackGrantRequest {
  reason: FallbackGrantReason;
  /** 今日（日本時間）すでに救済した回数 */
  usedToday: number;
}

export type FallbackGrantDecision = { allowed: true } | { allowed: false; denial: "daily-limit" };

export function decideFallbackGrant(request: FallbackGrantRequest, config: FallbackPolicyConfig = FALLBACK_GRANT_POLICY): FallbackGrantDecision {
  if (config.perDay === null) return { allowed: true };
  return request.usedToday < config.perDay ? { allowed: true } : { allowed: false, denial: "daily-limit" };
}
