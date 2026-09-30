import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchAllMembers, computeDashboardStats, fetchToolUsageSummary } from "@/lib/admin/data";
import { StatCard } from "@/components/admin/stat-card";

/**
 * 管理者ダッシュボード。
 *
 * src/app/admin/layout.tsx が既にアクセス制御を行っているが、Next.jsの
 * レンダリング順序に依存せず安全側に倒すため、このページ自身でも
 * checkAdminAccess() を呼び、"ok" 以外なら何もデータ取得しない
 * （2重チェック。既存コードでも各ページ・Route Handlerが個別に権限を
 * 検証する構成に合わせている）。
 */
export default async function AdminDashboardPage() {
  const access = await checkAdminAccess();
  if (access.status !== "ok") return null;

  const [members, usage] = await Promise.all([fetchAllMembers(), fetchToolUsageSummary()]);
  const stats = computeDashboardStats(members);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">ダッシュボード</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {access.user.email} でログイン中
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-500 dark:text-neutral-400">会員</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard label="総ユーザー数" value={stats.totalUsers.toLocaleString()} />
          <StatCard label="Freeユーザー数" value={stats.freeUsers.toLocaleString()} />
          <StatCard label="現在の有料会員数" value={stats.payingUsers.toLocaleString()} />
          <StatCard label="Standardユーザー数" value={stats.standardUsers.toLocaleString()} />
          <StatCard label="Premiumユーザー数" value={stats.premiumUsers.toLocaleString()} />
          <StatCard
            label="月間売上の目安(MRR)"
            value={`${stats.estimatedMonthlyRevenueYen.toLocaleString()}円`}
            note="現在有効な契約×単価から算出。Stripeの実績入金額とは異なります"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-500 dark:text-neutral-400">
          ツール利用（利用ログのあるツールのみ）
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard label="今日の利用回数" value={usage.todayTotal.toLocaleString()} />
          <StatCard label="今月の利用回数" value={usage.monthTotal.toLocaleString()} />
        </div>
        <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          Mr.Sattoのツールはブラウザ内で処理が完結する設計のため、利用回数をサーバー側で記録しているのは
          「記入済みPDF→Excel」など一部のツールのみです。詳細は
          <a href="/admin/usage" className="mx-1 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
            利用状況
          </a>
          ページを確認してください。
        </p>
      </section>
    </div>
  );
}
