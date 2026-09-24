"use client";

import { gamRewardedAdConfig, isRewardedAdConfigured } from "./gam-config";
import { loadGpt } from "./gpt-loader";
import type { Googletag, GptSlot, GptRewardedPayload } from "./gpt-types";

/**
 * Rewarded Ad（リワード広告）接続点の抽象層。
 *
 * Tool → Access Gate → Rewarded Ad → 利用許可
 *
 * 呼び出し側（RewardedAdCta / ToolAccessGate）はこのインターフェースにのみ依存し、
 * 実装の詳細を意識しない（Phase 4で `setRewardedAdService()` の差し替え先を
 * StubRewardedAdService から ProductionRewardedAdService へ実装した）。
 *
 * 重要な設計方針：
 *   - 「広告を見た」ことの正式な判定はGoogle Publisher Tag(GPT)の
 *     rewardedSlotGranted イベントのみを基準にする（表示開始・クローズだけでは
 *     grantedにしない。Phase 4 spec 9章・20章）。
 *   - 実際にStandard対象ツールの利用権限を付与する処理
 *     （TemporaryAccessService.grant()）は、このサービスの外側
 *     （RewardedAdCta）が watchAd() の戻り値を見てから1回だけ呼び出す。
 *     このファイルの中では一切Cookieを発行しない（責務の分離）。
 */

export type RewardResult = "granted" | "denied" | "unavailable";

/** UIへ状態遷移を逐次伝えるためのイベント（spec 8章の状態: loading/ready/showing/rewarded/closed/unavailable/error） */
export type RewardedAdState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "showing" }
  | { status: "rewarded"; payload: GptRewardedPayload | null }
  | { status: "closed" }
  | { status: "unavailable" }
  | { status: "error"; message: string };

export interface RewardedAdContext {
  toolId: string;
  /** 広告視聴フローの状態変化をUI側へ伝えるための任意コールバック */
  onStateChange?: (state: RewardedAdState) => void;
}

export interface RewardedAdService {
  /** リワード広告を表示し、視聴完了を待つ。正式なreward eventを受信できた場合のみ "granted" を返す */
  watchAd(context: RewardedAdContext): Promise<RewardResult>;
}

/**
 * 「同時に複数のRewarded Ad requestを発生させない」という制約
 * （Google Web Rewarded Adsの制約かつ Phase 4 spec 8章・13章・21章の要求）を
 * 実装間で共通化するための基底クラス。二重クリック等で watchAd() が
 * 短時間に複数回呼ばれても、進行中のPromiseをそのまま返すだけで、
 * 新しい広告リクエストは発生させない。
 */
abstract class SingleFlightRewardedAdService implements RewardedAdService {
  private inFlight: Promise<RewardResult> | null = null;

  async watchAd(context: RewardedAdContext): Promise<RewardResult> {
    if (this.inFlight) return this.inFlight;

    const promise = this.runWatchAd(context).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  protected abstract runWatchAd(context: RewardedAdContext): Promise<RewardResult>;
}

/**
 * 本番用のRewardedAdService実装。Google Ad Manager（Google Publisher Tag）の
 * Web Rewarded Ads公式APIに接続する。
 *
 * 参照した公式仕様（実装前に必ず確認。Phase 4 spec 4章）：
 *   - Google Ad Manager ヘルプ「Web向けRewarded Adsのトラフィック処理」
 *     https://support.google.com/admanager/answer/9116812
 *   - Google Publisher Tag 公式サンプル「Display a rewarded ad」
 *     https://developers.google.com/publisher-tag/samples/display-rewarded-ad
 *
 * フロー：
 *   1. defineOutOfPageSlot(adUnitPath, OutOfPageFormat.REWARDED) でスロットを定義
 *      （nullが返る場合は「利用不可」として扱う。公式サンプルの注意点通り）。
 *   2. rewardedSlotReady を購読。準備ができたら makeRewardedVisible() を呼び、
 *      実際に広告を表示する。Mr.Sattoではユーザーは既にCTAボタンのクリックで
 *      明示的に視聴を選択済みのため、ここで追加の確認ダイアログは挟まない
 *      （Phase 4 spec 4章・7章：広告表示前に必ず明確な説明とボタンでの
 *      明示操作を要求する、という要件は既にCTA側で満たしている）。
 *   3. rewardedSlotGranted を購読。これが発火した場合のみ「視聴成功」として扱う
 *      （表示開始やクローズだけでは付与しない。Phase 4 spec 9章）。
 *      同一視聴セッション内で複数回発火しても、最初の1回だけを採用する
 *      （Phase 4 spec 21章：広告の二重付与対策）。
 *   4. rewardedSlotClosed を購読。スロットを破棄し、rewardedSlotGranted が
 *      発火済みなら "granted"、そうでなければ "denied" として結果を確定する
 *      （Phase 4 spec 20章：reward未発生でのクローズはTemporary Accessを付与しない。
 *      reward発生済みでのクローズはその報酬を無効にしない）。
 *   5. 一定時間内に rewardedSlotReady が発火しない場合（広告在庫なし等）は、
 *      ハングさせずに "unavailable" として扱う。
 */
class ProductionRewardedAdService extends SingleFlightRewardedAdService {
  /** 広告在庫なし等でrewardedSlotReadyが来ない場合に備えたタイムアウト */
  private static readonly READY_TIMEOUT_MS = 12_000;

  protected async runWatchAd({ onStateChange }: RewardedAdContext): Promise<RewardResult> {
    if (!isRewardedAdConfigured()) {
      // 本番のGAM広告ユニットIDが未設定。架空のIDを使って広告を要求することはしない
      // （Phase 3 spec 41章・Phase 4 spec 6章）。無条件でTemporary Accessを
      // 付与しないよう、ここで確定的に unavailable を返す。
      onStateChange?.({ status: "unavailable" });
      return "unavailable";
    }

    onStateChange?.({ status: "loading" });

    let googletag: Googletag;
    try {
      googletag = await loadGpt();
    } catch {
      onStateChange?.({ status: "error", message: "広告SDKの読み込みに失敗しました。" });
      return "unavailable";
    }

    return new Promise<RewardResult>((resolve) => {
      let settled = false;
      let rewardGranted = false;
      let slot: GptSlot | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const onReady = (event: { slot: GptSlot; makeRewardedVisible: () => void }) => {
        if (event.slot !== slot) return;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        onStateChange?.({ status: "showing" });
        event.makeRewardedVisible();
      };

      const onGranted = (event: { slot: GptSlot; payload: GptRewardedPayload | null }) => {
        if (event.slot !== slot) return;
        // 同一視聴セッションでrewardedSlotGrantedが複数回発火しても、
        // 2回目以降は無視する（二重付与対策。実際の権限付与は呼び出し元が
        // watchAd()の戻り値を見て1回だけ行うため、ここでのガードは
        // 「rewarded状態の通知を1回に保つ」という表示上の意味も兼ねる）。
        if (rewardGranted) return;
        rewardGranted = true;
        onStateChange?.({ status: "rewarded", payload: event.payload });
      };

      const onClosed = (event: { slot: GptSlot }) => {
        if (event.slot !== slot) return;
        finish(rewardGranted ? "granted" : "denied");
      };

      const pubads = googletag.pubads();

      function cleanup() {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        pubads.removeEventListener("rewardedSlotReady", onReady);
        pubads.removeEventListener("rewardedSlotGranted", onGranted);
        pubads.removeEventListener("rewardedSlotClosed", onClosed);
        if (slot) {
          try {
            googletag.destroySlots([slot]);
          } catch {
            // 破棄に失敗しても致命的ではない
          }
        }
      }

      function finish(result: RewardResult) {
        if (settled) return;
        settled = true;
        cleanup();
        onStateChange?.({ status: "closed" });
        resolve(result);
      }

      googletag.cmd.push(() => {
        slot = googletag.defineOutOfPageSlot(
          gamRewardedAdConfig.adUnitPath,
          googletag.enums.OutOfPageFormat.REWARDED
        );

        if (!slot) {
          // ページがRewarded Adの要件（モバイル最適化ビューポート等）を
          // 満たしていない、広告ユニットパスが不正等。公式サンプルの
          // 「defineOutOfPageSlot() may return null」の注意点通り、必ずnullを考慮する。
          onStateChange?.({ status: "unavailable" });
          resolve("unavailable");
          settled = true;
          return;
        }

        slot.addService(pubads);
        pubads.addEventListener("rewardedSlotReady", onReady);
        pubads.addEventListener("rewardedSlotGranted", onGranted);
        pubads.addEventListener("rewardedSlotClosed", onClosed);

        timeoutId = setTimeout(() => {
          // 広告在庫なし等で一定時間内にrewardedSlotReadyが来ないケース。
          // ハングさせず「利用不可」として扱う。
          onStateChange?.({ status: "unavailable" });
          finish("unavailable");
        }, ProductionRewardedAdService.READY_TIMEOUT_MS);

        googletag.enableServices();
        googletag.display(slot);
      });
    });
  }
}

/** development / testの値を読み取るための、開発環境専用のCookie名 */
const DEV_AD_OUTCOME_COOKIE = "mrsatto-dev-ad-outcome";

type DevAdOutcome = "granted" | "granted-twice" | "denied" | "unavailable";

function readDevAdOutcome(): DevAdOutcome {
  if (typeof document === "undefined") return "granted";
  const prefix = `${DEV_AD_OUTCOME_COOKIE}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  const value = entry?.slice(prefix.length);
  if (value === "granted-twice" || value === "denied" || value === "unavailable") return value;
  return "granted";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 開発環境専用のスタブ実装。
 *
 * 重要：このクラスは開発環境（NODE_ENV === "development" / "test"）でのみ使われる
 * ように getRewardedAdService() 側でガードしている。本番ビルドでこのクラスが
 * 使われることはない（Phase 3 spec 19章・27章、Phase 4 spec 5章：
 * 「developmentだから権限無制限」という危険な条件分岐を本番へ持ち込まない）。
 *
 * mrsatto-dev-ad-outcome Cookie（development限定・本番では一切参照されない）で
 * 結果を切り替えられるようにし、Playwright等のE2Eテストから
 * 「広告Unavailable」「視聴途中クローズ」「二重reward event」といった異常系も
 * 実広告なしに再現できるようにする（Phase 4 spec 29章・30章：本番広告での検証を
 * 自動化しない。本番広告・テスト広告・Mockを明確に分離する）。
 */
class StubRewardedAdService extends SingleFlightRewardedAdService {
  protected async runWatchAd({ onStateChange }: RewardedAdContext): Promise<RewardResult> {
    const outcome = readDevAdOutcome();

    onStateChange?.({ status: "loading" });
    await delay(10);
    onStateChange?.({ status: "ready" });
    await delay(10);
    onStateChange?.({ status: "showing" });
    await delay(10);

    if (outcome === "unavailable") {
      onStateChange?.({ status: "unavailable" });
      return "unavailable";
    }

    if (outcome === "denied") {
      // rewardedSlotGrantedが発火しないままクローズされたケースを模す
      onStateChange?.({ status: "closed" });
      return "denied";
    }

    // granted / granted-twice: 実際のrewardedSlotGrantedイベント受信を模す。
    // granted-twiceは同一セッションで複数回イベントが発火しても
    // 二重付与されないことを確認するためのケース（呼び出し元は
    // watchAd()の戻り値="granted"を1回受け取るのみであることに変わりはない）。
    const payload: GptRewardedPayload = { type: "temporary-access", amount: 1 };
    onStateChange?.({ status: "rewarded", payload });
    if (outcome === "granted-twice") {
      onStateChange?.({ status: "rewarded", payload });
    }
    await delay(10);
    onStateChange?.({ status: "closed" });
    return "granted";
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
 *   1. setRewardedAdService() で明示的に差し替えられたサービス（テスト用モック等）
 *   2. development / test 環境 -> StubRewardedAdService（Playwright等での検証用。実広告には接続しない）
 *   3. それ以外（production） -> ProductionRewardedAdService
 *      （GAM広告ユニットIDが未設定の間は、このサービス自身が内部で
 *      常に "unavailable" を返す。Phase 4 spec 6章）
 */
export function getRewardedAdService(): RewardedAdService {
  if (explicitOverride) return explicitOverride;
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
    return new StubRewardedAdService();
  }
  return new ProductionRewardedAdService();
}
