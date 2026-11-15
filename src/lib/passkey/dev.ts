import "server-only";

import { cookies } from "next/headers";
import { isSupabaseServiceConfigured } from "@/lib/supabase/service-config";

/**
 * 開発サーバーの自動テスト専用の仕組み（本番では一切動かない）。
 *
 * 次の3つをすべて満たすときだけ有効：
 *   1. NODE_ENV が development（next dev）
 *   2. 環境変数 PASSKEY_DEV_STORE=memory（playwright.config.ts がテストのときだけ付ける）
 *   3. Supabase の Service Role が設定されていない（本物のDBがある環境では、メモリ上の実装に切り替えない）
 *
 * 有効なときは、Cookie「mrsatto-dev-user」（UUID）をログイン中のユーザーとして扱い、
 * パスキー・端末・同時利用のデータをメモリ上に置く。ブラウザの仮想認証器（Playwright）で、
 * 本物のWebAuthnの登録・認証・署名の検証をテストするために使う。
 */
export const DEV_USER_COOKIE = "mrsatto-dev-user";

export function isPasskeyDevMode(): boolean {
  return process.env.NODE_ENV === "development" && process.env.PASSKEY_DEV_STORE === "memory" && !isSupabaseServiceConfigured();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 開発テスト用のログイン中ユーザー（条件を満たさなければ null） */
export async function getDevPasskeyUser(): Promise<{ id: string; email: string } | null> {
  if (!isPasskeyDevMode()) return null;
  const raw = (await cookies()).get(DEV_USER_COOKIE)?.value ?? "";
  if (!UUID.test(raw)) return null;
  return { id: raw, email: `${raw.slice(0, 8)}@example.test` };
}
