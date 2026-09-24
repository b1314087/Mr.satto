import "server-only";

import { createClient } from "@supabase/supabase-js";
import { supabaseConfig, isSupabaseServiceConfigured } from "./config";

/**
 * Service Role Key を使うSupabaseクライアント（RLSを経由しない特権クライアント）。
 *
 * 用途はStripe Webhookハンドラ（src/app/api/stripe/webhook/route.ts）に限定する。
 * Webhookはユーザーのログインセッションを持たない（Stripeサーバーからの通知）ため、
 * 通常のRLS前提のクライアントでは subscriptions テーブルを更新できない。
 * そのため、この特権クライアントのみ例外的に使用する。
 *
 * 重要：
 * - "server-only" によりクライアントバンドルに紛れ込んだ場合はビルドエラーになる。
 * - SUPABASE_SERVICE_ROLE_KEY は NEXT_PUBLIC_ を付けない秘密情報。
 * - このクライアントをWebhook以外の一般的なリクエスト処理（ユーザーの操作起点の
 *   API Route等）で使わないこと。他人のsubscription情報を無条件に読める
 *   強い権限を持つため、必ずユーザーIDでの絞り込みを自分で行う前提となる。
 */
export function getSupabaseServiceClient() {
  if (!isSupabaseServiceConfigured()) return null;
  return createClient(supabaseConfig.url, supabaseConfig.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
