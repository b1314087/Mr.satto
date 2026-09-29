/**
 * ダウンロードアクセスの種類（広告収益化 第1段階）。
 *
 * Tool Processing → Processed File → Download Gate → Download
 *
 * Download Gate（RewardedDownloadGateコンポーネント）はこのモードに応じて
 * ダウンロード直前の挙動を切り替える。現時点ではすべてのツールで "free" を使用する。
 */
export type DownloadAccessMode = "free" | "rewarded" | "premium";

/**
 * free    : 通常広告を表示しつつ、そのままダウンロード可能（現在の標準）。
 *           ただしStandard/Premium契約者（広告なしプラン）に対しては、
 *           RewardedDownloadGate内部のuseShouldShowDownloadAds()判定により
 *           このモードのままでも広告枠自体が表示されない（Phase 20）。
 * rewarded: リワード広告の視聴完了後にダウンロードが解除される（Phase 2以降で本実装。未接続）
 * premium : 広告なしで即ダウンロード。Standard/Premiumプラン自体はPhase 3で実装済みだが、
 *           上記のとおりfreeモードのまま広告非表示で対応できているため、
 *           このmode切り替え自体は現時点では未使用
 */
export const DEFAULT_DOWNLOAD_ACCESS_MODE: DownloadAccessMode = "free";
