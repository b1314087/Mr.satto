/**
 * 機能スイッチ（広告・課金）。
 *
 * ■ 広告や課金を「入れる／切る」ときは、下の PRODUCTION_FLAGS の true / false を1か所だけ
 *   書き換えて、コミット・プッシュするだけでよい（Vercelの環境変数は触らない）。
 *
 *   ads     : 広告（通常の広告＋ダウンロード時のリワード広告）を出すか
 *   billing : 課金システム（料金・会員登録・ログイン導線・決済）を提供するか
 *
 * ■ 本番（NODE_ENV === "production"。Vercelの本番・プレビュー）は PRODUCTION_FLAGS の値を使う。
 * ■ 開発（next dev）とテストは、広告・課金まわりの既存テストがそのまま動くよう、常にオン。
 *   ただし、オフの状態を開発サーバーで確認したいときのために、
 *   NEXT_PUBLIC_FEATURES_OFF=1 を付けて起動すると、開発中でも両方オフになる
 *   （テスト専用。tests/regression/features-off.spec.ts が使う）。
 *   NEXT_PUBLIC_FEATURES_OFF=ads を付けると、広告だけがオフ（課金は有効）になる
 *   （課金を始める構成の確認用。tests/regression/launch-config.spec.ts が使う）。
 *
 * ■ このファイルの値はビルド時にコードへ埋め込まれる。値を変えたら再ビルド（＝再デプロイ）が必要。
 *   Vercelは main へのプッシュで自動的に再デプロイされる。
 *
 * ■ ads を true にしても、広告が実際に出るのは、従来どおり次の環境変数が設定済みの場合のみ
 *   （環境変数自体は削除せず、そのまま残しておけばよい）。
 *     NEXT_PUBLIC_ADSENSE_CLIENT_ID / NEXT_PUBLIC_ADSENSE_SLOT_*（通常の広告）
 *     NEXT_PUBLIC_GAM_REWARDED_AD_UNIT_PATH（ダウンロード時のリワード広告）
 */
export type FeatureName = "ads" | "billing";

/** 本番の設定。広告や課金を入れる／切るときは、ここだけを書き換える。 */
const PRODUCTION_FLAGS: Record<FeatureName, boolean> = {
  ads: false,
  billing: true,
};

function resolveFeature(name: FeatureName): boolean {
  if (process.env.NODE_ENV === "production") return PRODUCTION_FLAGS[name];
  // 開発・テスト: 常にオン。ただし、オフの確認用に上書きできる。
  //   NEXT_PUBLIC_FEATURES_OFF=1   広告・課金の両方をオフ（課金を始める前の本番と同じ）
  //   NEXT_PUBLIC_FEATURES_OFF=ads 広告だけをオフ（現在の本番と同じ。課金は有効）
  const off = process.env.NEXT_PUBLIC_FEATURES_OFF;
  if (off === "1") return false;
  if (off === "ads" && name === "ads") return false;
  return true;
}

export const featureFlags: Record<FeatureName, boolean> = {
  ads: resolveFeature("ads"),
  billing: resolveFeature("billing"),
};
