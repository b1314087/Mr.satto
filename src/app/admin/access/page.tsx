import type { Metadata } from "next";
import Link from "next/link";
import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchAllMembersResult, fetchSiteVisits } from "@/lib/admin/data";
import { ACCESS_PERIODS, buildAccessBuckets, parseAccessPeriod, sumBuckets } from "@/lib/admin/access-stats";
import { jstDateString } from "@/lib/analytics/visit";
import { StatCard } from "@/components/admin/stat-card";

export const metadata: Metadata = {
  title: "アクセス数 | 管理画面",
  robots: { index: false, follow: false },
};

const NUMBER = new Intl.NumberFormat("ja-JP");
const show = (v: number | null) => (v === null ? "-" : NUMBER.format(v));

export default async function AdminAccessPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const access = await checkAdminAccess();
  if (access.status !== "ok") return null;

  const { period: periodParam } = await searchParams;
  const period = parseAccessPeriod(periodParam);
  const periodInfo = ACCESS_PERIODS.find((p) => p.id === period)!;

  const [visits, members] = await Promise.all([fetchSiteVisits(), fetchAllMembersResult()]);
  const today = jstDateString(new Date());
  // 取得できなかった（一部しか取れなかった）値は、0として出さない
  const visitsReliable = visits.status === "ok";
  const registeredAt = members.profiles === "ok" ? members.members.map((m) => m.registeredAt) : null;
  const buckets = buildAccessBuckets({ period, today, visits: visitsReliable ? visits.rows : [], registeredAt });
  const maxVisitors = Math.max(1, ...buckets.map((b) => b.visitors ?? 0));
  const hasAny = visitsReliable && visits.rows.length > 0;
  const firstDate = hasAny ? visits.rows.reduce((min, r) => (r.date < min ? r.date : min), visits.rows[0].date) : null;

  // 上のカード（日・週・月・年の、今日を含む期間）
  const latest = Object.fromEntries(
    ACCESS_PERIODS.map((p) => {
      const b = buildAccessBuckets({ period: p.id, today, visits: visitsReliable ? visits.rows : [], registeredAt });
      return [p.id, b[b.length - 1]];
    }),
  ) as Record<(typeof ACCESS_PERIODS)[number]["id"], (typeof buckets)[number]>;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">アクセス数</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
          サイトを開いた人数（訪問者数）と、ページを開いた回数（閲覧数）です。日付は日本時間です。
          個人は特定せず、同じ人が同じ日に何回来ても1人と数えます。週・月・年の訪問者数は、日ごとの人数の合計（延べ人数）です。
          ボット・管理画面・「トラッキングしない」設定のブラウザ・運営者のアカウントでログイン中のアクセスは数えません。
        </p>
        {visits.status === "unavailable" && (
          <p className="mt-2 max-w-2xl text-sm font-medium text-amber-600 dark:text-amber-400" data-testid="access-unavailable">
            アクセス数のデータを取得できませんでした（データベースの設定（SQL）がまだ適用されていないか、接続設定を確認してください）。0人という意味ではありません。
          </p>
        )}
        {visits.status === "partial" && (
          <p className="mt-2 max-w-2xl text-sm font-medium text-amber-600 dark:text-amber-400">
            データの一部しか取得できなかったため、正しい数値を表示していません。
          </p>
        )}
        {visitsReliable && !hasAny && (
          <p className="mt-2 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400" data-testid="access-empty">
            まだ記録がありません。サイトが開かれると、その日から記録が始まります。
          </p>
        )}
        {firstDate && (
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">記録の開始日: {firstDate}（それより前の期間は「-」と表示します）</p>
        )}
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-testid="access-cards">
        <StatCard label="今日の訪問者数" value={show(latest.day.visitors)} note={`閲覧数 ${show(latest.day.pageviews)}`} />
        <StatCard label="今週の訪問者数" value={show(latest.week.visitors)} note={`閲覧数 ${show(latest.week.pageviews)}（月曜から）`} />
        <StatCard label="今月の訪問者数" value={show(latest.month.visitors)} note={`閲覧数 ${show(latest.month.pageviews)}`} />
        <StatCard label="今年の訪問者数" value={show(latest.year.visitors)} note={`閲覧数 ${show(latest.year.pageviews)}`} />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="集計の単位">
          {ACCESS_PERIODS.map((p) => (
            <Link
              key={p.id}
              href={`/admin/access?period=${p.id}`}
              role="tab"
              aria-selected={p.id === period}
              data-testid={`access-period-${p.id}`}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                p.id === period
                  ? "border-blue-600 bg-blue-600 text-white"
                  : "border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              }`}
            >
              {p.label}
            </Link>
          ))}
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            直近{periodInfo.count}
            {periodInfo.unit}
          </span>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full min-w-[640px] text-left text-sm" data-testid="access-table">
            <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-3 font-medium">期間</th>
                <th className="px-4 py-3 font-medium">訪問者数</th>
                <th className="px-4 py-3 font-medium" aria-hidden="true"></th>
                <th className="px-4 py-3 font-medium">閲覧数</th>
                <th className="px-4 py-3 font-medium">新規会員登録</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {[...buckets].reverse().map((b) => (
                <tr key={b.start} data-testid="access-row">
                  <td className="px-4 py-2.5 text-neutral-800 dark:text-neutral-100">{b.label}</td>
                  <td className="px-4 py-2.5 font-medium text-neutral-900 dark:text-white">{show(b.visitors)}</td>
                  <td className="w-1/3 px-4 py-2.5" aria-hidden="true">
                    {b.visitors !== null && (
                      <div className="h-2 rounded-full bg-neutral-100 dark:bg-neutral-800">
                        <div className="h-2 rounded-full bg-blue-500" style={{ width: `${Math.round((b.visitors / maxVisitors) * 100)}%` }} />
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-neutral-600 dark:text-neutral-300">{show(b.pageviews)}</td>
                  <td className="px-4 py-2.5 text-neutral-600 dark:text-neutral-300">{show(b.registrations)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <tr>
                <td className="px-4 py-2.5">表示期間の合計</td>
                <td className="px-4 py-2.5">{show(sumBuckets(buckets, "visitors"))}</td>
                <td></td>
                <td className="px-4 py-2.5">{show(sumBuckets(buckets, "pageviews"))}</td>
                <td className="px-4 py-2.5">{show(sumBuckets(buckets, "registrations"))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          「新規会員登録」は、会員データの登録日から数えています（アクセス数の記録とは別です）。
        </p>
      </section>
    </div>
  );
}
