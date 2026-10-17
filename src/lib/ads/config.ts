import { featureFlags } from "@/lib/config/features";

/**
 * 広告関連の設定を一元管理する。
 *
 * 現時点ではGoogle AdSenseの審査・広告IDが存在しないため、
 * 環境変数が未設定の場合は自動的に「広告無効」として扱い、
 * AdSlotコンポーネントはプレースホルダー表示にフォールバックする
 * （広告IDをコード中に直接ハードコードしない）。
 *
 * 秘密情報ではない公開設定値のため NEXT_PUBLIC_ プレフィックスを使用する。
 * Vercelの環境変数設定では type: Config（公開設定値）として登録すればよい。
 */
export const adConfig = {
  /** AdSenseの発行者ID（例: ca-pub-xxxxxxxxxxxxxxxx）。未設定時は空文字 */
  adsenseClientId: process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID ?? "",

  /** 広告枠ごとのスロットID。AdSense審査通過後に発行されるIDをここに割り当てる想定 */
  slots: {
    header: process.env.NEXT_PUBLIC_ADSENSE_SLOT_HEADER ?? "",
    toolPage: process.env.NEXT_PUBLIC_ADSENSE_SLOT_TOOL_PAGE ?? "",
    footer: process.env.NEXT_PUBLIC_ADSENSE_SLOT_FOOTER ?? "",
    preDownload: process.env.NEXT_PUBLIC_ADSENSE_SLOT_PRE_DOWNLOAD ?? "",
    postDownload: process.env.NEXT_PUBLIC_ADSENSE_SLOT_POST_DOWNLOAD ?? "",
  },
};

/**
 * 通常の広告（AdSense）を配信できる状態か。
 *
 * 機能スイッチ（src/lib/config/features.ts の featureFlags.ads）がオフの間は、
 * 広告IDが設定済みでも配信しない（広告スクリプトの読み込みも行わない）。
 * スイッチがオンで、かつ AdSenseクライアントIDが設定されているときだけ true。
 */
export function isAdsEnabled(): boolean {
  return featureFlags.ads && adConfig.adsenseClientId.length > 0;
}
