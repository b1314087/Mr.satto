"use server";

import { cookies } from "next/headers";
import { issueTemporaryAccessToken, verifyTemporaryAccessToken } from "./temp-access-token";
import { TEMP_ACCESS_COOKIE_NAME, TEMP_ACCESS_DURATION_MS } from "./temporary-access-cookie";

/**
 * Temporary Accessトークンを保持するCookie名・有効期間。
 *
 * Phase 4でこの値の参照元を temporary-access-cookie.ts（"use server"ではない
 * 共有定数モジュール）へ移した。理由：クライアント側（残り時間表示・複数タブ
 * 同期用に document.cookie を直接読む src/lib/plans/temporary-access.ts）からも
 * 同じCookie名を参照する必要が生じたため（"use server" ファイルは非同期関数以外を
 * exportできないため、このファイル自体からは引き続きexportしない）。
 */
const TEMP_ACCESS_COOKIE = TEMP_ACCESS_COOKIE_NAME;

/**
 * リワード広告の視聴成功後に呼び出すServer Action。
 *
 * 有効期限はこの関数の中（＝サーバー）で計算し、署名付きトークンとしてCookieへ
 * 保存する。ツール単位ではなく、Standard対象ツール全体に対して1つの
 * 15分ウィンドウを付与する（Phase 3 spec 3章：「1ツールにつき1広告」にしない）。
 *
 * 重要：この関数自体は「広告を見たこと」を検証しない（RewardedAdServiceの
 * watchAd()がgrantedを返した後にのみ呼び出される前提）。本番の広告SDKへ
 * 差し替える際は、SDK側のサーバー間ポストバック（SSV）等で実際の視聴完了を
 * 検証してからこの関数を呼ぶ構成にすること（src/lib/ads/reward-provider.ts参照）。
 */
export async function grantTemporaryAccess(): Promise<{ expiresAtMs: number }> {
  const cookieStore = await cookies();

  // Phase 6.5 セキュリティ監査で追加：既に有効なTemporary Accessトークンが
  // 残っている場合は、新しい15分ウィンドウを発行し直さず、既存の有効期限を
  // そのまま返す。
  //
  // この関数自体は「広告を実際に視聴したか」を検証しない（ファイル冒頭のコメント
  // 参照）ため、もしこの毎回新しいトークンを発行していると、広告を視聴していなくても
  // このServer Actionを（例えばdevtoolsから）繰り返し直接呼び出すだけで、
  // 常に「残り15分」を維持し続け、事実上無期限にStandardツールへアクセスできて
  // しまう。既存の有効期限をそのまま返すことで、この「繰り返し呼び出しによる
  // 無期限延長」を防ぐ（本物の広告視聴検証(SSV)の代替にはならないが、
  // 広告システム自体には一切手を加えない、最小限のサーバー側対策）。
  const existingToken = cookieStore.get(TEMP_ACCESS_COOKIE)?.value;
  const existing = verifyTemporaryAccessToken(existingToken);
  if (existing.active && existing.expiresAtMs !== null) {
    return { expiresAtMs: existing.expiresAtMs };
  }

  const token = issueTemporaryAccessToken(TEMP_ACCESS_DURATION_MS);
  const verification = verifyTemporaryAccessToken(token);

  cookieStore.set(TEMP_ACCESS_COOKIE, token, {
    maxAge: Math.ceil(TEMP_ACCESS_DURATION_MS / 1000),
    path: "/",
    sameSite: "lax",
    // httpOnlyにはしない：クライアント側で残り時間のカウントダウン表示に使うため。
    // ただし改ざん耐性は署名(HMAC)で担保しており、Cookieの値そのものを
    // 信頼しているわけではない（verifyTemporaryAccessTokenが必ず検証する）。
    //
    // secure（Phase 6.5 セキュリティ監査で追加）：本番(NODE_ENV=production)では
    // HTTPS接続でのみCookieを送信させる。ローカル開発(next dev、http://localhost)は
    // 従来通りHTTPで動作させたいため、開発時のみ無効化する。
    secure: process.env.NODE_ENV === "production",
  });

  return { expiresAtMs: verification.expiresAtMs ?? Date.now() };
}

/**
 * 現在のTemporary Access状態をサーバー側で検証する。
 * ページ(Server Component)からの利用を想定。
 */
export async function checkTemporaryAccess(): Promise<{ active: boolean; expiresAtMs: number | null }> {
  const cookieStore = await cookies();
  const token = cookieStore.get(TEMP_ACCESS_COOKIE)?.value;
  return verifyTemporaryAccessToken(token);
}
