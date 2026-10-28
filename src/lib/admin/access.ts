/**
 * 管理者として認めるかの純粋な判定（工程39）。通信はしないので、単体テストできる。
 *
 * 認めるのは、次の3つがすべて満たされるときだけ:
 *  1. サーバーで検証したログイン情報がある（ブラウザの値だけでは判定しない）
 *  2. メールアドレスが、管理者として登録されたもの（ADMIN_EMAILS）に一致する
 *  3. そのメールアドレスが「確認済み」である（Supabase Authの email_confirmed_at が設定されている）
 *     — 他人のメールアドレスで、未確認のまま登録されたアカウントが管理者として扱われるのを防ぐ。
 * 情報が足りない（メールアドレスなし・確認状態が不明）ときは、認めない。
 */
export interface AdminCandidate {
  email: string | null;
  /** メールアドレスが確認済みか。取得できなかったときは false として扱う */
  emailConfirmed: boolean;
}

export type AdminDecision =
  | { status: "unauthenticated" }
  | { status: "forbidden"; reason: "not-admin" | "email-unconfirmed" }
  | { status: "ok" };

export function evaluateAdminAccess(user: AdminCandidate | null, adminEmails: readonly string[]): AdminDecision {
  if (!user) return { status: "unauthenticated" };
  const email = user.email?.trim().toLowerCase() ?? "";
  if (email === "" || !adminEmails.includes(email)) return { status: "forbidden", reason: "not-admin" };
  if (user.emailConfirmed !== true) return { status: "forbidden", reason: "email-unconfirmed" };
  return { status: "ok" };
}
