import "server-only";

/**
 * 管理画面(/admin)の管理者判定に使う設定。
 *
 * ADMIN_EMAILS は管理者として扱うメールアドレスをカンマ区切りで列挙する
 * サーバー専用の環境変数（src/lib/stripe/config.ts と同じ方針で、
 * NEXT_PUBLIC_ は付けない＝ブラウザへは一切渡さない秘密寄りの設定値）。
 *
 * 値が空の場合は「管理者が誰もいない」安全側の既定値として扱う
 * （未設定時に誰でも管理者になってしまう、という事故を避ける）。
 * 架空のメールアドレスを埋め込むことはしない（既存のAdSense/GAM/Stripe設定と
 * 同じ方針。実際に管理者として使うメールアドレスをVercelの環境変数へ設定する）。
 */
function parseAdminEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export const adminConfig = {
  adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS ?? ""),
};

/** このメールアドレスが管理者として登録されているか（大文字小文字を区別しない） */
export function isAdminEmail(email: string | null): boolean {
  if (!email) return false;
  return adminConfig.adminEmails.includes(email.trim().toLowerCase());
}
