import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ログイン中のユーザーの取得。
 *
 * 「ログインしていないこと」と「料金プランがfreeであること」は
 * 別概念として扱う（詳細は src/lib/plans/current-plan.ts のコメントを参照）。
 * このファイルは前者（ユーザー状態）だけを扱い、後者（プラン）には関知しない。
 *
 * getCurrentUser() はSupabase Authの実際のセッションを
 * サーバー側で検証する（"server-only" のため、Server Component / Route Handler /
 * Server Actionからのみ呼び出せる）。クライアントコンポーネントでログイン状態の
 * 表示だけを行いたい場合は、この関数ではなく
 * src/components/auth/auth-status.tsx のようにSupabaseブラウザクライアントの
 * onAuthStateChangeを直接購読すること（表示専用・権限判定には使わない）。
 */

/** ログイン済みユーザーの情報 */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
  /** メールアドレスが確認済みか（Supabase Authの email_confirmed_at が設定されているか）。サーバーで検証した値 */
  emailConfirmed: boolean;
}

/**
 * 現在のユーザーを取得する唯一の窓口（サーバー専用）。
 *
 * Supabaseが未設定（環境変数なし）の場合や、セッションが存在しない場合はnull。
 * getUser()はJWTをSupabaseサーバーへ問い合わせて検証するため、Cookieの中身を
 * そのまま信用するgetSession()より安全（クライアントがCookieを書き換えただけでは
 * 認証済み扱いにならない）。
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  return { id: user.id, email: user.email ?? null, emailConfirmed: !!user.email_confirmed_at };
}
