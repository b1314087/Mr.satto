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
 * free    : 通常広告を表示しつつ、そのままダウンロード可能（現在の標準）
 * rewarded: リワード広告の視聴完了後にダウンロードが解除される（Phase 2以降で本実装）
 * premium : 広告なしで即ダウンロード（将来のPremiumプラン向け。現在は未実装）
 */
export const DEFAULT_DOWNLOAD_ACCESS_MODE: DownloadAccessMode = "free";
