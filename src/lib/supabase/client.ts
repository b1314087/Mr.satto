"use client";

import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
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
  return createBrowserClient(supabaseConfig.url, supabaseConfig.anonKey, {
    // URLの ?code= や #access_token= を、ページを開いただけで自動的に処理しない。
    // メールのリンクの処理は、決まった画面（/auth/callback・/auth/reset-callback）で、明示的に1回だけ行う
    // （ヘッダーなどの部品が同じページで先に処理してしまい、認可コードを使い切るのを防ぐ）。
    auth: { detectSessionInUrl: false },
  });
}

/**
 * パスワード再設定のメールを申し込むときだけに使う、使い捨てのクライアント。
 *
 * 通常のクライアント（PKCE方式）で申し込むと、メールのリンクは「申し込んだブラウザ」でしか使えない
 * （確認用の値が、そのブラウザのCookieにしか無いため）。パソコンで申し込み、スマートフォンのメールから開くと失敗する。
 * そのため、この申し込みだけは、Supabase標準のもう一つの方式（implicit）で行う。リンクを開くと、Supabaseが
 * リンクの使い捨ての値を確かめたうえで、/auth/reset-callback の「#」の後ろに、ログイン用の値を付けて戻す。
 * 「#」の後ろはサーバーに送られず、画面（src/components/auth/reset-callback-handler.tsx）が読み取ったらすぐURLから消す。
 *
 * 何も保存しない（セッション・確認用の値を持たない）。申し込み以外には使わない。
 */
export function getSupabasePasswordRecoveryRequestClient() {
  if (!isSupabaseConfigured()) return null;
  return createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: { flowType: "implicit", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
