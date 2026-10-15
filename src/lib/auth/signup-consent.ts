/**
 * 会員登録時の利用規約・プライバシーポリシーへの同意チェック（Phase 1-9）。
 *
 * 会員登録フォーム（src/components/auth/signup-form.tsx）は、ブラウザから直接
 * Supabase Authへ登録を行う構成のため、同意の確認もブラウザ側で行う。
 * 判定ロジックだけをこの純粋関数に切り出し、テストで直接検証できるようにしている。
 *
 * 注意: この確認は画面操作上の同意取得であり、サーバー側での強制ではない
 * （Supabase AuthのAPIを直接呼び出す場合は、この確認を経由しない）。
 * 同意の日時などをサーバーに記録する処理は、今回は追加していない。
 */
export const SIGNUP_CONSENT_REQUIRED_MESSAGE =
  "会員登録には、利用規約とプライバシーポリシーへの同意が必要です。";

/** 同意していれば null、していなければ表示用のエラーメッセージを返す */
export function getSignupConsentError(accepted: boolean): string | null {
  return accepted ? null : SIGNUP_CONSENT_REQUIRED_MESSAGE;
}
