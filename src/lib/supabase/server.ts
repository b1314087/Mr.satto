import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseConfig, isSupabaseConfigured } from "./config";

/**
 * サーバー側（Server Component / Route Handler / Server Action）用のSupabaseクライアント。
 *
 * Mr.Sattoの権限判定の原則：「ブラウザが持っているplanではなく、認証ユーザー + DB上の
 * 有効な契約状態からplanを決定する」（src/lib/plans/current-plan.ts の getServerPlan）
 * ための土台となるクライアント。Cookieに保存された実際のSupabaseセッションを検証するため、
 * クライアント側のlocalStorage等を書き換えるだけでは偽装できない。
 *
 * 呼び出しのたびに新しいクライアントを作ること（リクエストをまたいで使い回さない）。
 * Server Componentからの呼び出しではCookieの書き込みができないため、その場合は
 * setAllが失敗しても無視する（実際のセッション更新は src/proxy.ts が担う）。
 *
 * 環境変数が未設定の場合は null を返す（呼び出し側は「認証機能は未設定」として扱う）。
 */
export async function getSupabaseServerClient() {
  if (!isSupabaseConfigured()) return null;
  const cookieStore = await cookies();

  return createServerClient(supabaseConfig.url, supabaseConfig.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Component からの呼び出しでは Cookie を書き込めない
          // （Next.jsの仕様）。セッションの更新自体は src/proxy.ts が
          // 毎リクエスト行うため、ここで失敗しても実害はない。
        }
      },
    },
  });
}
