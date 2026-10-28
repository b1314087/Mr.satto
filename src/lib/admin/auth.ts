import "server-only";

import { getCurrentUser, type AuthenticatedUser } from "@/lib/auth/user";
import { adminConfig } from "./config";
import { evaluateAdminAccess } from "./access";

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
  // 判定は純粋な関数（access.ts）。管理者として登録されたメールアドレスで、かつ、メールアドレスが確認済みのときだけ認める（工程39）。
  const decision = evaluateAdminAccess(user, adminConfig.adminEmails);
  if (!user || decision.status === "unauthenticated") return { status: "unauthenticated" };
  if (decision.status === "forbidden") {
    // 管理者として登録されているのに、メール未確認で止めたときだけ、運営者が原因に気づけるよう記録する（メールアドレスは出さない）
    if (decision.reason === "email-unconfirmed") console.warn("[admin] access denied: admin email is not confirmed");
    return { status: "forbidden", user };
  }
  return { status: "ok", user };
}
