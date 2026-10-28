import "server-only";

import { createClient } from "@supabase/supabase-js";
import { supabaseConfig } from "./config";
import { supabaseServiceConfig, isSupabaseServiceConfigured } from "./service-config";

/**
 * Service Role Key を使うSupabaseクライアント（RLSを経由しない特権クライアント）。
 *
 * 用途は以下の5箇所に限定する。
 *   1. Stripe Webhookハンドラ（src/app/api/stripe/webhook/route.ts）。
 *      Webhookはユーザーのログインセッションを持たない（Stripeサーバーからの通知）ため、
 *      通常のRLS前提のクライアントでは subscriptions テーブルを更新できない。
 *   2. 管理画面（src/lib/admin/data.ts）。全会員・全利用ログを横断的に読む必要があり、
 *      「自分の行だけ」しか読めない通常のRLS前提クライアントでは実現できない。
 *      必ず src/lib/admin/auth.ts の checkAdminAccess() で管理者と確認した
 *      呼び出し元からのみ使うこと（この関数自体は誰が呼んでいるかを検証しない）。
 *
 *   3. AI利用台帳の関数呼び出し（src/lib/ai/server.ts）。ai_reserve / ai_settle / ai_release / ai_get_usage は
 *      service_role だけが実行できる。呼び出し元（src/app/api/ai/*）が、ログインとPremiumを確認してから使う。
 *
 *   4. 利用規約・プライバシーポリシーへの同意の記録（src/lib/legal/consent-store.ts）。terms_consents テーブルは
 *      service_role だけが読み書きできる。userId は検証済みのセッション、または会員登録の応答から得た値だけを渡す。
 *   5. アカウント削除（src/lib/account/delete-account-actions.ts）。auth.admin.deleteUser は特権が必要。
 *      必ず「ログイン中の本人」を確認し、本人のIDだけを渡す（他人のIDを受け取らない）。
 *
 * 重要：
 * - "server-only" によりクライアントバンドルに紛れ込んだ場合はビルドエラーになる。
 * - SUPABASE_SERVICE_ROLE_KEY は NEXT_PUBLIC_ を付けない秘密情報。
 * - 上記以外の一般的なリクエスト処理（ユーザーの操作起点のAPI Route等）で
 *   使わないこと。他人の情報を無条件に読める強い権限を持つため、
 *   使う場合は呼び出し元が自分でアクセス制御を行う前提となる。
 */
export function getSupabaseServiceClient() {
  if (!isSupabaseServiceConfigured()) return null;
  return createClient(supabaseConfig.url, supabaseServiceConfig.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
