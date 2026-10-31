/**
 * 広告枠（ツールページ下・フッター）を出さないツール（工程8）。
 * 領収書・レシートのように、個人情報や取引内容を扱うツールの画面には、広告を並べない。
 * ここに並べたツールでは、ツールページ下の広告枠と、フッターの広告枠をどちらも描画しない。
 */
export const AD_FREE_TOOL_IDS: ReadonlySet<string> = new Set(["receipt-accounting-csv"]);

export function isAdFreeToolId(toolId: string): boolean {
  return AD_FREE_TOOL_IDS.has(toolId);
}

/** パス（/tools/<id> や /tools/<id>/ ）が、広告なしのツールのページかどうか */
export function isAdFreeToolPath(pathname: string | null): boolean {
  if (!pathname) return false;
  const match = /^\/tools\/([^/?#]+)\/?$/.exec(pathname);
  return match ? isAdFreeToolId(decodeURIComponent(match[1])) : false;
}
