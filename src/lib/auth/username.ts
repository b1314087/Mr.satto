/**
 * ユーザー名のルール（会員登録・アカウント画面で共通。純粋な処理だけ）。
 *
 * - 3〜20文字。文字（日本語・英字）・数字・「_」「-」だけ使える。空白や記号は使えない。
 * - 全角・半角のゆれは、半角にそろえて（NFKC）保存する。
 * - 重複の判定は、大文字・小文字を区別しない（Taro と taro は同じ名前）。DB側にも同じ制約がある
 *   （supabase/migrations/0006_profile_username.sql）。
 * - ユーザー名は公開しない。本人のアカウント画面と、運営者の管理画面にだけ表示する。
 */

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/** 運営・サービス名と紛らわしい名前（重複判定と同じ形に直して比べる） */
const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "staff",
  "owner",
  "official",
  "moderator",
  "mrsatto",
  "mr-satto",
  "mr_satto",
  "satto",
  "運営",
  "運営者",
  "管理者",
  "管理人",
  "公式",
  "サポート",
]);

const ALLOWED_RE = /^[\p{L}\p{N}_-]+$/u;

export const USERNAME_RULE_HINT = `${USERNAME_MIN_LENGTH}〜${USERNAME_MAX_LENGTH}文字。日本語・英数字・「_」「-」が使えます（他の方に表示されることはありません）。`;

export type UsernameValidation = { ok: true; username: string; key: string } | { ok: false; message: string };

/** 保存する形（全角半角をそろえ、前後の空白を除く） */
export function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim();
}

/** 重複の判定に使う形（大文字・小文字を区別しない） */
export function usernameKey(value: string): string {
  return normalizeUsername(value).toLowerCase();
}

export function validateUsername(raw: unknown): UsernameValidation {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, message: "ユーザー名を入力してください。" };
  const username = normalizeUsername(raw);
  const length = Array.from(username).length;
  if (length < USERNAME_MIN_LENGTH || length > USERNAME_MAX_LENGTH) {
    return { ok: false, message: `ユーザー名は${USERNAME_MIN_LENGTH}〜${USERNAME_MAX_LENGTH}文字で入力してください。` };
  }
  if (!ALLOWED_RE.test(username)) {
    return { ok: false, message: "ユーザー名に使えるのは、日本語・英数字・「_」「-」だけです（空白や記号は使えません）。" };
  }
  const key = username.toLowerCase();
  if (RESERVED_USERNAMES.has(key)) return { ok: false, message: "このユーザー名は使用できません。別の名前にしてください。" };
  return { ok: true, username, key };
}

export const USERNAME_TAKEN_MESSAGE = "このユーザー名は既に使われています。別の名前にしてください。";
