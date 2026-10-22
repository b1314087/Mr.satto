/**
 * 決済（Stripe Checkout・契約管理）やメールのリンクが戻ってくる先のURL（NEXT_PUBLIC_SITE_URL）が、
 * 本番で使える値かどうかの判定（純粋な関数。通信はしない）。
 *
 * 未設定のとき siteConfig.url は仮の値（example.vercel.app）になる。この値のまま決済を受け付けると、
 * 支払い後に別のサイトへ戻されてしまうため、本番では仮の値・http・不正なURLの間は決済を始めさせない。
 * 開発・テスト（NODE_ENV が production 以外）では判定しない。
 */
export type SiteUrlIssue = "placeholder" | "not_https" | "invalid";

export function siteUrlIssue(url: string, nodeEnv: string | undefined): SiteUrlIssue | null {
  if (nodeEnv !== "production") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "https:") return "not_https";
  const host = parsed.hostname.toLowerCase();
  if (host === "example.vercel.app" || host.startsWith("example.") || host === "localhost" || host.endsWith(".localhost")) return "placeholder";
  return null;
}
