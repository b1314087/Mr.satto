import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * ユーザー状態（Guest / ログイン済み）の抽象層。
 *
 * 「ログインしていないこと」と「料金プランがfreeであること」は
 * 別概念として扱う（詳細は src/lib/plans/current-plan.ts のコメントを参照）。
 * このファイルは前者（ユーザー状態）だけを扱い、後者（プラン）には関知しない。
 *
 * Phase 3で実装が入った：getCurrentUser() はSupabase Authの実際のセッションを
 * サーバー側で検証する（"server-only" のため、Server Component / Route Handler /
 * Server Actionからのみ呼び出せる）。クライアントコンポーネントでログイン状態の
 * 表示だけを行いたい場合は、この関数ではなく
 * src/components/auth/auth-status.tsx のようにSupabaseブラウザクライアントの
 * onAuthStateChangeを直接購読すること（表示専用・権限判定には使わない）。
 */

/** ユーザー状態。guest = 未ログイン / authenticated = ログイン済み */
export type UserState = "guest" | "authenticated";

/** ログイン済みユーザーの情報 */
export interface AuthenticatedUser {
  id: string;
  email: string | null;
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
  return { id: user.id, email: user.email ?? null };
}

/**
 * ユーザー状態（Guest / ログイン済み）を取得する。
 * Mr.Sattoでは無料利用にログインを要求しないため、
 * 「未ログイン = 利用不可」を意味しない点に注意
 * （Guestでもstandard対象ツールは広告視聴で利用できる。詳細は plans/access.ts）。
 */
export async function getUserState(): Promise<UserState> {
  return (await getCurrentUser()) === null ? "guest" : "authenticated";
}
