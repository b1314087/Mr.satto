import type { FallbackGrantReason } from "./temporary-access-kinds";

/**
 * 広告が配信されなかった場合の「代替付与」を許可するかどうかの判定（ポリシー）。
 *
 * 判定（このファイル）と付与（src/lib/plans/temporary-access-actions.ts の
 * grantFallbackTemporaryAccess）を分離してある。将来、広告が安定して配信される
 * ようになり代替付与を制限したくなった場合は、このファイルの設定と判定だけを
 * 変更すればよい（付与処理・UI側は変更不要）。
 *
 * 現在（暫定運用）：制限なし。広告が配信されない場合は、毎回1時間の代替利用権を
 * 付与する。広告ブロッカーなどで代替付与が繰り返し発生すると、広告収益が
 * 減少する可能性がある。
 *
 * 将来「24時間に1回まで」などに制限する手順（今回は実施しない）：
 *   1. cooldownMs に 24 * 60 * 60 * 1000 を設定する。
 *   2. 「最後に代替付与した時刻」をサーバーが検証できる形で保持する。
 *      例：署名付きの長期Cookie。Cookieの追加は仕様変更（Cookie仕様の変更）に
 *      当たるため、運営者の指示を得てから行うこと。
 *   3. grantFallbackTemporaryAccess が、その保持した時刻を lastFallbackGrantedAtMs
 *      としてこの関数へ渡す（現在は常に null を渡している）。
 *
 * Cookieはブラウザ側で削除できるため、Cookieによる制限は完全な不正防止にはならない
 * （利用者が自分の端末のCookieを消せば回避できる）。
 */
export interface FallbackPolicyConfig {
  /** 代替付与の最小間隔(ms)。null = 制限なし（暫定） */
  cooldownMs: number | null;
}

export const FALLBACK_GRANT_POLICY: FallbackPolicyConfig = {
  cooldownMs: null,
};

export interface FallbackGrantRequest {
  reason: FallbackGrantReason;
  nowMs: number;
  /** 最後に代替付与した時刻(ms epoch)。記録がない場合は null */
  lastFallbackGrantedAtMs: number | null;
}

export type FallbackGrantDecision =
  | { allowed: true }
  | { allowed: false; denial: "cooldown"; retryAfterMs: number };

export function decideFallbackGrant(
  request: FallbackGrantRequest,
  config: FallbackPolicyConfig = FALLBACK_GRANT_POLICY
): FallbackGrantDecision {
  if (config.cooldownMs === null || request.lastFallbackGrantedAtMs === null) {
    return { allowed: true };
  }
  const elapsed = request.nowMs - request.lastFallbackGrantedAtMs;
  if (elapsed < config.cooldownMs) {
    return { allowed: false, denial: "cooldown", retryAfterMs: config.cooldownMs - elapsed };
  }
  return { allowed: true };
}
