/**
 * Supabase関連の設定を一元管理する。
 *
 * src/lib/ads/config.ts と同じ方針：
 * 環境変数が未設定の場合は「未設定」として扱い、認証機能はサインイン導線を
 * 無効化する（存在しないプロジェクトへ接続しようとしてクラッシュさせない）。
 *
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY は
 * ブラウザへ公開して問題ない値（Supabaseの設計上、anon keyはRLSの前提で
 * 公開される値）。SUPABASE_SERVICE_ROLE_KEY は絶対にNEXT_PUBLIC_を付けず、
 * サーバー専用コード（src/lib/supabase/service.ts）からのみ参照すること。
 */
export const supabaseConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
};

/** 会員登録・ログイン機能を実際に有効化できる状態か（URL・anon keyが揃っているか） */
export function isSupabaseConfigured(): boolean {
  return supabaseConfig.url.length > 0 && supabaseConfig.anonKey.length > 0;
}

/** Webhook等、サーバー専用のservice role client を使える状態か */
export function isSupabaseServiceConfigured(): boolean {
  return isSupabaseConfigured() && supabaseConfig.serviceRoleKey.length > 0;
}
