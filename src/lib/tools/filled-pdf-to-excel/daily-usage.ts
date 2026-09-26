import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 記入済みPDF→Excel（Standardプラン: 1日10回まで・広告なし）の
 * 利用回数を、supabase/migrations/0002_tool_usage_daily.sql の
 * SECURITY DEFINER関数経由で読み書きするラッパー。
 *
 * 「利用回数管理データ」と「個人情報・ファイルデータ」は完全に別物
 * （開発指示書10章）。ここで扱うのは user_id・tool_id・日付・回数のみで、
 * PDFの中身やOCR結果は一切関与しない（そもそもサーバーに送られない）。
 *
 * Supabase未設定の環境では、既存の getServerPlan() 等と同じ
 * 「if (!supabase) return <安全な既定値>」パターンで穏やかに縮退する
 * （回数管理が使えない＝毎回Free相当の広告視聴を要求する、安全側の既定値）。
 */

const TOOL_ID = "filled-pdf-to-excel";

/** Standardプランで1日に無償利用できる回数の上限 */
export const STANDARD_DAILY_FREE_USES = 10;

/** 当日の利用回数を取得する（加算しない）。Supabase未設定・エラー時は0を返す */
export async function getStandardDailyUsageCount(): Promise<number> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return 0;

  const { data, error } = await supabase.rpc("get_tool_usage_today", { p_tool_id: TOOL_ID });
  if (error || typeof data !== "number") return 0;
  return data;
}

/**
 * 当日の利用回数を1加算する。呼び出し元は「有効な処理が実際に開始される
 * ことを確認した後」にのみ呼ぶこと（開発指示書9章：不正クリック等による
 * 無駄な消費を避けつつ、入力エラー時にカウントを浪費しない）。
 * Supabase未設定・エラー時は、失敗を示す null を返す（呼び出し側は
 * 安全側＝広告視聴が必要な状態として扱う）。
 */
export async function incrementStandardDailyUsage(): Promise<number | null> {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase.rpc("increment_tool_usage", { p_tool_id: TOOL_ID });
  if (error || typeof data !== "number") return null;
  return data;
}
