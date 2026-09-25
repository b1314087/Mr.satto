import "server-only";

import { supabaseConfig, isSupabaseConfigured } from "./config";

/**
 * Supabase Service Role Key（秘密情報）専用の設定モジュール（Phase 6.5 セキュリティ監査で追加）。
 *
 * "server-only" をこのファイル自体に付けることで、万一このファイルが
 * Client Component から import された場合はビルドエラーで検知できる
 * （./config.ts は "use client" な ./client.ts からも import されるため、
 * secret はそちらではなく必ずこの専用ファイルに置く）。
 *
 * 用途は src/lib/supabase/service.ts（Stripe Webhookハンドラ専用の
 * 特権クライアント）に限定する。
 */
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export const supabaseServiceConfig = {
  serviceRoleKey,
};

/** Webhook等、サーバー専用のservice role client を使える状態か */
export function isSupabaseServiceConfigured(): boolean {
  return isSupabaseConfigured() && supabaseConfig.url.length > 0 && serviceRoleKey.length > 0;
}
