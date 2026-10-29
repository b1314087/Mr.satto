/**
 * アクセス数に含めない（運営者などの）アカウントの判定。純粋な処理だけ。
 *
 * 除外するのは、次のメールアドレスでログインした状態でのアクセス（大文字小文字は区別しない）。
 * - 管理者（環境変数 ADMIN_EMAILS）
 * - 追加で除外するもの（環境変数 ANALYTICS_EXCLUDED_EMAILS。カンマ区切り）
 * メールアドレスをソースコードに書かないため、環境変数で指定する。
 * ログインしていないブラウザでのアクセスは、誰か分からないので除外できない。
 */
export function parseEmailList(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export function isExcludedFromAccessCount(email: string | null | undefined, excluded: readonly string[]): boolean {
  if (!email) return false;
  return excluded.includes(email.trim().toLowerCase());
}

/** 環境変数から、除外するメールアドレスの一覧を作る */
export function excludedEmailsFromEnv(env: { ADMIN_EMAILS?: string; ANALYTICS_EXCLUDED_EMAILS?: string }): string[] {
  return [...new Set([...parseEmailList(env.ADMIN_EMAILS), ...parseEmailList(env.ANALYTICS_EXCLUDED_EMAILS)])];
}
