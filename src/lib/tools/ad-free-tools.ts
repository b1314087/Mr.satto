/**
 * 広告枠（ツールページ下・フッター）を出さないツール（工程8）。
 * 領収書・レシートのように、個人情報や取引内容を扱うツールの画面には、広告を並べない。
 * ここに並べたツールでは、ツールページ下の広告枠と、フッターの広告枠をどちらも描画しない。
 */
export const AD_FREE_TOOL_IDS: ReadonlySet<string> = new Set([
  "receipt-accounting-csv",
  // 2026-11-26 セキュリティ：パスワードを画面に表示・入力するツールでは、広告のプログラムを同じページで動かさない
  // （広告枠を出さないだけでなく、AdSenseのスクリプトも読み込まない。src/components/ads/adsense-loader.tsx）
  "password-generator",
  "pdf-password-protect",
]);

export function isAdFreeToolId(toolId: string): boolean {
  return AD_FREE_TOOL_IDS.has(toolId);
}

/** パス（/tools/<id> や /tools/<id>/ ）が、広告なしのツールのページかどうか */
export function isAdFreeToolPath(pathname: string | null): boolean {
  if (!pathname) return false;
  const match = /^\/tools\/([^/?#]+)\/?$/.exec(pathname);
  return match ? isAdFreeToolId(decodeURIComponent(match[1])) : false;
}
