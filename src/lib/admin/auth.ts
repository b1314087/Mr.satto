import "server-only";

import { getCurrentUser, type AuthenticatedUser } from "@/lib/auth/user";
import { isAdminEmail } from "./config";

/**
 * /admin 配下の唯一のアクセス判定窓口。
 *
 * 既存の getCurrentUser()（Supabase Authの実セッションをサーバー側で検証する
 * 唯一の窓口。src/lib/auth/user.ts）をそのまま利用し、認証そのものの
 * 仕組みは新設しない。「ログイン済みユーザーの中で、管理者として登録された
 * メールアドレスかどうか」の判定だけをこのファイルに追加する。
 *
 * ブラウザ側の値（Cookie・localStorage等）だけで管理者判定を行うことはしない。
 * /admin 配下の各ページ・レイアウトは、データ取得の前に必ずこの関数を呼ぶこと
 * （src/app/admin/layout.tsx がその唯一の入口）。
 */
export type AdminAccess =
  | { status: "unauthenticated" }
  | { status: "forbidden"; user: AuthenticatedUser }
  | { status: "ok"; user: AuthenticatedUser };

export async function checkAdminAccess(): Promise<AdminAccess> {
  const user = await getCurrentUser();
  if (!user) return { status: "unauthenticated" };
  if (!isAdminEmail(user.email)) return { status: "forbidden", user };
  return { status: "ok", user };
}
