/**
 * Google Ad Manager（Google Publisher Tag / GPT）Rewarded Ads関連の設定。
 *
 * 広告ユニットパス（例: /21775744923/mrsatto/rewarded_standard_access）は
 * それ自体が秘密情報ではなく、ブラウザ側のGPTタグへそのまま渡す公開設定値のため
 * NEXT_PUBLIC_ プレフィックスを使用する（既存の src/lib/ads/config.ts と同じ方針）。
 *
 * ネットワークコード・広告ユニット名をコード側で分けて組み立てず、
 * GAMダッシュボードに表示される「広告ユニットパス」をそのまま1つの環境変数として
 * 管理する（Phase 4 spec 24章：広告ユニット名・ネットワークIDをコードへ
 * ハードコードしない）。
 *
 * 実際のGAM広告ユニットが現在の環境に存在しない場合、このパスは空文字になる。
 * 架空のIDをでっち上げることはしない（Phase 3 spec 41章 / Phase 4 spec 6章）。
 * isRewardedAdConfigured()がfalseの間、ProductionRewardedAdServiceは
 * GPTへ一切接続せず、常に "unavailable" を返す
 * （広告を見ていないのに無条件でTemporary Accessが付与されることはない）。
 */
export const gamRewardedAdConfig = {
  /** GAMダッシュボードの「広告ユニットパス」（例: /21775744923/mrsatto/rewarded） */
  adUnitPath: (process.env.NEXT_PUBLIC_GAM_REWARDED_AD_UNIT_PATH ?? "").trim(),
};

/** Rewarded Ad用のGAM広告ユニットが設定されているか */
export function isRewardedAdConfigured(): boolean {
  return gamRewardedAdConfig.adUnitPath.length > 0;
}
