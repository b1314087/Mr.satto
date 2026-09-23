/**
 * ユーザー状態（Guest / ログイン済み）の抽象層。
 *
 * 「ログインしていないこと」と「料金プランがfreeであること」は
 * 別概念として扱う（詳細は src/lib/plans/current-plan.ts のコメントを参照）。
 * このファイルは前者（ユーザー状態）だけを扱い、後者（プラン）には関知しない。
 */

/** ユーザー状態。guest = 未ログイン / authenticated = ログイン済み */
export type UserState = "guest" | "authenticated";

/**
 * ログイン済みユーザーの情報。
 *
 * 現時点では認証機能（Supabase Auth / Googleログイン等）自体が
 * 存在しないため、実際にこの型の値が生成されることはない
 * （getCurrentUser() が常に null を返すため）。
 * 将来、認証を実装した際にここへ email 等のフィールドを追加する想定。
 */
export interface AuthenticatedUser {
  id: string;
}

/**
 * 現在のユーザーを取得する唯一の窓口。
 *
 * 今回、Supabase Auth・Googleログイン・メール認証などは実装しない。
 * そのため現時点では常に null（= 未ログイン = Guest）を返す。
 *
 * 将来ここを実際のログインセッション参照に差し替えるだけで、
 * getCurrentPlan()・ToolAccessGate など呼び出し側は変更不要になる設計。
 */
export function getCurrentUser(): AuthenticatedUser | null {
  return null;
}

/**
 * ユーザー状態（Guest / ログイン済み）を取得する。
 * Mr.Sattoでは無料利用にログインを要求しないため、
 * 「未ログイン = 利用不可」を意味しない点に注意
 * （Guestでもstandard対象ツールは広告視聴で利用できる。詳細は plans/access.ts）。
 */
export function getUserState(): UserState {
  return getCurrentUser() === null ? "guest" : "authenticated";
}
