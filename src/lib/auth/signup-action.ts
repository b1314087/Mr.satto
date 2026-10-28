"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { recordCurrentConsents } from "@/lib/legal/consent-store";
import { siteConfig } from "@/lib/config/site";
import { checkRateLimit } from "@/lib/utils/rate-limit";
import { runSignup } from "./signup-flow";

/**
 * 会員登録（Server Action）。工程38で、ブラウザから直接Supabase Authへ登録する方式から、サーバー経由に変更した。
 * 同意の確認・記録をサーバー側で行うため（src/lib/auth/signup-flow.ts）。
 *
 * 画面（signup-form.tsx）には、結果の状態だけを返す。パスワードは、処理の間だけ使い、保存・ログ出力しない。
 */
export interface SignupActionState {
  status: "idle" | "error" | "confirm-email";
  message?: string;
  /** 入力し直しの手間を減らすため、エラー時にメールアドレスだけ返す（パスワードは返さない） */
  email?: string;
}

// 会員登録の乱打を抑える（IPごと）。メモリ内の簡易な制限で、複数インスタンスに分散すると完全ではない（rate-limit.ts 参照）。
const SIGNUP_RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 };

async function clientKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip") || "unknown";
}

export async function signUpAction(_prev: SignupActionState, formData: FormData): Promise<SignupActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // チェックボックスの値。ブラウザの表示ではなく、送られてきた値をサーバーで確認する。
  const consentAccepted = formData.get("consent") === "on";

  const limited = checkRateLimit(`signup:${await clientKey()}`, SIGNUP_RATE_LIMIT);
  if (limited.limited) {
    return { status: "error", message: "リクエストが多すぎます。しばらくしてから再度お試しください。", email };
  }

  const supabase = await getSupabaseServerClient();
  if (!supabase) return { status: "error", message: "現在、会員登録機能は準備中です。", email };

  const outcome = await runSignup(
    { email, password, consentAccepted },
    {
      async signUp(addr, pw) {
        const { data, error } = await supabase.auth.signUp({
          email: addr,
          password: pw,
          options: { emailRedirectTo: `${siteConfig.url}/auth/callback` },
        });
        return {
          error: error ? { message: error.message } : null,
          userId: data.user?.id ?? null,
          // 登録済みのメールアドレスでは、identities が空の（実在しない）ユーザーが返る
          alreadyRegistered: !!data.user && (data.user.identities?.length ?? 0) === 0,
          hasSession: !!data.session,
        };
      },
      recordConsent: (userId) => recordCurrentConsents(userId, "signup"),
      onConsentNotRecorded: () => console.error("[signup] consent was not recorded; it will be requested before checkout"),
    },
  );

  if (outcome.status === "signed-in") redirect("/account");
  if (outcome.status === "confirm-email") return { status: "confirm-email" };
  return { status: "error", message: outcome.message, email };
}
