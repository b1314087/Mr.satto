"use server";

import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ログアウト処理（Server Action）。
 * Cookieの書き込み・削除が必要なため、Server Component内では行えず、
 * Server Action（またはRoute Handler）から呼び出す必要がある
 * （src/lib/supabase/server.ts のコメント参照）。
 */
export async function signOutAction(): Promise<void> {
  const supabase = await getSupabaseServerClient();
  if (supabase) {
    await supabase.auth.signOut();
  }
  redirect("/");
}
