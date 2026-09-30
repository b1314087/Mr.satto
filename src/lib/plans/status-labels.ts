/**
 * Stripe Subscription status の日本語表示ラベル。
 *
 * src/app/account/page.tsx（本人向けの契約状況表示）と
 * src/app/admin/members/page.tsx（管理画面の会員一覧）の両方から参照する、
 * 表示文言の唯一の情報源。各所に同じラベルをハードコードして重複させない。
 */
export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  active: "有効",
  trialing: "トライアル中",
  past_due: "お支払いの確認中",
  canceled: "解約済み",
  unpaid: "未払い",
  incomplete: "手続き未完了",
  incomplete_expired: "手続き期限切れ",
  paused: "一時停止中",
};
