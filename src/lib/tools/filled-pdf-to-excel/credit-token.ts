import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 記入済みPDF→Excelの「リワード広告視聴 → 1回・最大3ページの利用権」を、
 * サーバー側で検証可能な署名付きトークンとして扱う実装。
 *
 * src/lib/plans/temp-access-token.ts と同じHMAC署名の設計を踏襲しつつ、
 * 完全に別のトークン種別として扱う（TOKEN_VERSIONを変え、既存の
 * Temporary Accessトークンを誤ってこちらの検証に通せないようにする）。
 *
 * このトークンは「時間の窓」ではなく「1回使い切りの権利」を表す。
 * 実際の消費（使い切り）は credit-actions.ts の consumePageCredit() が
 * Cookie自体を削除することで行う（このファイルはあくまで署名の発行・検証のみ
 * を担当し、Cookieの読み書きには関与しない。責務の分離）。
 */

const TOKEN_VERSION = "pxc1";

function getSecret(): string {
  // 既存のTemporary Accessトークンと同じ秘密鍵を再利用する（新しい環境変数を
  // 増やさないため）。トークン種別はTOKEN_VERSIONで分離しているため、
  // 同じ鍵を共有していても異なるトークン種別として誤検証されることはない。
  const secret = process.env.TEMP_ACCESS_SECRET;
  if (!secret) {
    throw new Error(
      "TEMP_ACCESS_SECRET が設定されていません。記入済みPDF→Excelのリワード広告による" +
        "一時利用権を発行するには、この環境変数の設定が必要です。"
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

/** サーバー側でpage creditトークンを発行する（有効期限はここで確定する） */
export function issuePageCreditToken(durationMs: number): string {
  const expiresAtMs = Date.now() + durationMs;
  const payload = `${TOKEN_VERSION}.${expiresAtMs}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

export interface PageCreditCheck {
  active: boolean;
  expiresAtMs: number | null;
}

/** トークンの署名と有効期限を検証する。不正・期限切れの場合は active: false を返す */
export function verifyPageCreditToken(token: string | undefined | null): PageCreditCheck {
  if (!token) return { active: false, expiresAtMs: null };

  const parts = token.split(".");
  if (parts.length !== 3) return { active: false, expiresAtMs: null };

  const [version, expiresAtRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return { active: false, expiresAtMs: null };

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs)) return { active: false, expiresAtMs: null };

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
