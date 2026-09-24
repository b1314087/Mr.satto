/**
 * Google Publisher Tag (GPT) のうち、Mr.SattoのRewarded Ad実装が
 * 実際に使用する範囲だけを対象にした最小限の型定義。
 *
 * 公式の型定義パッケージ（google-publisher-tag-types等）を新たな依存として
 * 追加するのではなく、必要な範囲だけをここで宣言する
 * （プロジェクト全体として依存パッケージを増やしすぎない方針。Phase 4 spec 41章の
 * 「不要な全面リファクタリング禁止」の精神に合わせ、依存関係も最小限に保つ）。
 *
 * 参照：Google Ad Manager公式ヘルプ「Web向けRewarded Adsのトラフィック処理」
 * https://support.google.com/admanager/answer/9116812
 * および Google Publisher Tag公式サンプル「Display a rewarded ad」
 * https://developers.google.com/publisher-tag/samples/display-rewarded-ad
 */

/** rewardedSlotGranted イベントに含まれる報酬内容 */
export interface GptRewardedPayload {
  type: string;
  amount: number;
}

export interface GptSlot {
  addService(service: GptPubAdsService): GptSlot;
}

export interface GptRewardedSlotReadyEvent {
  slot: GptSlot;
  /**
   * 広告の準備ができたことをGPTへ伝え、実際に画面へ表示させる。
   * Mr.Sattoでは、ユーザーは既にCTAボタンのクリック時点で視聴を明示的に選択して
   * いるため（Phase 4 spec 4章・7章）、このイベント内で改めてconfirm()等の
   * 確認ダイアログは挟まず、準備ができ次第すぐに呼び出す。
   */
  makeRewardedVisible(): void;
}

export interface GptRewardedSlotGrantedEvent {
  slot: GptSlot;
  payload: GptRewardedPayload | null;
}

export interface GptRewardedSlotClosedEvent {
  slot: GptSlot;
}

interface GptRewardedEventMap {
  rewardedSlotReady: GptRewardedSlotReadyEvent;
  rewardedSlotGranted: GptRewardedSlotGrantedEvent;
  rewardedSlotClosed: GptRewardedSlotClosedEvent;
}

export interface GptPubAdsService {
  addEventListener<K extends keyof GptRewardedEventMap>(
    type: K,
    listener: (event: GptRewardedEventMap[K]) => void
  ): GptPubAdsService;
  removeEventListener<K extends keyof GptRewardedEventMap>(
    type: K,
    listener: (event: GptRewardedEventMap[K]) => void
  ): GptPubAdsService;
}

/** OutOfPageFormat列挙値。実行時の値そのものはGPTライブラリが提供する */
export type GptOutOfPageFormat = string & { readonly __gptOutOfPageFormatBrand: unique symbol };

export interface Googletag {
  cmd: Array<() => void>;
  enums: {
    OutOfPageFormat: {
      REWARDED: GptOutOfPageFormat;
    };
  };
  defineOutOfPageSlot(adUnitPath: string, div: string | GptOutOfPageFormat): GptSlot | null;
  pubads(): GptPubAdsService;
  enableServices(): void;
  display(slot: GptSlot): void;
  destroySlots(slots: GptSlot[]): void;
}

declare global {
  interface Window {
    googletag?: Googletag;
  }
}
