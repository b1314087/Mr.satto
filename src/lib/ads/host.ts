import { useSyncExternalStore } from "react";
import { CANONICAL_HOST } from "@/lib/config/site";

/**
 * 広告を出してよいホスト名か（2026-11-16）。
 *
 * 広告を出すのは正式なドメイン mrsatto.com だけ。www.mrsatto.com・〇〇.vercel.app・プレビュー・localhost・その他では出さない
 * （AdSenseの審査は mrsatto.com で受けており、ほかのアドレスで広告を出すと、無効な表示やポリシーの問題になりうるため）。
 * 広告全体のオン・オフ（featureFlags.ads）と、プランごとの判定は、これまでどおり別に行う（ここはホスト名だけを見る）。
 *
 * 例外：開発サーバー（NODE_ENV が production 以外）で、環境変数 NEXT_PUBLIC_ADS_TEST_HOSTS にあるホスト名は許可する
 * （自動テストが localhost で広告の流れを確かめるため。playwright.config.ts だけが設定する。本番のビルドでは無視される）。
 */
export function isAdHostAllowed(hostname: string | null | undefined): boolean {
  const host = (hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host === CANONICAL_HOST) return true;
  if (process.env.NODE_ENV !== "production") {
    const testHosts = (process.env.NEXT_PUBLIC_ADS_TEST_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    return testHosts.includes(host);
  }
  return false;
}

/** ブラウザで、いま開いているページのホスト名が広告を出してよいものか（サーバーでは常に false） */
export function isCurrentHostAdAllowed(): boolean {
  if (typeof window === "undefined") return false;
  return isAdHostAllowed(window.location.hostname);
}

const noopSubscribe = () => () => {};

/**
 * Reactの部品用：いま開いているページのホスト名で広告を出してよいか。
 * サーバーでの表示と最初の描画は false（出さない側）、ブラウザで確かめたあとに true になる（表示の食い違いを起こさない）。
 */
export function useAdHostAllowed(): boolean {
  return useSyncExternalStore(noopSubscribe, isCurrentHostAdAllowed, () => false);
}
