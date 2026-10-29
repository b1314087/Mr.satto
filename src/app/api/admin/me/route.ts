import { NextResponse } from "next/server";
import { checkAdminAccess } from "@/lib/admin/auth";

/**
 * 「いまログインしている人が管理者か」だけを返す（ヘッダーの「管理画面」リンクを出すかどうかの判定用）。
 * 返すのは true / false だけで、管理者のメールアドレスなどは一切返さない。
 * 判定は /admin と同じ（管理者として登録され、メールが確認済みであること）。このリンクの有無は表示だけの話で、
 * 管理画面そのものの入口は、これまでどおり、サーバー側で毎回確認する。
 */
export async function GET() {
  const access = await checkAdminAccess();
  return NextResponse.json({ admin: access.status === "ok" }, { headers: { "Cache-Control": "no-store" } });
}
