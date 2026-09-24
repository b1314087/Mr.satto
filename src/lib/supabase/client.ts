"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseConfig, isSupabaseConfigured } from "./config";

/**
 * ブラウザ（クライアントコンポーネント）用のSupabaseクライアント。
 *
 * ログイン・会員登録フォームなど、クライアント側で直接Supabase Authの
 * signInWithPassword / signUp / signOut を呼ぶ箇所でのみ使用する。
 *
 * 重要：このクライアントはanon key（公開鍵）のみを使用し、行レベルセキュリティ(RLS)
 * の適用対象。プラン判定など信頼性が必要な処理には使わず、必ず
 * src/lib/supabase/server.ts（サーバー側）を経由すること。
 *
 * 環境変数が未設定の場合は null を返す（呼び出し側で「未設定」表示に倒す）。
 */
export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured()) return null;
  return createBrowserClient(supabaseConfig.url, supabaseConfig.anonKey);
}
