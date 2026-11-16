import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { classifyAuthLinkError, isCodeVerifierMissing } from "@/lib/auth/auth-link";

/**
 * Supabase Authのメール確認リンク（signUp時にemailRedirectToへ指定したURL）が遷移してくる先。
 *
 * - 同じブラウザで開いた場合：認可コードをセッションへ交換し、ログインした状態で /account へ移る（従来どおり）。
 * - 別のブラウザ・スマートフォンで開いた場合：メールアドレスの確認そのものは、Supabaseがリンクを開いた時点で
 *   終えている（その後でここへ戻ってくる）。このブラウザには、ログインに必要な確認用の値（PKCE）が無いので、
 *   ログインはさせず、「確認が完了しました。ログインしてください」と案内する（/login?confirmed=1）。
 *   ログインの状態を別の端末へ渡すことはしない。
 * - 期限切れ・使用済みなど：理由の種類だけを付けてログイン画面へ戻す（/login?auth_error=expired など）。
 *   Supabaseのエラーの文は、URLにも画面にも出さない。
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const toLogin = (query: string) => NextResponse.redirect(`${origin}/login?${query}`);

  if (searchParams.get("error") || searchParams.get("error_code")) {
    return toLogin(`auth_error=${classifyAuthLinkError({ code: searchParams.get("error_code") })}`);
  }

  const code = searchParams.get("code");
  if (!code) return toLogin("auth_error=invalid");

  const supabase = await getSupabaseServerClient();
  if (!supabase) return toLogin("auth_error=session");

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (!error) return NextResponse.redirect(`${origin}/account`);
  if (isCodeVerifierMissing(error)) return toLogin("confirmed=1");
  return toLogin(`auth_error=${classifyAuthLinkError(error)}`);
}
