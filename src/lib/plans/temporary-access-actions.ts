"use server";

import { cookies } from "next/headers";
import {
  issueTemporaryAccessToken,
  verifyTemporaryAccessToken,
  type TemporaryAccessCheck,
} from "./temp-access-token";
import { TEMP_ACCESS_COOKIE_NAME, TEMP_ACCESS_DURATION_MS } from "./temporary-access-cookie";
import { isFallbackGrantReason, type TemporaryAccessKind } from "./temporary-access-kinds";
import { decideFallbackGrant } from "./fallback-grant-policy";

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
 * 署名付きトークンをCookieへ保存する（広告視聴による付与・代替付与で共通）。
 * Cookie名・有効期間・属性は従来と同じ。トークンの中身（種別）だけが異なる。
 */
async function storeTemporaryAccessToken(
  kind: TemporaryAccessKind
): Promise<{ expiresAtMs: number; kind: TemporaryAccessKind }> {
  const cookieStore = await cookies();
  const token = issueTemporaryAccessToken(TEMP_ACCESS_DURATION_MS, kind);
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

  return { expiresAtMs: verification.expiresAtMs ?? Date.now(), kind };
}

/**
 * 既に有効な利用権が残っていれば、それを返す（新しい1時間ウィンドウを発行し直さない）。
 *
 * Phase 6.5 セキュリティ監査で追加：grantTemporaryAccess自体は「広告を実際に
 * 視聴したか」を検証できない（下のコメント参照）ため、毎回新しいトークンを発行して
 * いると、このServer Actionを（例えばdevtoolsから）繰り返し直接呼び出すだけで、
 * 常に「残り1時間」を維持し続け、事実上無期限にアクセスできてしまう。
 * 既存の有効期限をそのまま返すことで、この「繰り返し呼び出しによる無期限延長」を防ぐ
 * （広告システム自体には一切手を加えない、最小限のサーバー側対策）。
 * 広告視聴による付与・代替付与の両方に同じ防御を適用する。
 */
async function findActiveTemporaryAccess(): Promise<{ expiresAtMs: number; kind: TemporaryAccessKind } | null> {
  const cookieStore = await cookies();
  const existing = verifyTemporaryAccessToken(cookieStore.get(TEMP_ACCESS_COOKIE)?.value);
  if (existing.active && existing.expiresAtMs !== null && existing.kind !== null) {
    return { expiresAtMs: existing.expiresAtMs, kind: existing.kind };
  }
  return null;
}

/**
 * リワード広告の視聴成功後に呼び出すServer Action。
 *
 * 有効期限はこの関数の中（＝サーバー）で計算し、署名付きトークン（種別 "ad"）として
 * Cookieへ保存する。ツール単位ではなく、Standard対象ツール全体に対して1つの
 * 1時間ウィンドウを付与する（Phase 3 spec 3章：「1ツールにつき1広告」にしない）。
 *
 * 重要：この関数自体は「広告を見たこと」を検証しない（RewardedAdServiceの
 * watchAd()がgrantedを返した後にのみ呼び出される前提）。Webのリワード広告は
 * Googleの公式ヘルプ上、サーバー側検証（SSV）が使えない。そのため、この関数を
 * 直接呼び出されると、広告を見ずに利用権を取得できる。ブラウザ内で完結する
 * アーキテクチャ（ファイルをサーバーへ送らない）では完全には防げない制約。
 */
export async function grantTemporaryAccess(): Promise<{ expiresAtMs: number; kind: TemporaryAccessKind }> {
  const active = await findActiveTemporaryAccess();
  if (active) return active;
  return storeTemporaryAccessToken("ad");
}

/** 代替付与の結果 */
export type FallbackGrantResult =
  | { granted: true; expiresAtMs: number; kind: TemporaryAccessKind }
  | { granted: false; denial: "invalid-reason" | "cooldown" };

/**
 * 広告自体が配信されなかった場合に、暫定的に1時間の利用権を付与するServer Action。
 *
 * 広告視聴による付与（grantTemporaryAccess）とは別の経路で、発行するトークンの
 * 種別は "fallback"。広告が視聴された・広告収益が発生した、という意味には
 * ならない（呼び出し側のUIも「広告を表示できなかった」ことを利用者へ明示する）。
 *
 * 付与するかどうかの判定は src/lib/plans/fallback-grant-policy.ts の
 * decideFallbackGrant() に分離してある。現在は制限なし（暫定）。
 *
 * reason はクライアントから渡される文字列で信用できないため、既知の理由に
 * 該当しない値は拒否する。ただし、広告が本当に配信されなかったかどうかを
 * サーバーが確かめることはできない（広告ブロッカーを使う人が毎回呼ぶ、または
 * このServer Actionを直接呼ぶ、といったことは防げない）。
 */
export async function grantFallbackTemporaryAccess(reason: string): Promise<FallbackGrantResult> {
  if (!isFallbackGrantReason(reason)) {
    return { granted: false, denial: "invalid-reason" };
  }

  const active = await findActiveTemporaryAccess();
  if (active) return { granted: true, ...active };

  const decision = decideFallbackGrant({
    reason,
    nowMs: Date.now(),
    // 「最後に代替付与した時刻」はまだ保持していない（制限なしの暫定運用）。
    // 制限を導入する際の手順は fallback-grant-policy.ts を参照。
    lastFallbackGrantedAtMs: null,
  });
  if (!decision.allowed) {
    return { granted: false, denial: decision.denial };
  }

  const stored = await storeTemporaryAccessToken("fallback");
  return { granted: true, ...stored };
}

/**
 * 現在のTemporary Access状態をサーバー側で検証する。
 * ページ(Server Component)からの利用を想定。
 */
export async function checkTemporaryAccess(): Promise<TemporaryAccessCheck> {
  const cookieStore = await cookies();
  const token = cookieStore.get(TEMP_ACCESS_COOKIE)?.value;
  return verifyTemporaryAccessToken(token);
}
