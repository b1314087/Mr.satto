/**
 * 管理画面の会員検索（メールアドレス・ユーザー名の部分一致）。純粋な処理だけ（"server-only" に依存せず、単体テストできる）。
 * 大文字・小文字と、全角・半角の違いは区別しない。
 */
export function matchesMemberQuery(member: { email: string | null; username: string | null }, query: string): boolean {
  const q = query.normalize("NFKC").trim().toLowerCase();
  if (q === "") return true;
  const email = (member.email ?? "").normalize("NFKC").toLowerCase();
  const name = (member.username ?? "").normalize("NFKC").toLowerCase();
  return email.includes(q) || name.includes(q);
}
