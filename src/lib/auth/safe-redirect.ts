/**
 * ログイン後のリダイレクト先（?next=）が、外部サイトへ誘導する
 * Open Redirect に使われないことを確認する（工程36 セキュリティ総点検で強化）。
 *
 * 「"/" で始まる」「"//" や "/\" で始まらない」だけの判定では、
 * "/\t//evil.example" のようにタブ・改行を含む値が漏れる。
 * URLの解析（WHATWG URL）は ASCII のタブ・改行を黙って取り除くため、
 * "/\t/evil.example" は "//evil.example"（外部オリジン）として解釈されてしまう。
 *
 * そのため次の3段階で判定する。
 *  1. 先頭が "/" で、"//" や "/\" で始まらない
 *  2. 制御文字（タブ・改行を含む）とバックスラッシュを含まない
 *  3. 実際に URL として解析し、ダミーのオリジンのままであることを確認する
 *
 * 純粋関数（ブラウザ・サーバーのどちらでも動く）。
 */
const DUMMY_ORIGIN = "https://safe-redirect.invalid";

export function isSafeInternalPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//") || path.startsWith("/\\")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  try {
    return new URL(path, DUMMY_ORIGIN).origin === DUMMY_ORIGIN;
  } catch {
    return false;
  }
}
