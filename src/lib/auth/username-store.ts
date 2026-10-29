import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeUsername } from "./username";

/** ILIKE の特別な文字（\\ % _）を、文字そのものとして扱うために打ち消す */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * ユーザー名が、既に使われているか（大文字・小文字を区別しない）。
 * excludeUserId を渡すと、その会員自身の行は数えない（自分の名前を保存し直すとき）。
 * 確認できなかったとき（接続設定なし・DBエラー）は、例外にする（呼び出し側が、DBの一意制約に任せるか、断るかを決める）。
 */
export async function isUsernameTaken(
  client: SupabaseClient | null,
  username: string,
  excludeUserId?: string,
): Promise<boolean> {
  if (!client) throw new Error("service-client-unavailable");
  let query = client.from("profiles").select("id").ilike("username", escapeLike(normalizeUsername(username))).limit(1);
  if (excludeUserId) query = query.neq("id", excludeUserId);
  const { data, error } = await query;
  if (error) throw new Error("username-check-failed");
  return (data?.length ?? 0) > 0;
}

/**
 * ログイン中の本人のユーザー名を読む（本人の行だけを読めるRLSのクライアントを使う）。
 * 未設定・読み取れないとき（DBに列がまだない場合を含む）は null。
 */
export async function getOwnUsername(client: SupabaseClient | null, userId: string): Promise<string | null> {
  if (!client) return null;
  const { data, error } = await client.from("profiles").select("username").eq("id", userId).maybeSingle();
  if (error || !data) return null;
  const value = (data as { username?: string | null }).username;
  return typeof value === "string" && value !== "" ? value : null;
}
