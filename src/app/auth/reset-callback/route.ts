import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * パスワード再設定メール内のリンクの遷移先。
 *
 * 既存の /auth/callback（会員登録のメール確認用。成功時は/accountへ遷移）とは
 * 目的が異なるため専用のRoute Handlerとして分離した（/auth/callback自体の
 * 挙動・URLは今回変更していない）。
 *
 * 成功時：パスワード再設定フォーム（/auth/reset-password）へ遷移。
 *   このルートを通過して確立した一時的なセッションを使い、次の画面で
 *   supabase.auth.updateUser({ password }) によるパスワード更新のみを許可する。
 * 失敗時（リンク無効・期限切れ・使用済み等）：内部エラー詳細は出さず、
 *   /auth/forgot-password へ汎用的なエラー状態で戻す。
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await getSupabaseServerClient();
    if (supabase) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        return NextResponse.redirect(`${origin}/auth/reset-password`);
      }
    }
  }

  return NextResponse.redirect(`${origin}/auth/forgot-password?error=invalid_link`);
}
