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
  const token = issueTemporaryAccessToken(TEMP_ACCESS_DURATION_MS);
  const verification = verifyTemporaryAccessToken(token);

  const cookieStore = await cookies();
  cookieStore.set(TEMP_ACCESS_COOKIE, token, {
    maxAge: Math.ceil(TEMP_ACCESS_DURATION_MS / 1000),
    path: "/",
    sameSite: "lax",
    // httpOnlyにはしない：クライアント側で残り時間のカウントダウン表示に使うため。
    // ただし改ざん耐性は署名(HMAC)で担保しており、Cookieの値そのものを
    // 信頼しているわけではない（verifyTemporaryAccessTokenが必ず検証する）。
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
