import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * 記入済みPDF→Excel（Standardプラン: 1日5回まで・広告なし）の
 * 利用回数を、supabase/migrations/0002_tool_usage_daily.sql の
 * SECURITY DEFINER関数経由で読み書きするラッパー。
 *
 * 「利用回数管理データ」と「個人情報・ファイルデータ」は完全に別物
 * （開発指示書10章）。ここで扱うのは user_id・tool_id・日付・回数のみで、
 * PDFの中身やOCR結果は一切関与しない（そもそもサーバーに送られない）。
 *
 * 利用制限見直し（2026）：上限を10回→5回に変更。また、上限到達後の
 * 「広告視聴で引き続き利用できる」フォールバックは廃止した（新仕様では
 * Standardは「広告なし・1日5回まで」で完結し、6回目以降は翌日までの
 * 利用不可とする。フォールバック判定はusage-status-actions.ts側で行う）。
 *
 * Supabase未設定の環境では、既存の getServerPlan() 等と同じ
 * 「if (!supabase) return <安全な既定値>」パターンで穏やかに縮退する
 * （回数管理が使えない＝安全側に倒して当日は利用不可として扱う。
 * 旧仕様にあった「広告視聴へのフォールバック」は行わない）。
 */

const TOOL_ID = "filled-pdf-to-excel";

/** Standardプランで1日に利用できる回数の上限（広告なし。これを超えると翌日まで利用不可） */
export const STANDARD_DAILY_FREE_USES = 5;

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
