"use server";

import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { endAllSessions, endCurrentSession, getPasskeyUser } from "@/lib/passkey/server";

/**
 * ログアウト処理（Server Action）。
 * Cookieの書き込み・削除が必要なため、Server Component内では行えず、
 * Server Action（またはRoute Handler）から呼び出す必要がある
 * （src/lib/supabase/server.ts のコメント参照）。
 */
export async function signOutAction(): Promise<void> {
  // 有料プランの同時利用のロックを解放する（この端末のセッションだけ。端末の登録は残す）
  const user = await getPasskeyUser();
  await endCurrentSession(user?.id ?? null);
  const supabase = await getSupabaseServerClient();
  if (supabase) {
    await supabase.auth.signOut();
  }
  redirect("/");
}

/**
 * パスワードを変更したあとに呼ぶ（Server Action）。
 * 他の端末のログインをすべて終わらせ、有料プランの利用ロックと直近の本人確認も消す
 * （この端末も、有料機能を使うには、もう一度パスキーでの本人確認が必要になる）。
 */
export async function afterPasswordChangedAction(): Promise<void> {
  const user = await getPasskeyUser();
  if (!user) return;
  await endAllSessions(user.id);
  const supabase = await getSupabaseServerClient();
  if (supabase) {
    // 他の端末のSupabaseのログイン（リフレッシュトークン）をすべて無効にする。この端末のログインは残す
    await supabase.auth.signOut({ scope: "others" });
  }
}
