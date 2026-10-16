import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TemporaryAccessKind } from "./temporary-access-kinds";

/**
 * Freeユーザーの「リワード広告視聴後1時間」のTemporary Accessを、
 * サーバー側で検証可能な署名付きトークンとして扱うための実装。
 *
 * 仕様上の要求（Phase 3 spec 4章・20章）：
 *   - 「ユーザーが時計を変更するだけで不正に延長できる設計にしない」
 *   - 「localStorageの値だけで1時間を無期限化」できないようにする
 *
 * 対策：有効期限(expiresAtMs)はここ（サーバー）が発行した時点で確定させ、
 * トークンにHMAC署名を付与する。クライアントは発行されたトークン文字列を
 * Cookieとして保持するだけで、有効期限の値自体を書き換えても署名が
 * 一致しなくなるため検証に失敗する。「ブラウザの時計」は判定に一切使わない
 * （判定は常に new Date() = サーバーの時計を基準にする）。
 *
 * 本格的なDBベースのセッション管理（Redis等）を今すぐ導入するのは
 * 現時点のアーキテクチャに対して過剰なため、まずはこの「サーバー発行の
 * 署名付き有効期限」という軽量な形で「サーバー側で検証可能な抽象化」を
 * 満たす。将来的に完全なサーバー管理（DBへのセッション記録等）へ移行する際も、
 * verifyTemporaryAccessToken() の中身を差し替えるだけで済む構造にしてある。
 */

/**
 * トークンの形式：
 *   v1 : `v1.<expiresAtMs>.<signature>`
 *        旧形式。種別を持たない。すべて「広告視聴による付与("ad")」として扱う。
 *        既に発行済みのCookieが有効期限まで引き続き使えるよう、検証は残してある
 *        （発行はしない）。
 *   v2 : `v2.<expiresAtMs>.<kind>.<signature>`
 *        現行形式。kindは "ad"（広告視聴による付与）か "fallback"（広告が配信されなかった
 *        ための代替付与）。kindも署名の対象のため、利用者が書き換えると検証に失敗する。
 */
const TOKEN_VERSION_V1 = "v1";
const TOKEN_VERSION_V2 = "v2";

function getSecret(): string {
  const secret = process.env.TEMP_ACCESS_SECRET;
  if (!secret) {
    throw new Error(
      "TEMP_ACCESS_SECRET が設定されていません。Freeユーザーのリワード広告による" +
        "一時利用権を発行するには、この環境変数の設定が必要です。"
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

/**
 * サーバー側でTemporary Accessトークンを発行する（有効期限はここで確定する）。
 * kind を省略した場合は広告視聴による付与("ad")として発行する。
 */
export function issueTemporaryAccessToken(durationMs: number, kind: TemporaryAccessKind = "ad"): string {
  const expiresAtMs = Date.now() + durationMs;
  const payload = `${TOKEN_VERSION_V2}.${expiresAtMs}.${kind}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export interface TemporaryAccessCheck {
  active: boolean;
  expiresAtMs: number | null;
  /** 付与の種別。トークンが無い・不正な場合は null（期限切れでも署名が正しければ種別は入る） */
  kind: TemporaryAccessKind | null;
}

const INACTIVE: TemporaryAccessCheck = { active: false, expiresAtMs: null, kind: null };

function isKind(value: string): value is TemporaryAccessKind {
  return value === "ad" || value === "fallback";
}

/**
 * トークンの署名と有効期限を検証する。
 * 署名が一致しない・形式が不正・期限切れのいずれの場合も active: false を返す。
 * v1（旧形式）・v2（現行形式）の両方を受け付ける。
 */
export function verifyTemporaryAccessToken(token: string | undefined | null): TemporaryAccessCheck {
  if (!token) return INACTIVE;

  const parts = token.split(".");

  let version: string;
  let expiresAtRaw: string;
  let kind: TemporaryAccessKind;
  let signature: string;
  let signedPayload: string;

  if (parts.length === 3 && parts[0] === TOKEN_VERSION_V1) {
    // 旧形式。種別を持たないため、広告視聴による付与として扱う。
    [version, expiresAtRaw, signature] = parts;
    kind = "ad";
    signedPayload = `${version}.${expiresAtRaw}`;
  } else if (parts.length === 4 && parts[0] === TOKEN_VERSION_V2) {
    const kindRaw: string = parts[2];
    if (!isKind(kindRaw)) return INACTIVE;
    [version, expiresAtRaw, , signature] = parts;
    kind = kindRaw;
    signedPayload = `${version}.${expiresAtRaw}.${kind}`;
  } else {
    return INACTIVE;
  }

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs)) return INACTIVE;

  // TEMP_ACCESS_SECRET未設定時など、署名計算そのものができない場合も
  // ページ全体をクラッシュさせず「無効」として扱う（不正/破損したCookieを
  // 受け取っただけでツールページが500になる事態を避けるための防御的処理）。
  let signatureValid: boolean;
  try {
    const expectedSignature = sign(signedPayload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);
    signatureValid = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return INACTIVE;
  }

  if (!signatureValid) return INACTIVE;
  if (Date.now() >= expiresAtMs) return { active: false, expiresAtMs, kind };

  return { active: true, expiresAtMs, kind };
}
