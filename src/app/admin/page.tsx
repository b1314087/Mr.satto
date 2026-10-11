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
          ツール利用（過去の利用ログのみ）
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard
            label="今日の利用回数（過去ログ）"
            value={usage.available ? usage.todayTotal.toLocaleString() : "取得できません"}
          />
          <StatCard
            label="今月の利用回数（過去ログ）"
            value={usage.available ? usage.monthTotal.toLocaleString() : "取得できません"}
          />
        </div>
        <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          {usage.available
            ? "Mr.Sattoのツールはブラウザ内で処理が完結する設計のため、現在ツールの利用回数は新たに記録していません。ここに表示されるのは、過去に記録された利用ログの集計のみで、サイト全体の利用回数ではありません。"
            : "利用ログのデータを取得できませんでした（Supabaseの接続設定を確認してください）。0回という意味ではありません。"}
          詳細は
          <a href="/admin/usage" className="mx-1 text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
            利用状況
          </a>
          ページを確認してください。
        </p>
      </section>
    </div>
  );
}
