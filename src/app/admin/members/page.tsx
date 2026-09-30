import type { Metadata } from "next";
import Link from "next/link";
import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchAllMembers, filterMembers, paginate, type MemberRow } from "@/lib/admin/data";
import { PLAN_DEFINITIONS, PLAN_IDS, type Plan } from "@/lib/plans/types";
import { SUBSCRIPTION_STATUS_LABEL } from "@/lib/plans/status-labels";

export const metadata: Metadata = {
  title: "会員一覧 | 管理画面",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 25;

const STATUS_FILTER_OPTIONS = [
  { value: "none", label: "未契約" },
  ...Object.entries(SUBSCRIPTION_STATUS_LABEL).map(([value, label]) => ({ value, label })),
];

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium" }).format(new Date(iso));
}

function isPlan(value: string | undefined): value is Plan {
  return value === "free" || value === "standard" || value === "premium";
}

function buildPageHref(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params);
  next.set("page", String(page));
  return `/admin/members?${next.toString()}`;
}

export default async function AdminMembersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; plan?: string; status?: string; page?: string }>;
}) {
  const access = await checkAdminAccess();
  if (access.status !== "ok") return null;

  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const planFilter = isPlan(params.plan) ? params.plan : undefined;
  const statusFilter = params.status && params.status.length > 0 ? params.status : undefined;
  const page = Number.parseInt(params.page ?? "1", 10) || 1;

  const allMembers = await fetchAllMembers();
  const filtered = filterMembers(allMembers, { query, plan: planFilter, status: statusFilter });
  const { items, totalPages, currentPage, totalCount } = paginate<MemberRow>(filtered, page, PAGE_SIZE);

  // ページ番号以外のクエリを保持したままページを切り替えるための土台
  const baseParams = new URLSearchParams();
  if (query) baseParams.set("q", query);
  if (planFilter) baseParams.set("plan", planFilter);
  if (statusFilter) baseParams.set("status", statusFilter);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">会員一覧</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          全{allMembers.length.toLocaleString()}件中 {totalCount.toLocaleString()}件が条件に一致
        </p>
      </div>

      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="q" className="text-xs text-neutral-500 dark:text-neutral-400">
            メールアドレス検索
          </label>
          <input
            id="q"
            name="q"
            type="text"
            defaultValue={query}
            placeholder="example@example.com"
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="plan" className="text-xs text-neutral-500 dark:text-neutral-400">
            プラン
          </label>
          <select
            id="plan"
            name="plan"
            defaultValue={planFilter ?? ""}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">すべて</option>
            {PLAN_IDS.map((id) => (
              <option key={id} value={id}>
                {PLAN_DEFINITIONS[id].name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="status" className="text-xs text-neutral-500 dark:text-neutral-400">
            契約状態
          </label>
          <select
            id="status"
            name="status"
            defaultValue={statusFilter ?? ""}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">すべて</option>
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          絞り込む
        </button>
        {(query || planFilter || statusFilter) && (
          <Link
            href="/admin/members"
            className="text-sm text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
          >
            条件をクリア
          </Link>
        )}
      </form>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">メールアドレス</th>
              <th className="px-4 py-3 font-medium">プラン</th>
              <th className="px-4 py-3 font-medium">契約状態</th>
              <th className="px-4 py-3 font-medium">契約開始日</th>
              <th className="px-4 py-3 font-medium">次回更新日</th>
              <th className="px-4 py-3 font-medium">登録日</th>
              <th className="px-4 py-3 font-medium">Stripe Customer ID</th>
              <th className="px-4 py-3 font-medium">ユーザーID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {items.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">{m.email ?? "-"}</td>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">
                  {PLAN_DEFINITIONS[m.effectivePlan].name}
                </td>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">
                  {m.subscription ? (SUBSCRIPTION_STATUS_LABEL[m.subscription.status] ?? m.subscription.status) : "未契約"}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                  {formatDate(m.contractStartedAt)}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                  {formatDate(m.subscription?.currentPeriodEnd ?? null)}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{formatDate(m.registeredAt)}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                  {m.stripeCustomerId ?? "-"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-500 dark:text-neutral-400">{m.id}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                  条件に一致する会員がいません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
          <Link
            href={buildPageHref(baseParams, Math.max(1, currentPage - 1))}
            aria-disabled={currentPage <= 1}
            className={`rounded-lg border border-neutral-300 px-3 py-1.5 dark:border-neutral-700 ${
              currentPage <= 1 ? "pointer-events-none opacity-40" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            前へ
          </Link>
          <span className="text-neutral-500 dark:text-neutral-400">
            {currentPage} / {totalPages}
          </span>
          <Link
            href={buildPageHref(baseParams, Math.min(totalPages, currentPage + 1))}
            aria-disabled={currentPage >= totalPages}
            className={`rounded-lg border border-neutral-300 px-3 py-1.5 dark:border-neutral-700 ${
              currentPage >= totalPages ? "pointer-events-none opacity-40" : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            次へ
          </Link>
        </div>
      )}
    </div>
  );
}
