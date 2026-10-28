/**
 * 会員登録時の利用規約・プライバシーポリシーへの同意チェック。
 *
 * 工程38で、会員登録はサーバー（Server Action: src/lib/auth/signup-action.ts → signup-flow.ts）を経由する方式に変わった。
 * この関数はそのサーバー側で、送られてきた「同意した」の値を確認するために使う（フォームの画面でも、同じ文言の案内に使える）。
 * 同意した事実（文書の種類・版・日時）は、登録に成功したあと、サーバーが terms_consents テーブルへ記録する
 * （src/lib/legal/consent-store.ts）。
 */
export const SIGNUP_CONSENT_REQUIRED_MESSAGE =
  "会員登録には、利用規約とプライバシーポリシーへの同意が必要です。";

/** 同意していれば null、していなければ表示用のエラーメッセージを返す */
export function getSignupConsentError(accepted: boolean): string | null {
  return accepted ? null : SIGNUP_CONSENT_REQUIRED_MESSAGE;
}
