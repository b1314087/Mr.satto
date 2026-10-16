/**
 * 一時利用権（Temporary Access）の「種別」と、広告が配信されなかった理由の共有定義。
 *
 * このファイルは "use server" でも "server-only" でもない、ただの定数・型モジュール。
 * サーバー側（トークン検証・Server Action）とクライアント側（広告サービス・
 * ダウンロードダイアログ）の両方から同じ定義を参照するために分けている
 * （"use server" ファイルは非同期関数以外をexportできないため、定数はここに置く）。
 *
 * 重要な区別：
 *   - "ad"       : Googleの正式な報酬付与イベント(rewardedSlotGranted)を確認した上で
 *                  発行された利用権。広告を実際に視聴した結果。
 *   - "fallback" : 広告自体が配信されなかった（SDK読み込み失敗・在庫なし等）ため、
 *                  暫定的に発行した代替の利用権。広告は視聴されていない。
 *
 * "fallback" を「広告視聴」や「広告収益の発生」として扱ってはならない。
 * 種別は署名付きトークンの中に含まれ、利用者が書き換えることはできない
 * （src/lib/plans/temp-access-token.ts）。
 */

/** 一時利用権の種別 */
export type TemporaryAccessKind = "ad" | "fallback";

/**
 * 広告が配信されなかったと判断でき、代替付与の対象になり得る理由。
 *
 *   sdk-load-failed  : GPT(gpt.js)の読み込みに失敗した、またはSDKが使える状態でなかった。
 *                      広告ブロッカーと通常のネットワーク障害は区別できない。
 *   slot-unavailable : 広告スロットを作成できなかった（defineOutOfPageSlotがnull等）。
 *   ad-timeout       : 一定時間内に広告の準備完了(rewardedSlotReady)が来なかった（在庫なし等）。
 *   display-failed   : 広告の準備はできたが、表示処理が例外で失敗した。
 *
 * 「広告を途中で閉じた」（報酬付与イベントなしでクローズ）は広告自体は配信されて
 * いるため、ここには含めない（代替付与の対象外。通常の "denied" として扱う）。
 */
export const FALLBACK_GRANT_REASONS = [
  "sdk-load-failed",
  "slot-unavailable",
  "ad-timeout",
  "display-failed",
] as const;

export type FallbackGrantReason = (typeof FALLBACK_GRANT_REASONS)[number];

export function isFallbackGrantReason(value: unknown): value is FallbackGrantReason {
  return typeof value === "string" && (FALLBACK_GRANT_REASONS as readonly string[]).includes(value);
}
