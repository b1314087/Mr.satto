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
 * Phase 2-0 時点のスタブ実装。
 *
 * 実際の広告ネットワークSDKにまだ接続していないため、常に即座に "granted" を返す。
 * これにより、この権限基盤を導入したことで現在利用できているツールが
 * 突然使えなくなる、という回帰を防いでいる（無料ユーザーは広告視聴の導線を
 * 一度通過するが、実際の広告は表示されない）。
 *
 * 本実装（Google Rewarded Ads / Offerwall 等）に差し替える際は、
 * このクラスと同じ `RewardedAdService` を実装したクラスを作り、
 * `setRewardedAdService()` で差し替えるだけでよい。AdSense本体の設定や
 * 既存の広告枠（Header/Tool page/Footer/Before/After download）には触れない。
 */
class StubRewardedAdService implements RewardedAdService {
  async watchAd(): Promise<RewardResult> {
    return "granted";
  }
}

let currentService: RewardedAdService = new StubRewardedAdService();

/** 将来、本実装の RewardedAdService に差し替えるための注入口 */
export function setRewardedAdService(service: RewardedAdService): void {
  currentService = service;
}

/** 現在利用中の RewardedAdService を取得する */
export function getRewardedAdService(): RewardedAdService {
  return currentService;
}
