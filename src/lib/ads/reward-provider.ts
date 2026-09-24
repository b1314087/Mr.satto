/**
 * Rewarded Ad（リワード広告）接続点の抽象層。
 *
 * Tool → Access Gate → Rewarded Ad → 利用許可
 *
 * ここでは実際の広告ネットワークSDK（Google Rewarded Ads / Offerwall 等）には
 * 接続しない。呼び出し側（ToolAccessGate）はこのインターフェースにのみ依存し、
 * 実装の詳細を意識しない状態にしておくことで、将来 `setRewardedAdService()` で
 * 本実装に差し替えるだけで済むようにする。
 */

export type RewardResult = "granted" | "denied" | "unavailable";

export interface RewardedAdService {
  /** リワード広告を表示し、視聴完了を待つ。視聴完了で "granted" を返す */
  watchAd(context: { toolId: string }): Promise<RewardResult>;
}

/**
 * 開発環境専用のスタブ実装。常に即座に "granted" を返す。
 *
 * 重要：このクラスは開発環境（NODE_ENV === "development"）でのみ使われる
 * ように getRewardedAdService() 側でガードしている。本番ビルドでこのクラスが
 * 使われることはない（Phase 3 spec 19章・27章：
 * 「developmentだから権限無制限」という危険な条件分岐を本番へ持ち込まない）。
 */
class StubRewardedAdService implements RewardedAdService {
  async watchAd(): Promise<RewardResult> {
    return "granted";
  }
}

/**
 * 本番用の広告ネットワークがまだ接続されていない場合に使うプレースホルダー実装。
 *
 * Google系Rewarded広告等の本番設定値（広告ユニットID等）が現在の環境に
 * 存在しないため、存在しないIDやダミー設定を捏造することはしない
 * （Phase 3 spec 41章）。本番で実際の広告ネットワークを導入する際は、
 * このクラスの代わりに実際のSDKへ接続する RewardedAdService 実装を作り、
 * アプリ起動時に setRewardedAdService() で差し替えること。
 *
 * それまでの間、本番環境でこのサービスは常に "unavailable" を返す
 * （＝広告を見ていないのに無条件でTemporary Accessが付与されることはない）。
 */
class UnconfiguredRewardedAdService implements RewardedAdService {
  async watchAd(): Promise<RewardResult> {
    return "unavailable";
  }
}

let explicitOverride: RewardedAdService | null = null;

/**
 * 将来、本実装の RewardedAdService に差し替えるための注入口。
 * 一度呼び出すと、環境に関わらずその実装が使われる。
 */
export function setRewardedAdService(service: RewardedAdService): void {
  explicitOverride = service;
}

/**
 * 現在利用中の RewardedAdService を取得する。
 *
 * 優先順位:
 *   1. setRewardedAdService() で明示的に差し替えられたサービス（本番実装・テスト用モック等）
 *   2. development環境 -> StubRewardedAdService（常にgranted。ローカル動作確認用）
 *   3. それ以外（本番でまだ広告ネットワーク未接続） -> UnconfiguredRewardedAdService（常にunavailable）
 */
export function getRewardedAdService(): RewardedAdService {
  if (explicitOverride) return explicitOverride;
  if (process.env.NODE_ENV === "development") return new StubRewardedAdService();
  return new UnconfiguredRewardedAdService();
}
