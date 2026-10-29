"use server";

import { redirect } from "next/navigation";
import { checkAdminAccess } from "@/lib/admin/auth";
import { grantPremium, revokeGrant } from "@/lib/plans/grant-store";
import { ADMIN_GRANT_DAY_CHOICES } from "@/lib/plans/grants";

/**
 * 管理画面: プレミアムの無料付与・取り消し（Server Action）。
 * 管理者として登録されたメールアドレスでログインしている人だけが実行できる（毎回、サーバーで確認する）。
 * 結果は、会員一覧ページへ戻って、上部のメッセージ（notice）で知らせる。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function back(notice: string): never {
  redirect(`/admin/members?notice=${encodeURIComponent(notice)}`);
}

export async function grantPremiumAction(formData: FormData): Promise<void> {
  const access = await checkAdminAccess();
  if (access.status !== "ok") back("forbidden");

  const userId = String(formData.get("userId") ?? "");
  const days = Number.parseInt(String(formData.get("days") ?? ""), 10);
  const note = String(formData.get("note") ?? "").trim().slice(0, 200);
  if (!UUID_RE.test(userId) || !(ADMIN_GRANT_DAY_CHOICES as readonly number[]).includes(days)) back("invalid");

  const result = await grantPremium({ userId, source: "admin", days, grantedBy: access.status === "ok" ? access.user.id : null, note: note || null });
  if (!result.ok) back(result.reason === "not_ready" ? "not_ready" : "failed");
  back("granted");
}

export async function revokeGrantAction(formData: FormData): Promise<void> {
  const access = await checkAdminAccess();
  if (access.status !== "ok") back("forbidden");

  const userId = String(formData.get("userId") ?? "");
  if (!UUID_RE.test(userId)) back("invalid");

  const result = await revokeGrant(userId);
  back(result.ok ? "revoked" : "failed");
}
