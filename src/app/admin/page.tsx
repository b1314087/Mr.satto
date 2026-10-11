import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchAllMembersResult, fetchToolUsageSummary } from "@/lib/admin/data";
import { buildDashboardStatsView, describeMembersIssue, formatStatValue, formatUsageCount } from "@/lib/admin/stats";
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

  const [membersResult, usage] = await Promise.all([fetchAllMembersResult(), fetchToolUsageSummary()]);
  // 取得に失敗した値は「0」ではなく「取得できません」と表示する（stats.ts参照）
  const stats = buildDashboardStatsView(membersResult.members, membersResult.profiles, membersResult.subscriptions);
  const membersIssue = describeMembersIssue(membersResult.profiles, membersResult.subscriptions);

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
        {membersIssue && (
          <p className="mb-3 text-sm font-medium text-amber-600 dark:text-amber-400">{membersIssue}</p>
        )}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard label="総ユーザー数" value={formatStatValue(stats.totalUsers)} />
          <StatCard label="Freeユーザー数" value={formatStatValue(stats.freeUsers)} />
          <StatCard label="現在の有料会員数" value={formatStatValue(stats.payingUsers)} />
          <StatCard label="Standardユーザー数" value={formatStatValue(stats.standardUsers)} />
          <StatCard label="Premiumユーザー数" value={formatStatValue(stats.premiumUsers)} />
          <StatCard
            label="月間売上の目安(MRR)"
            value={formatStatValue(stats.estimatedMonthlyRevenueYen, "円")}
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
            value={formatUsageCount(usage.status, usage.todayTotal)}
          />
          <StatCard
            label="今月の利用回数（過去ログ）"
            value={formatUsageCount(usage.status, usage.monthTotal)}
          />
        </div>
        <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          {usage.status === "ok"
            ? "Mr.Sattoのツールはブラウザ内で処理が完結する設計のため、現在ツールの利用回数は新たに記録していません。ここに表示されるのは、過去に記録された利用ログの集計のみで、サイト全体の利用回数ではありません。"
            : usage.status === "partial"
              ? "利用ログの一部しか取得できなかったため、正しい回数を表示していません。"
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
