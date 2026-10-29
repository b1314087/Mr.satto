"use server";

import { redirect } from "next/navigation";
import { checkAdminAccess } from "@/lib/admin/auth";
import { grantPremium, revokeGrant } from "@/lib/plans/grant-store";
import { grantEndFromDate } from "@/lib/plans/grants";
import { isMemberId, memberReturnPath } from "@/lib/admin/member-links";

/**
 * 管理画面: プレミアムの無料付与・取り消し（Server Action）。
 * 管理者として登録されたメールアドレスでログインしている人だけが実行できる（毎回、サーバーで確認する）。
 * 結果は、操作したページ（会員一覧／その会員の詳細ページ）へ戻って、上部のメッセージ（notice）で知らせる。
 */
function backTo(path: string, notice: string): never {
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

/**
 * 会員のステータス（プラン）を変更する。
 *  - status=premium: 指定した最終日（日本時間・その日の終わり）まで、プレミアムを無料で付与する
 *  - status=free   : 無料付与を取り消して、無料プランに戻す
 * Stripeの契約（有料の支払い）は変更しない。契約中の人の解約・返金は、Stripe側で行う。
 */
export async function changeMemberStatusAction(formData: FormData): Promise<void> {
  const userId = String(formData.get("userId") ?? "");
  const returnPath = memberReturnPath(String(formData.get("returnTo") ?? ""), userId);
  const back: (notice: string) => never = (notice) => backTo(returnPath, notice);

  const access = await checkAdminAccess();
  if (access.status !== "ok") back("forbidden");

  const status = String(formData.get("status") ?? "");
  if (!isMemberId(userId)) back("invalid");

  if (status === "free") {
    const revoked = await revokeGrant(userId);
    back(revoked.ok ? "revoked" : "failed");
  }
  if (status !== "premium") back("invalid");

  const end = grantEndFromDate(String(formData.get("until") ?? ""), Date.now());
  if (end === null) back("invalid_date");
  const note = String(formData.get("note") ?? "").trim().slice(0, 200);

  const result = await grantPremium({ userId, source: "admin", endMs: end as number, grantedBy: access.status === "ok" ? access.user.id : null, note: note || null });
  if (!result.ok) back(result.reason === "not_ready" ? "not_ready" : result.reason === "invalid" ? "invalid_date" : "failed");
  back("granted");
}
