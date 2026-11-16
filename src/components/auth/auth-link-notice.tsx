import { ErrorMessage } from "@/components/common/error-message";
import { AUTH_LINK_MESSAGES, EMAIL_CONFIRMED_MESSAGE, isAuthLinkProblem } from "@/lib/auth/auth-link";

/**
 * ログイン画面の上に出す、メールのリンクの結果のお知らせ（src/app/auth/callback/route.ts から戻ってきたとき）。
 * URLの値は決まった種類（expired など）だけを受け付け、それ以外の文字は表示しない。
 */
export function AuthLinkNotice({ confirmed, authError, legacyError }: { confirmed?: string; authError?: string; legacyError?: string }) {
  if (confirmed === "1") {
    return (
      <div role="status" data-testid="auth-link-notice" className="ms-status mb-4 text-sm text-ms-success">
        {EMAIL_CONFIRMED_MESSAGE}
      </div>
    );
  }
  // 以前の形（?error=confirmation_failed）で戻ってきた場合も、理由が分からないので「無効なリンク」として案内する
  const problem = isAuthLinkProblem(authError) ? authError : legacyError === "confirmation_failed" ? "invalid" : null;
  if (!problem) return null;
  return (
    <div className="mb-4" data-testid="auth-link-notice" data-problem={problem}>
      <ErrorMessage message={AUTH_LINK_MESSAGES[problem]} />
    </div>
  );
}
