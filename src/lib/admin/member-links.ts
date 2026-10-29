/**
 * 管理画面の会員ページのリンクまわりの、純粋な処理（server-only に依存せず、単体テストできる）。
 * - 会員一覧（/admin/members）と、会員ごとの詳細ページ（/admin/members/<ユーザーID>）の行き来
 * - 操作（ステータス変更）のあと、どちらのページへ戻すか
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMemberId(value: string): boolean {
  return UUID_RE.test(value);
}

/** 会員ごとの詳細ページのパス（ユーザーIDの形が正しくないときは null） */
export function memberDetailPath(userId: string): string | null {
  return isMemberId(userId) ? `/admin/members/${userId.toLowerCase()}` : null;
}

/**
 * 操作のあとに戻すページ。returnTo が "detail" のときだけ、その会員の詳細ページ。
 * それ以外（未指定・想定外の値）は、すべて会員一覧に戻す（外部のURLなどへは飛ばさない）。
 */
export function memberReturnPath(returnTo: string, userId: string): string {
  if (returnTo === "detail") return memberDetailPath(userId) ?? "/admin/members";
  return "/admin/members";
}

export const MEMBER_NOTICE_MESSAGES: Record<string, string> = {
  granted: "会員のステータスを「プレミアム（無料付与）」に変更しました。",
  revoked: "会員のステータスを「無料プラン」に戻しました。",
  invalid_date: "最終日が正しくありません。明日以降の日付を、約3年以内で指定してください。",
  invalid: "入力が正しくありません。もう一度お試しください。",
  failed: "保存できませんでした。しばらくしてから、もう一度お試しください。",
  not_ready: "付与の保存先（データベース）がまだ用意できていません。SQL（0008_premium_grants.sql）を実行してください。",
  forbidden: "この操作は、管理者だけが行えます。",
};
