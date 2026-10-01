"use server";

import { cookies } from "next/headers";
import { PDF_TO_EXCEL_FREE_DAILY_COOKIE_NAME } from "./usage-cookie";
import { getJstDateString, issueFreeDailyUsageToken, verifyFreeDailyUsageToken } from "./free-daily-usage-token";

/**
 * Free（匿名）ユーザーの記入済みPDF→Excel 1日あたり利用回数を、Cookieに
 * 保存した署名付きトークンとして読み書きするServer Actions
 * （利用制限見直しで追加。credit-actions.ts と同じ責務分離：署名の発行・検証は
 * free-daily-usage-token.ts、Cookieの実際の読み書きはこちらが担当する）。
 *
 * 日付が今日(JST)と異なるトークンは「今日はまだ0回」として扱う
 * （日次リセット。daily-usage.tsのSupabase側と同じAsia/Tokyo基準）。
 *
 * 匿名ユーザーのCookieのため、Standardの tool_usage_daily のような
 * 原子的なDB upsertはできない（Cookie書き込みはリクエストごとの
 * 上書きであり、同一ユーザーが複数タブを同時に使った場合に厳密な
 * 原子性は保証されない）。これは匿名・Cookieベースの管理である以上の
 * 構造的な制約であり、最終報告に明記する。
 */

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 48; // 2日分。日付の実際の境界判定はトークン内の日付文字列で行う

/** 今日(JST)時点での利用回数を取得する（加算しない）。不正・未発行・日付が異なる場合は0 */
export async function getFreeDailyUsageCount(): Promise<number> {
  const cookieStore = await cookies();
  const state = verifyFreeDailyUsageToken(cookieStore.get(PDF_TO_EXCEL_FREE_DAILY_COOKIE_NAME)?.value);
  const today = getJstDateString();
  if (state.date !== today) return 0;
  return state.count;
}

/**
 * 今日(JST)の利用回数を1加算し、加算後の回数を返す。
 * 呼び出し元は「実際に広告視聴による利用権を消費し、処理を開始する直前」
 * にのみ呼ぶこと（daily-usage.tsのincrementStandardDailyUsage()と同じ方針）。
 */
export async function incrementFreeDailyUsage(): Promise<number> {
  const cookieStore = await cookies();
  const state = verifyFreeDailyUsageToken(cookieStore.get(PDF_TO_EXCEL_FREE_DAILY_COOKIE_NAME)?.value);
  const today = getJstDateString();
  const nextCount = state.date === today ? state.count + 1 : 1;

  const token = issueFreeDailyUsageToken(today, nextCount);
  cookieStore.set(PDF_TO_EXCEL_FREE_DAILY_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });
  return nextCount;
}
