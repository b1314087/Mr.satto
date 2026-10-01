/**
 * 記入済みPDF→Excel（Phase 11 ツール①）専用の、リワード広告視聴による
 * 「1回・1ページ分」の利用権（page credit）に関する、サーバー側・
 * クライアント側の両方から参照する共有定数。
 *
 * src/lib/plans/temporary-access-cookie.ts と同じ理由で、"use server" にも
 * "server-only" にもしていない、ただの定数モジュール（Server Actionファイルは
 * 非同期関数以外をexportできないため）。
 *
 * この一時利用権は、既存の src/lib/plans/temporary-access.ts が扱う
 * 「Standard対象ツール全体・15分間」の権限とは別物（このツール専用・
 * ページ数ベース・1回使い切り）であるため、Cookie名・トークン形式ともに
 * 完全に独立させている（混同や誤検証を構造的に防ぐため）。
 *
 * 利用制限見直し（2026・第2版）：Free・Standardとも1回あたりの処理上限を
 * 3ページ→1ページに変更し、かつ両プランの「1日あたりの利用回数上限」を
 * 完全に撤廃した（指示書の「1日の利用回数上限を設けない」「既存の
 * 署名付きCookieによる1日3回制限を解除する」「既存の1日5回制限を解除する」
 * に対応）。これに伴い、旧実装にあった以下2つの日次カウント専用の仕組みは
 * 不要になったため削除した（再実装しない）：
 *   - Free向け：free-daily-usage-token.ts / free-daily-usage-actions.ts
 *     （匿名ユーザーの1日3回制限用の署名付きCookie）
 *   - Standard向け：daily-usage.ts
 *     （tool_usage_daily Supabaseテーブルを使った1日5回制限のラッパー）
 * 下敷きになっているSupabaseの tool_usage_daily テーブル自体
 * （supabase/migrations/0002_tool_usage_daily.sql）は他ツールが将来
 * 再利用できる汎用の仕組みとして定義されているため、マイグレーション自体は
 * 変更していない（このツールからの呼び出しだけをやめた）。
 */

/** page credit トークンを保持するCookie名 */
export const PDF_TO_EXCEL_CREDIT_COOKIE_NAME = "mrsatto_pdf2excel_credit";

/**
 * 広告視聴からファイル選択・処理開始までにユーザーへ与える猶予時間。
 * 「広告を見た後、いつまでも権利が残り続ける」状態を避けつつ、
 * ファイル選択などの実際の操作に十分な時間を確保する。
 */
export const PDF_TO_EXCEL_CREDIT_DURATION_MS = 10 * 60 * 1000;

/**
 * この一時利用権1回で処理できる最大ページ数（Free・Standard共通）。
 * 利用制限見直し（2026・第2版）で3→1に変更。Freeは「1ページ処理するたびに
 * 広告視聴を必須にする」仕様のため、1回の利用権で処理できる上限を1ページに
 * 揃えることで、ページ単位での広告視聴必須化を実現している
 * （consumePageCreditが1回使い切りのため、2ページ目以降は必然的に
 * 再度広告視聴が必要になる）。
 */
export const PDF_TO_EXCEL_CREDIT_MAX_PAGES = 1;
