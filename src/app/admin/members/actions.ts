"use server";

import { redirect } from "next/navigation";
import { checkAdminAccess } from "@/lib/admin/auth";
import { grantPremium, revokeGrant } from "@/lib/plans/grant-store";
import { grantEndFromDate } from "@/lib/plans/grants";

/**
 * 管理画面: プレミアムの無料付与・取り消し（Server Action）。
 * 管理者として登録されたメールアドレスでログインしている人だけが実行できる（毎回、サーバーで確認する）。
 * 結果は、会員一覧ページへ戻って、上部のメッセージ（notice）で知らせる。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function back(notice: string): never {
  redirect(`/admin/members?notice=${encodeURIComponent(notice)}`);
}

/**
 * 会員のステータス（プラン）を変更する。
 *  - status=premium: 指定した最終日（日本時間・その日の終わり）まで、プレミアムを無料で付与する
 *  - status=free   : 無料付与を取り消して、無料プランに戻す
 * Stripeの契約（有料の支払い）は変更しない。契約中の人の解約・返金は、Stripe側で行う。
 */
export async function changeMemberStatusAction(formData: FormData): Promise<void> {
  const access = await checkAdminAccess();
  if (access.status !== "ok") back("forbidden");

  const userId = String(formData.get("userId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!UUID_RE.test(userId)) back("invalid");

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
