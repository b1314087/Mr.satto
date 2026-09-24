/**
 * Freeユーザーの「リワード広告視聴後15分間」のTemporary Accessに関する、
 * サーバー側・クライアント側の両方から参照する共有定数。
 *
 * このファイルは "use server" でも "server-only" でもない、ただの定数モジュール。
 * 理由：
 *   - temporary-access-actions.ts（"use server"）は非同期関数以外をexportできないため、
 *     Cookie名のような定数をこのファイルの中に置けない（Phase 3で実際に発生したビルドエラー。
 *     詳細は同ファイルのコメント参照）。
 *   - Cookie名自体は秘密情報ではなく（署名鍵ではない）、クライアント側
 *     （src/lib/plans/temporary-access.ts）が残り時間表示のために
 *     document.cookie を直接読む際にも同じ名前が必要になる。
 *
 * 署名鍵(TEMP_ACCESS_SECRET)や実際の検証ロジックはここには置かない
 * （それらは "server-only" な src/lib/plans/temp-access-token.ts のみが扱う）。
 */

/** Temporary Accessトークンを保持するCookie名 */
export const TEMP_ACCESS_COOKIE_NAME = "mrsatto_temp_access";

/** 「15分間」は仕様で確定した値。勝手に変更しない（Phase 3 spec 3章・35章 / Phase 4 spec 10章・41章）。 */
export const TEMP_ACCESS_DURATION_MS = 15 * 60 * 1000;
