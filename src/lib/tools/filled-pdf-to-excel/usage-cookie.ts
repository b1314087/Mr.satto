/**
 * 記入済みPDF→Excel（Phase 11 ツール①）専用の、リワード広告視聴による
 * 「1回・最大3ページ分」の利用権（page credit）に関する、サーバー側・
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
 */

/** page credit トークンを保持するCookie名 */
export const PDF_TO_EXCEL_CREDIT_COOKIE_NAME = "mrsatto_pdf2excel_credit";

/**
 * 広告視聴からファイル選択・処理開始までにユーザーへ与える猶予時間。
 * 「広告を見た後、いつまでも権利が残り続ける」状態を避けつつ、
 * ファイル選択などの実際の操作に十分な時間を確保する。
 */
export const PDF_TO_EXCEL_CREDIT_DURATION_MS = 10 * 60 * 1000;

/** この一時利用権1回で処理できる最大ページ数（Free・Standardの超過分共通） */
export const PDF_TO_EXCEL_CREDIT_MAX_PAGES = 3;
