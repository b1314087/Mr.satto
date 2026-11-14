import { createHmac, timingSafeEqual } from "node:crypto";
import { jstDateString } from "@/lib/analytics/visit";

/**
 * 広告が出ないときの救済（1日1回）の記録に使う、純粋な処理（通信・Cookieの読み書きはしない。テストしやすいように分けてある）。
 * 実際の記録は src/lib/plans/fallback-claim.ts（server-only）が行う。
 */

/** Cookie の名前（今日救済を使った印。署名付きで、日付だけを持つ） */
export const FALLBACK_MARK_COOKIE = "mrsatto_ad_fallback";

/** 救済を受ける人の識別（ログイン中はユーザーID、未ログインは接続元とブラウザの情報） */
export type FallbackIdentity = { kind: "user"; userId: string } | { kind: "anonymous"; ip: string; userAgent: string };

/**
 * その日だけ有効な、元に戻せない識別値（64文字の16進数）。データベースにはこの値だけを保存する。
 * 日付を混ぜるので、日をまたいで同じ人を追跡できない（サイトの訪問数の集計 src/lib/analytics/visit.ts と同じ考え方）。
 */
export function fallbackClaimantHash(secret: string, identity: FallbackIdentity, now: Date): string {
  const who = identity.kind === "user" ? `u:${identity.userId}` : `a:${identity.ip}|${identity.userAgent}`;
  return createHmac("sha256", secret).update(`ad-fallback|${jstDateString(now)}|${who}`).digest("hex");
}

function markSignature(secret: string, date: string): string {
  return createHmac("sha256", secret).update(`ad-fallback-mark|${date}`).digest("base64url");
}

/** 「この日に救済を使った」印（Cookie の値） */
export function signFallbackMark(secret: string, now: Date): string {
  const date = jstDateString(now);
  return `v1.${date}.${markSignature(secret, date)}`;
}

/** Cookie の印が、今日（日本時間）のもので、署名も正しいか */
export function isFallbackMarkForToday(secret: string, value: string | undefined | null, now: Date): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, date, signature] = parts;
  if (date !== jstDateString(now)) return false;
  const expected = Buffer.from(markSignature(secret, date));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** 日本時間の次の0時までのミリ秒（Cookie の有効期限に使う。最低1分） */
export function msUntilNextJstMidnight(now: Date): number {
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const next = Math.floor(jstMs / dayMs + 1) * dayMs;
  return Math.max(60_000, next - jstMs);
}
