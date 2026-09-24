import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * "stripe" パッケージはNode.js向けとWorker（Cloudflare Workers等）向けで
   * 実装を出し分けており（package.jsonのexports条件分岐）、Next.jsのバンドラーに
   * 含めてしまうとVercelの実行環境（Node.js）で意図しない実装が読み込まれ、
   * "An error occurred with our connection to Stripe" というエラーで
   * Stripeとの通信が失敗することがある（Phase 3運用開始時に実際に発生・確認済み）。
   * serverExternalPackagesに指定することで、バンドルせずNode.js標準のrequireで
   * 読み込ませ、正しいNode.js向け実装を使わせる。
   */
  serverExternalPackages: ["stripe"],
};

export default nextConfig;
