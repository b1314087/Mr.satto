/**
 * 「ツール一覧（/tools）」への移動を、画面内の他の部品へ知らせるための小さな仕組み。
 *
 * 背景:
 * - /tools の絞り込み状態（検索語・カテゴリ）は、ページを開いた時のURLを初期値として
 *   ToolsExplorer が自分で持つ。そのため、すでに /tools を開いている状態で
 *   メニューやヘッダー検索から /tools?category=pdf や /tools?q=画像 へ移動しても、
 *   URLだけが変わって一覧の絞り込みが変わらない、ということが起きる。
 * - 移動の直前にこのイベントを送り、ToolsExplorer が（開いていれば）絞り込みを合わせる。
 * - 画面を作り直す（再マウントする）のではなく、状態を合わせるだけにしている。
 */

export const TOOLS_NAVIGATE_EVENT = "ms:tools-navigate";

export interface ToolsNavigateDetail {
  query: string;
  category: string;
}

/** href が /tools（ツール一覧）本体を指していれば、検索語とカテゴリを取り出す。そうでなければ null。 */
export function parseToolsHref(href: string): ToolsNavigateDetail | null {
  let url: URL;
  try {
    url = new URL(href, "http://localhost");
  } catch {
    return null;
  }
  if (url.pathname !== "/tools") return null;
  return {
    query: url.searchParams.get("q") ?? "",
    category: url.searchParams.get("category") ?? "all",
  };
}

/** /tools へ移動する直前に呼ぶ。/tools 以外のhrefなら何もしない。 */
export function dispatchToolsNavigate(href: string): void {
  if (typeof window === "undefined") return;
  const detail = parseToolsHref(href);
  if (!detail) return;
  window.dispatchEvent(new CustomEvent<ToolsNavigateDetail>(TOOLS_NAVIGATE_EVENT, { detail }));
}
