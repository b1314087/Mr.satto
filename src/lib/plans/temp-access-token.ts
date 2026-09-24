import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Freeユーザーの「リワード広告視聴後15分間」のTemporary Accessを、
 * サーバー側で検証可能な署名付きトークンとして扱うための実装。
 *
 * 仕様上の要求（Phase 3 spec 4章・20章）：
 *   - 「ユーザーが時計を変更するだけで不正に延長できる設計にしない」
 *   - 「localStorageの値だけで15分を無期限化」できないようにする
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

const TOKEN_VERSION = "v1";

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

/** サーバー側でTemporary Accessトークンを発行する（有効期限はここで確定する） */
export function issueTemporaryAccessToken(durationMs: number): string {
  const expiresAtMs = Date.now() + durationMs;
  const payload = `${TOKEN_VERSION}.${expiresAtMs}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export interface TemporaryAccessCheck {
  active: boolean;
  expiresAtMs: number | null;
}

/**
 * トークンの署名と有効期限を検証する。
 * 署名が一致しない・形式が不正・期限切れのいずれの場合も active: false を返す。
 */
export function verifyTemporaryAccessToken(token: string | undefined | null): TemporaryAccessCheck {
  if (!token) return { active: false, expiresAtMs: null };

  const parts = token.split(".");
  if (parts.length !== 3) return { active: false, expiresAtMs: null };

  const [version, expiresAtRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return { active: false, expiresAtMs: null };

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs)) return { active: false, expiresAtMs: null };

  // TEMP_ACCESS_SECRET未設定時など、署名計算そのものができない場合も
  // ページ全体をクラッシュさせず「無効」として扱う（不正/破損したCookieを
  // 受け取っただけでツールページが500になる事態を避けるための防御的処理）。
  let signatureValid: boolean;
  try {
    const expectedSignature = sign(`${version}.${expiresAtRaw}`);
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSignature);
    signatureValid = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return { active: false, expiresAtMs: null };
  }

  if (!signatureValid) return { active: false, expiresAtMs: null };
  if (Date.now() >= expiresAtMs) return { active: false, expiresAtMs };

  return { active: true, expiresAtMs };
}
