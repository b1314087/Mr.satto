/**
 * メールのリンク（会員登録の確認・パスワード再設定）を開いたときの、結果の分類と表示用の文言。
 *
 * Supabase のエラーの内容（英語の文や内部のコード）は、画面にそのまま出さない。
 * ここで決めた種類（AuthLinkProblem）に分けて、決まった日本語の文だけを表示する。
 * URLにも、この種類の名前（expired など）だけを載せる。
 */

export type AuthLinkProblem = "expired" | "used" | "invalid" | "network" | "session";

export const AUTH_LINK_MESSAGES: Record<AuthLinkProblem, string> = {
  expired: "リンクの有効期限が切れています。もう一度メールを送信してください。",
  used: "このリンクは既に使用されています。必要に応じて再度手続きを行ってください。",
  invalid: "リンクが無効です。メールを再送信して、最新のリンクを使用してください。",
  network: "通信に失敗しました。時間をおいてもう一度お試しください。",
  session: "認証状態を確認できませんでした。最初から手続きをやり直してください。",
};

/** 別のブラウザ・スマートフォンで確認リンクを開いた場合など、メールアドレスの確認が終わったことを知らせる文 */
export const EMAIL_CONFIRMED_MESSAGE =
  "メールアドレスの確認が完了しました。登録したメールアドレスとパスワードでログインしてください。";

export const PASSWORD_MESSAGES = {
  mismatch: "2つのパスワードが一致していません。",
  tooShort: "パスワードは8文字以上で入力してください。",
  updateFailed: "パスワードを更新できませんでした。もう一度お試しください。",
  samePassword: "現在と同じパスワードは使えません。別のパスワードを入力してください。",
} as const;

export function isAuthLinkProblem(value: unknown): value is AuthLinkProblem {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AUTH_LINK_MESSAGES, value);
}

/** 期限切れ（Supabaseは、使用済みのメールのリンクにも otp_expired を返す） */
const EXPIRED_CODES = new Set(["otp_expired", "flow_state_expired", "session_expired", "bad_jwt"]);
/** 使用済み（認証の手続きが一度使われて、もう残っていない） */
const USED_CODES = new Set(["flow_state_not_found", "refresh_token_already_used", "refresh_token_not_found", "session_not_found"]);
/** 通信の問題 */
const NETWORK_CODES = new Set(["request_timeout", "over_request_rate_limit"]);

/**
 * Supabase のエラー（code・name・status）を、表示用の種類に分ける。
 * 文（message）は、内部の言い回しが変わることがあるため、判定に使わない。
 */
export function classifyAuthLinkError(error: {
  code?: string | null;
  name?: string | null;
  status?: number | null;
} | null | undefined): AuthLinkProblem {
  if (!error) return "invalid";
  const code = error.code ?? "";
  if (error.name === "AuthRetryableFetchError" || error.status === 0 || NETWORK_CODES.has(code)) return "network";
  if (EXPIRED_CODES.has(code)) return "expired";
  if (USED_CODES.has(code)) return "used";
  return "invalid";
}

/** PKCE の確認用の値が、このブラウザに無い（申し込みと別のブラウザ・端末でリンクを開いた） */
export function isCodeVerifierMissing(error: { code?: string | null; name?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "pkce_code_verifier_not_found" || error.name === "AuthPKCECodeVerifierMissingError");
}

export interface AuthLinkParams {
  /** PKCE の認可コード（?code=） */
  code: string | null;
  /** パスワード再設定のリンクから戻ってきたときの値（#access_token=…）。画面の中だけで使い、保存・送信しない */
  accessToken: string | null;
  refreshToken: string | null;
  type: string | null;
  /** Supabase がリンクの確認に失敗したときの値（?error=… または #error=…） */
  error: string | null;
  errorCode: string | null;
}

/** URLの ? と # の両方から、認証の結果を読み取る（# の値を優先） */
export function parseAuthLinkParams(search: string, hash: string): AuthLinkParams {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const pick = (name: string) => fragment.get(name) ?? query.get(name);
  return {
    code: query.get("code"),
    accessToken: fragment.get("access_token"),
    refreshToken: fragment.get("refresh_token"),
    type: fragment.get("type"),
    error: pick("error"),
    errorCode: pick("error_code"),
  };
}
