/**
 * 有料プランのアカウント共有対策（パスキー・登録端末・同時利用）の設定値。
 * サーバーとブラウザの両方から読む値だけを置く（秘密の値は置かない）。
 */

/** 1アカウントで登録できる端末の数 */
export const MAX_DEVICES = 2;
/** 端末の登録回数の制限（解除と登録の繰り返しで、使い回しの上限をすり抜けにくくする）：この期間に、この回数まで */
export const DEVICE_REGISTRATION_WINDOW_SEC = 7 * 24 * 60 * 60;
export const DEVICE_REGISTRATION_WINDOW_MAX = 3;

/** 1アカウントで登録できるパスキーの数（Apple・Google・Microsoftの3つ＋予備） */
export const MAX_PASSKEYS = 10;

/** 同時利用のロックの有効期間（秒）。この間に定期確認がなければ、ロックは空く（ブラウザを閉じた・スリープ・通信切断） */
export const LEASE_TTL_SEC = 180;
/** ブラウザが利用状態を確かめる間隔（ミリ秒） */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** パスキーで本人確認してから、もう一度確認を求めるまでの時間（ミリ秒） */
export const VERIFICATION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/**
 * 端末の解除・パスキーの削除・新しい端末の登録などに必要な「直近の本人確認」の有効期間（秒）。
 * 新しい端末ではこのあとメールの確認コードを入力するので、コードの有効期限（10分）に合わせる
 */
export const RECENT_VERIFICATION_TTL_SEC = 10 * 60;
/** チャレンジの有効期間（秒） */
export const CHALLENGE_TTL_SEC = 5 * 60;

/** パスキー認証の失敗が続いたときに、一時的に止める条件（この期間に、この回数） */
export const AUTH_FAILURE_WINDOW_SEC = 15 * 60;
export const AUTH_FAILURE_MAX = 10;

/** Cookie名 */
export const DEVICE_COOKIE = "mrsatto-device";
export const SESSION_COOKIE = "mrsatto-paid-session";
export const VERIFY_COOKIE = "mrsatto-pk-verify";
/**
 * ブラウザが定期確認を始めるかの目印（中身は意味を持たない。権限の判定には使わない）。
 * 本当のセッションの値はJavaScriptから読めないCookie（SESSION_COOKIE）に入れる
 */
export const SESSION_HINT_COOKIE = "mrsatto-paid-active";

/** 案内の文言（指示書の文言のまま） */
export const DEVICE_LIMIT_MESSAGE =
  "登録できる端末は最大2台です。新しい端末を登録するには、現在登録されている端末を1台解除してください。";
export const IN_USE_MESSAGE = "このアカウントは別の端末で利用中です。先に利用中の端末からログアウトしてください。";

/**
 * 新しい端末（2台目以降）の登録のための、メールの確認コード（2026-11-16に利用者と確定）。
 * 初めての端末（1台目）・登録済みの端末での12時間ごとの確認・登録済みの端末どうしの切り替えでは求めない
 */
export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_SEC = 10 * 60;
export const EMAIL_MAX_ATTEMPTS = 5;
export const EMAIL_RESEND_INTERVAL_SEC = 60;
export const EMAIL_HOURLY_MAX = 5;
/** コードを確認してから、端末の登録に使えるまでの時間（秒） */
export const EMAIL_APPROVAL_WINDOW_SEC = 10 * 60;
