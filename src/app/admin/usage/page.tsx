import type { Metadata } from "next";
import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchToolUsageSummary } from "@/lib/admin/data";
import { StatCard } from "@/components/admin/stat-card";
import { formatUsageCount } from "@/lib/admin/stats";

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
  // 取得状態がok以外のときは、不完全な集計を表に出さない
  const byTool = usage.status === "ok" ? usage.byTool : [];
  const dailyThisMonth = usage.status === "ok" ? usage.dailyThisMonth : [];
  const maxDailyCount = Math.max(1, ...dailyThisMonth.map((d) => d.count));

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">利用状況</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          Mr.Sattoの通常のツールはブラウザ内で処理が完結し、ファイルの内容やツールの実行結果はサーバーへ送信されません（同意のうえで実行するAIの読み取りを除きます）。
          現在、ツールの利用回数は新たに記録していません。ここに表示されるのは、過去に記録された利用ログ
          （かつて「記入済みPDF→Excel」のStandardプラン向け1日あたり利用制限を管理していた際のログ）の集計のみで、
          サイト全体の利用回数ではありません。
        </p>
        {usage.status !== "ok" && (
          <p className="mt-2 max-w-2xl text-sm font-medium text-amber-600 dark:text-amber-400">
            {usage.status === "partial"
              ? "利用ログの一部しか取得できませんでした。正しい回数を表示できないため、数値は表示していません。"
              : "利用ログのデータを取得できませんでした（Supabaseの接続設定を確認してください）。下の数値は「0回」という意味ではなく、未取得です。"}
          </p>
        )}
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard
          label="今日の利用回数（過去ログ）"
          value={formatUsageCount(usage.status, usage.todayTotal)}
        />
        <StatCard
          label="今月の利用回数（過去ログ）"
          value={formatUsageCount(usage.status, usage.monthTotal)}
        />
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
              {byTool.map((row) => (
                <tr key={row.toolId}>
                  <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">{row.toolName}</td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{row.todayCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{row.monthCount.toLocaleString()}</td>
                </tr>
              ))}
              {byTool.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                    {usage.status === "ok" ? "今月の利用ログはありません" : "利用ログを正しく取得できませんでした"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-500 dark:text-neutral-400">日別の利用回数（今月）</h2>
        {dailyThisMonth.length === 0 ? (
          <p className="text-sm text-neutral-400 dark:text-neutral-500">
            {usage.status === "ok" ? "今月の利用ログはありません" : "利用ログを正しく取得できませんでした"}
          </p>
        ) : (
          <div className="flex items-end gap-1.5 overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            {dailyThisMonth.map((day) => (
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
