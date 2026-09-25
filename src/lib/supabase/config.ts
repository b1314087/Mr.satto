/**
 * Supabase関連の設定を一元管理する。
 *
 * src/lib/ads/config.ts と同じ方針：
 * 環境変数が未設定の場合は「未設定」として扱い、認証機能はサインイン導線を
 * 無効化する（存在しないプロジェクトへ接続しようとしてクラッシュさせない）。
 *
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY は
 * ブラウザへ公開して問題ない値（Supabaseの設計上、anon keyはRLSの前提で
 * 公開される値）。
 *
 * 重要（Phase 6.5 セキュリティ監査で変更）：
 * SUPABASE_SERVICE_ROLE_KEY は以前このファイルで保持していたが、このファイルは
 * "use client" なブラウザ用クライアント（./client.ts）からも import されており、
 * "server-only" ガードが付いていなかった。ビルド時のprocess.env置換により
 * 実際にクライアントバンドルへ値が漏れることは無いことは確認済みだが（NEXT_PUBLIC_
 * 以外の環境変数はクライアントバンドルでは undefined に置換される）、将来の
 * リファクタでこの前提が崩れても secret が漏れない設計にするため、
 * serviceRoleKey は server-only 保証付きの ./service-config.ts へ分離した。
 * このファイル自体は今後も secret を一切保持しない。
 */
export const supabaseConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};

/** 会員登録・ログイン機能を実際に有効化できる状態か（URL・anon keyが揃っているか） */
export function isSupabaseConfigured(): boolean {
  return supabaseConfig.url.length > 0 && supabaseConfig.anonKey.length > 0;
}
