import { getSignupConsentError } from "./signup-consent";

/**
 * 会員登録の流れ（工程38）。サーバー側（Server Action）で実行し、同意の確認と記録をサーバーで行う。
 * 通信は依存（deps）として受け取るので、Supabaseに接続せずに単体テストできる。
 *
 * 同意は、ブラウザから送られた「同意した」の値をサーバーで確認し、確認できたときだけ登録に進む。
 * 同意の記録（版・日時）は、クライアントの値ではなく、サーバーが持つ現行の版を使って保存する。
 */

export const MIN_PASSWORD_LENGTH = 8;

export interface SignUpResult {
  error: { message: string } | null;
  /** Supabase Authが返したユーザーID（登録済みのメールアドレスの場合は、実在しないIDが返ることがある） */
  userId: string | null;
  /** 登録済みのメールアドレスだった（Supabase Authは、存在の有無を悟らせないため、見かけ上は成功を返す） */
  alreadyRegistered: boolean;
  /** その場でログイン済みになった（メール確認が不要な設定のとき） */
  hasSession: boolean;
}

export interface SignupDeps {
  signUp(email: string, password: string): Promise<SignUpResult>;
  recordConsent(userId: string): Promise<boolean>;
  /** 記録できなかったことを知らせる（個人情報は渡さない） */
  onConsentNotRecorded?(): void;
}

export type SignupOutcome =
  | { status: "error"; message: string }
  | { status: "confirm-email" }
  | { status: "signed-in" };

export function translateSignupError(message: string): string {
  if (message.includes("already registered") || message.includes("already exists")) {
    return "このメールアドレスは既に登録されています。ログインをお試しください。";
  }
  if (message.includes("Password") && message.includes("least")) {
    return `パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`;
  }
  return "会員登録に失敗しました。しばらくしてから再度お試しください。";
}

export async function runSignup(
  input: { email: string; password: string; consentAccepted: boolean },
  deps: SignupDeps,
): Promise<SignupOutcome> {
  // 1. 同意の確認（サーバー側）。同意がなければ、Supabase Authへは一切リクエストしない。
  const consentError = getSignupConsentError(input.consentAccepted);
  if (consentError) return { status: "error", message: consentError };

  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { status: "error", message: `パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。` };
  }

  let result: SignUpResult;
  try {
    result = await deps.signUp(input.email, input.password);
  } catch {
    return { status: "error", message: translateSignupError("") };
  }
  if (result.error) return { status: "error", message: translateSignupError(result.error.message) };

  // 2. 登録済みのメールアドレスには、同意を記録しない（他人のアカウントへの記録を作らない）。
  //    メールアドレスの登録有無を悟らせないため、新規登録と同じ「確認メール」の案内を返す。
  if (result.alreadyRegistered || !result.userId) return { status: "confirm-email" };

  // 3. 新規登録できたユーザーについて、現行の版への同意を記録する。
  //    記録に失敗しても登録は取り消さない。有料プランの申し込み前にあらためて同意を求めるため（checkoutが確認する）、
  //    同意のないまま決済に進むことはない。
  let recorded = false;
  try {
    recorded = await deps.recordConsent(result.userId);
  } catch {
    recorded = false;
  }
  if (!recorded) deps.onConsentNotRecorded?.();

  return result.hasSession ? { status: "signed-in" } : { status: "confirm-email" };
}
