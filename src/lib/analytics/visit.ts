import { createHmac } from "node:crypto";

/**
 * サイトの訪問数の集計（純粋な処理だけ。通信は src/app/api/analytics/visit/route.ts）。
 *
 * 個人を特定しない・Cookieを使わない方針:
 * - 保存するのは、日ごとの訪問者数と閲覧数だけ（supabase/migrations/0007_site_visits.sql）。
 * - 「同じ人が1日に何回来ても1人」と数えるための値は、日本時間の日付・IPアドレス・ブラウザの情報から、
 *   サーバーだけが持つ秘密の値で作る「元に戻せないハッシュ」。日付を混ぜるので、日をまたいで同じ人は追跡できない。
 *   IPアドレスやブラウザの情報そのものは、保存しない。
 */

/** ボットや自動の巡回（数えない）。ブラウザの情報に、これらが含まれる場合 */
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|curl|wget|python-requests|node-fetch|axios|go-http-client|facebookexternalhit/i;

export function isLikelyBot(userAgent: string | null | undefined): boolean {
  if (!userAgent || userAgent.trim() === "") return true;
  return BOT_RE.test(userAgent);
}

/** 数えないページ（管理画面・API・認証の受け口） */
const IGNORED_PREFIXES = ["/admin", "/api", "/auth", "/_next"];

/**
 * 画面から届いたパスを確認する。サイト内のパス（/ で始まる）だけを受け付け、数えないページは null。
 * 戻り値は、確認用（保存はしない）。
 */
export function parseVisitPath(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const path = (body as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return null;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) return null;
  const only = path.split(/[?#]/)[0];
  if (IGNORED_PREFIXES.some((p) => only === p || only.startsWith(`${p}/`))) return null;
  return only;
}

/** 日本時間の日付（YYYY-MM-DD） */
export function jstDateString(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** その日だけ有効な、訪問者の識別用ハッシュ（64文字の16進数） */
export function dailyVisitorHash(secret: string, ip: string, userAgent: string, now: Date): string {
  return createHmac("sha256", secret).update(`${jstDateString(now)}|${ip}|${userAgent}`).digest("hex");
}
