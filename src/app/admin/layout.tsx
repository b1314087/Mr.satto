import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { checkAdminAccess } from "@/lib/admin/auth";
import { ForbiddenScreen } from "@/components/admin/forbidden-screen";
import { AdminNav } from "@/components/admin/admin-nav";

// 管理画面は検索エンジンに一切公開しない（src/app/account/page.tsxと同じ方針）。
export const metadata: Metadata = {
  title: "管理画面",
  robots: { index: false, follow: false },
};

/**
 * /admin 配下の唯一のアクセス制御ポイント。
 *
 * Next.js App Routerでは、/admin配下のどのページも必ずこのレイアウトを
 * 経由してレンダリングされる（レイアウトを経由せずページ単体へ到達する経路は
 * 存在しない）。そのため、ここで checkAdminAccess() の結果が
 * "ok" 以外の場合に children を一切レンダリングしないことで、配下の各ページの
 * データ取得コード（src/lib/admin/data.ts の関数呼び出し）自体が実行されない
 * ことを保証する。
 *
 * - 未ログイン       -> /login へリダイレクト（ログイン後に/adminへ戻れるようnextを付与）
 * - ログイン済みだが管理者ではない -> children を描画せず、403相当の画面を表示
 * - 管理者           -> 共通ナビゲーション付きでchildrenを描画
 *
 * 既存のミドルウェア(middleware.ts)は導入しない。このリポジトリは元々
 * middleware.tsを持たず、各ページ・Route Handlerが個別にサーバー側で
 * 認証・権限を検証する構成（例: src/lib/plans/current-plan.tsのgetServerPlan()）
 * のため、/adminもその既存方針に合わせる。
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const access = await checkAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login?next=/admin");
  }

  if (access.status === "forbidden") {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <ForbiddenScreen />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <AdminNav />
      {children}
    </div>
  );
}
