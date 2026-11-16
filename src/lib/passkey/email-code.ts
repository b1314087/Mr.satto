import "server-only";

import { createHash, randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { supabaseConfig, isSupabaseConfigured } from "@/lib/supabase/config";
import { EMAIL_CODE_LENGTH, EMAIL_CODE_TTL_SEC } from "./config";
import { isPasskeyDevMode } from "./dev";

/**
 * 新しい端末の登録のための、メールの確認コードの送信と照合（サーバー専用）。
 *
 * 本番：Supabase Auth のメールのワンタイムコード（signInWithOtp / verifyOtp）を使う。
 *   - コードの作成・保存（ハッシュ）・照合は Supabase Auth が行う。Mr.Satto のDBにもログにも、コードは残さない。
 *   - メールは、Supabase に設定したメール送信（SMTP）から送られる。新しいライブラリ・有料APIは使わない。
 *   - 会員登録していないアドレスに、勝手にアカウントを作らない（shouldCreateUser: false）。
 *   - 照合のためにSupabaseが作る一時的なログインは、このサーバーの中だけで使い、すぐ取り消す（利用者のログインは変わらない）。
 * 開発の自動テスト：メモリ上でコードを作る（dev.ts の条件のときだけ。テストがコードを読み取れるようにする）。
 *
 * 有効期限・試せる回数・送り直しの間隔・送信数は、この外側（server.ts とDB）で判定する。
 */

export type SendResult = { ok: true } | { ok: false; reason: "not_authorized" | "rate_limited" | "unavailable" | "error" };

export interface EmailCodeSender {
  send(email: string): Promise<SendResult>;
  verify(email: string, code: string): Promise<boolean>;
}

function isolatedSupabaseClient() {
  return createClient(supabaseConfig.url, supabaseConfig.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const supabaseSender: EmailCodeSender = {
  async send(email) {
    if (!isSupabaseConfigured()) return { ok: false, reason: "unavailable" };
    const { error } = await isolatedSupabaseClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (!error) return { ok: true };
    const status = (error as { status?: number }).status;
    const message = (error.message ?? "").toLowerCase();
    if (status === 429 || message.includes("rate limit") || message.includes("security purposes")) return { ok: false, reason: "rate_limited" };
    if (message.includes("not authorized")) return { ok: false, reason: "not_authorized" };
    return { ok: false, reason: "error" };
  },
  async verify(email, code) {
    if (!isSupabaseConfigured()) return false;
    const client = isolatedSupabaseClient();
    const { data, error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
    if (error || !data.session) return false;
    // 照合のためにできた一時的なログインは、すぐ取り消す
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
    return true;
  },
};

// --- 開発の自動テスト専用（本番では使わない） ---
interface DevCode { hash: string; expiresAt: number; plain: string }
const g = globalThis as unknown as { __mrsattoDevEmailCodes?: Map<string, DevCode> };
const devCodes = () => (g.__mrsattoDevEmailCodes ??= new Map());
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

const devSender: EmailCodeSender = {
  async send(email) {
    const plain = String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, "0");
    devCodes().set(email, { hash: sha(plain), expiresAt: Date.now() + EMAIL_CODE_TTL_SEC * 1000, plain });
    return { ok: true };
  },
  async verify(email, code) {
    const entry = devCodes().get(email);
    if (!entry || entry.expiresAt <= Date.now() || entry.hash !== sha(code)) return false;
    devCodes().delete(email);
    return true;
  },
};

/** 開発の自動テスト専用：最後に「送った」コード（dev.ts の条件のときだけ。本番では常に null） */
export function devLastEmailCode(email: string): string | null {
  if (!isPasskeyDevMode()) return null;
  return devCodes().get(email)?.plain ?? null;
}

export function getEmailCodeSender(): EmailCodeSender {
  return isPasskeyDevMode() ? devSender : supabaseSender;
}

/** 画面に出すメールアドレスは、一部だけにする（例：k***@gmail.com） */
export function maskEmail(email: string | null | undefined): string {
  if (!email || !email.includes("@")) return "登録しているメールアドレス";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export const EMAIL_CODE_RE = new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`);
