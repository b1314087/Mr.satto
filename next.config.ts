import type { NextConfig } from "next";

/**
 * Content-Security-Policy（Phase 6.5 セキュリティ監査で追加）。
 *
 * このアプリは Phase 5 で46以上のツールページを静的生成しており、SEO/表示速度上
 * 静的生成を維持する必要があるため、Proxy(src/proxy.ts) でnonceを発行して
 * 動的レンダリングに切り替える方式（Next.js公式ドキュメント推奨の「厳格な」方式）は
 * 採用しない（採用すると全ページが動的レンダリング必須になり、既存のSEO/パフォーマンス
 * 最適化を壊してしまうため。node_modules/next/dist/docs/01-app/02-guides/
 * content-security-policy.md 参照）。
 *
 * そのためnext.config.tsの静的headers()でCSPを設定する（同ドキュメントの
 * "Without Nonces" 方式）。この方式では script-src / style-src に 'unsafe-inline' が
 * 必要になる（詳細は下記コメント）。これは「安易な妥協」ではなく、以下を実際に
 * 調査した上での判断であり、最終報告書にも理由を明記する：
 *
 *   - script-src: next-themes（ThemeProvider）がFOUC防止のため、ページ読み込み時に
 *     実行される小さなインラインscriptタグをHTMLへ直接埋め込む実装になっている
 *     （node_modules/next-themes/dist/index.js を確認済み）。nonceを使わない
 *     静的CSPの下ではこのscriptにnonceを付与できないため、'unsafe-inline' なしでは
 *     テーマ切り替え機能自体が壊れる。
 *   - style-src: color-palette-tool / image-crop-tool / pomodoro-timer-tool /
 *     ad-slot.tsx が実行時に計算した値（色・座標・進捗率など、ユーザー入力の
 *     HTML文字列ではない）をReactの style={{...}} で描画しており、これはHTML上は
 *     インラインstyle属性になる。nonceを使わない静的CSPではこれらにもnonceを
 *     付与できない。
 *
 *   （本番ビルドを実際に起動してHTMLを確認したところ、Next.js自体もApp RouterのRSC
 *   ストリーミング用データ（self.__next_f.push(...)）をインラインscriptとして
 *   出力しており、これも 'unsafe-inline' なしでは動作しない。つまり
 *   'unsafe-inline' はnext-themes固有の事情というより、静的headers()方式でApp
 *   Routerを使う限りフレームワークレベルでほぼ避けられない制約であることを、
 *   実機検証で確認した。）
 *
 *   このアプリには他に dangerouslySetInnerHTML / innerHTML / insertAdjacentHTML の
 *   使用箇所は無く（json-ld.tsxのみで、渡す値は常にツールレジストリ由来の静的な
 *   構造化データであり、ユーザー入力ではないことを確認済み）、Reactの既定の
 *   エスケープが効いているため、script-src/style-src の 'unsafe-inline' を許可しても
 *   「ユーザー入力が直接HTML化されて実行される」という典型的なXSS経路は無い。
 *   CSPはこの経路以外（object-src/base-uri/form-action/frame-ancestors/connect-src等）
 *   でも十分な防御効果を持つため、この妥協を許容する。
 *
 * 広告(Google AdSense / Google Publisher Tag)関連ドメインは、現状コードから実際に
 * 参照している2つの読み込み元スクリプト（pagead2.googlesyndication.com /
 * securepubads.g.doubleclick.net。src/app/layout.tsx, src/lib/ads/gpt-loader.ts）と、
 * Googleが公式に案内している広告配信に必要な補助ドメインのみを許可し、
 * 広い"https:"のような包括的な許可は行わない。ただし本番のAdSense Publisher ID
 * (NEXT_PUBLIC_ADSENSE_CLIENT_ID)は本監査の時点で未設定（広告は未有効化）のため、
 * 実際の広告配信トラフィックに対して疎通確認はできていない。本番で広告を有効化した
 * 際にブラウザのCSP違反コンソールログを確認し、必要であれば追加調整すること
 * （最終報告書に明記）。
 *
 * Stripeは、Stripe.jsを埋め込まずCheckout/Customer Portalへリダイレクトするフローのみのため、
 * CSPへStripe向けの許可を追加する必要はない。
 */
const AD_SCRIPT_ORIGINS = "https://pagead2.googlesyndication.com https://securepubads.g.doubleclick.net";
const AD_FRAME_ORIGINS =
  "https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://pagead2.googlesyndication.com https://securepubads.g.doubleclick.net";

const SUPABASE_ORIGIN = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "https://*.supabase.co";
  try {
    return new URL(url).origin;
  } catch {
    return "https://*.supabase.co";
  }
})();

const CSP_DIRECTIVES = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${AD_SCRIPT_ORIGINS}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${SUPABASE_ORIGIN} ${AD_SCRIPT_ORIGINS}`,
  "worker-src 'self' blob:",
  `frame-src ${AD_FRAME_ORIGINS}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
];

const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");

/**
 * その他のセキュリティヘッダー（Phase 6.5）。
 * frame-ancestors 'none'（CSP）と X-Frame-Options: DENY を併用し、
 * CSPのframe-ancestorsに未対応の古いブラウザでもクリックジャッキングを防ぐ。
 * HSTSは preload を付けない（preloadはブラウザのプリロードリストへの登録が前提で、
 * 一度登録すると解除が難しいため、本番ドメインでの運用実績を積んだ上でユーザー自身が
 * 判断して追加すべき設定として今回は含めない）。
 */
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

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

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
