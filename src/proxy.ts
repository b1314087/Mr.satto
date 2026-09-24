import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseConfig, isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Supabase Authのセッションを毎リクエスト検証・更新するProxy（旧middleware）。
 *
 * Next.js 16では `middleware.ts` は廃止され `proxy.ts` に名称変更されている
 * （node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md）。
 * 役割自体は従来のmiddlewareと同じ。
 *
 * Supabase SSRの推奨パターンに従い、期限切れに近いアクセストークンをここで
 * リフレッシュし、Cookieへ書き戻す。Server Component側ではCookieの書き込みが
 * できないため、このProxyが唯一の確実なセッション更新経路になる
 * （src/lib/supabase/server.ts のコメント参照）。
 *
 * Supabase未設定（環境変数なし）の場合は何もしない（既存の全ツールは
 * ログイン不要で動作するため、Proxyの不在がツール利用を妨げないようにする）。
 */
export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });

  if (!isSupabaseConfigured()) return response;

  const supabase = createServerClient(supabaseConfig.url, supabaseConfig.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser() はJWTをSupabaseサーバーへ問い合わせて検証するため、
  // getSession()（Cookieの中身を信用するだけ）よりも安全。
  // 戻り値は使わず、必要なリフレッシュとCookie書き戻しのためだけに呼ぶ。
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * 静的アセット・画像最適化・メタデータファイルを除く全パスに適用する。
     * ツール本体はログイン不要のため、対象から除外する必要はない
     * （未ログイン時は単にセッションが存在しないだけで処理は継続する）。
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|opengraph-image).*)",
  ],
};
