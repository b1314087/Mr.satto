import type { Metadata } from "next";
import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchToolUsageSummary } from "@/lib/admin/data";
import { StatCard } from "@/components/admin/stat-card";

export const metadata: Metadata = {
  title: "利用状況 | 管理画面",
  robots: { index: false, follow: false },
};

function formatDay(iso: string): string {
  // iso は "YYYY-MM-DD"（Asia/Tokyo基準の日付文字列。src/lib/admin/data.ts参照）
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export default async function AdminUsagePage() {
  const access = await checkAdminAccess();
  if (access.status !== "ok") return null;

  const usage = await fetchToolUsageSummary();
  const maxDailyCount = Math.max(1, ...usage.dailyThisMonth.map((d) => d.count));

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">利用状況</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          Mr.Sattoのツールはブラウザ内で処理が完結し、ファイルの内容やツールの実行結果はサーバーへ送信されません。
          そのため、ここで確認できるのは「利用回数を記録しているツール」のログのみです（現時点では
          Standardプランの1日あたり利用制限を管理するため、「記入済みPDF→Excel」のみが対象です）。
          他のツールの利用回数は、設計上サーバー側に存在しないため表示していません。
        </p>
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="今日の利用回数" value={usage.todayTotal.toLocaleString()} />
        <StatCard label="今月の利用回数" value={usage.monthTotal.toLocaleString()} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-500 dark:text-neutral-400">ツール別利用回数（今月）</h2>
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3 font-medium">ツール</th>
                <th className="px-4 py-3 font-medium">今日</th>
                <th className="px-4 py-3 font-medium">今月</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {usage.byTool.map((row) => (
                <tr key={row.toolId}>
                  <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">{row.toolName}</td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{row.todayCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{row.monthCount.toLocaleString()}</td>
                </tr>
              ))}
              {usage.byTool.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    今月の利用ログはまだありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-500 dark:text-neutral-400">日別の利用回数（今月）</h2>
        {usage.dailyThisMonth.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">今月の利用ログはまだありません</p>
        ) : (
          <div className="flex items-end gap-1.5 overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            {usage.dailyThisMonth.map((day) => (
              <div key={day.date} className="flex min-w-[28px] flex-col items-center gap-1">
                <div
                  className="w-4 rounded-t bg-blue-500/70 dark:bg-blue-500/60"
                  style={{ height: `${Math.max(4, (day.count / maxDailyCount) * 96)}px` }}
                  title={`${day.date}: ${day.count}回`}
                />
                <span className="text-[10px] text-neutral-400 dark:text-neutral-500">{formatDay(day.date)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
