import type { Metadata } from "next";
import Link from "next/link";
import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchAllMembersResult, filterMembers, paginate, type MemberRow } from "@/lib/admin/data";
import { describeMembersIssue } from "@/lib/admin/stats";
import { PLAN_DEFINITIONS, PLAN_IDS, type Plan } from "@/lib/plans/types";
import { SUBSCRIPTION_STATUS_LABEL } from "@/lib/plans/status-labels";
import { fetchAllGrants } from "@/lib/plans/grant-store";
import { GRANT_SOURCE_LABEL, formatGrantEnd, jstDateAfterDays } from "@/lib/plans/grants";
import { changeMemberStatusAction } from "./actions";

export const metadata: Metadata = {
  title: "会員一覧 | 管理画面",
  robots: { index: false, follow: false },
};

const PAGE_SIZE = 25;

const NOTICE_MESSAGES: Record<string, string> = {
  granted: "会員のステータスを「プレミアム（無料付与）」に変更しました。",
  revoked: "会員のステータスを「無料プラン」に戻しました。",
  invalid_date: "最終日が正しくありません。明日以降の日付を、約3年以内で指定してください。",
  invalid: "入力が正しくありません。もう一度お試しください。",
  failed: "保存できませんでした。しばらくしてから、もう一度お試しください。",
  not_ready: "付与の保存先（データベース）がまだ用意できていません。SQL（0008_premium_grants.sql）を実行してください。",
  forbidden: "この操作は、管理者だけが行えます。",
};

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
  searchParams: Promise<{ q?: string; plan?: string; status?: string; page?: string; notice?: string }>;
}) {
  const access = await checkAdminAccess();
  if (access.status !== "ok") return null;

  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const planFilter = isPlan(params.plan) ? params.plan : undefined;
  const statusFilter = params.status && params.status.length > 0 ? params.status : undefined;
  const page = Number.parseInt(params.page ?? "1", 10) || 1;

  const [{ members: allMembers, profiles: profilesStatus, subscriptions: subscriptionsStatus }, grants] = await Promise.all([
    fetchAllMembersResult(),
    fetchAllGrants(),
  ]);
  const membersIssue = describeMembersIssue(profilesStatus, subscriptionsStatus);
  // 契約情報を全件取得できていないとき、プラン・契約状態は「Free/未契約」と誤って計算されるため、
  // 画面に出さず、それらでの絞り込みも行わない
  const plansReliable = profilesStatus === "ok" && subscriptionsStatus === "ok";
  const filtered = filterMembers(allMembers, {
    query,
    plan: plansReliable ? planFilter : undefined,
    status: plansReliable ? statusFilter : undefined,
  });
  const { items, totalPages, currentPage, totalCount } = paginate<MemberRow>(filtered, page, PAGE_SIZE);

  // ページ番号以外のクエリを保持したままページを切り替えるための土台
  const baseParams = new URLSearchParams();
  if (query) baseParams.set("q", query);
  if (planFilter) baseParams.set("plan", planFilter);
  if (statusFilter) baseParams.set("status", statusFilter);

  return (
    <div className="flex flex-col gap-6">
      {params.notice && NOTICE_MESSAGES[params.notice] && (
        <p
          role="status"
          data-testid="admin-notice"
          className="rounded-lg border border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {NOTICE_MESSAGES[params.notice]}
        </p>
      )}
      {grants.status === "not_ready" && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          無料付与の保存先（データベース）がまだ用意できていません。付与の機能を使うには、SQL（0008_premium_grants.sql）をSupabaseで実行してください。
        </p>
      )}
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">会員一覧</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {profilesStatus === "unavailable"
            ? "会員データを取得できませんでした"
            : profilesStatus === "partial"
              ? `取得できた${allMembers.length.toLocaleString()}件のみを表示しています（全件ではありません）`
              : `全${allMembers.length.toLocaleString()}件中 ${totalCount.toLocaleString()}件が条件に一致`}
        </p>
        {membersIssue && (
          <p className="mt-2 text-sm font-medium text-amber-600 dark:text-amber-400">
            {membersIssue}
            {!plansReliable && profilesStatus !== "unavailable" && "プラン・契約状態の列は「-」と表示し、それらでの絞り込みは無効にしています。"}
          </p>
        )}
      </div>

      <form
        method="GET"
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="q" className="text-xs text-neutral-500 dark:text-neutral-400">
            メールアドレス・ユーザー名で検索
          </label>
          <input
            id="q"
            name="q"
            type="text"
            defaultValue={query}
            placeholder="ユーザー名 または メールアドレス"
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
        <table className="w-full min-w-[1300px] text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">ユーザー名</th>
              <th className="px-4 py-3 font-medium">メールアドレス</th>
              <th className="px-4 py-3 font-medium">プラン</th>
              <th className="px-4 py-3 font-medium">契約状態</th>
              <th className="px-4 py-3 font-medium">契約開始日</th>
              <th className="px-4 py-3 font-medium">次回更新日</th>
              <th className="px-4 py-3 font-medium">登録日</th>
              <th className="px-4 py-3 font-medium">Stripe Customer ID</th>
              <th className="px-4 py-3 font-medium">ユーザーID</th>
              <th className="px-4 py-3 font-medium">ステータス変更（無料付与）</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {items.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100" data-testid="member-username">
                  {m.username ?? <span className="text-neutral-400 dark:text-neutral-500">未設定</span>}
                </td>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">{m.email ?? "-"}</td>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">
                  {plansReliable ? PLAN_DEFINITIONS[m.effectivePlan].name : "-"}
                </td>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100">
                  {!plansReliable
                    ? "-"
                    : m.subscription
                      ? (SUBSCRIPTION_STATUS_LABEL[m.subscription.status] ?? m.subscription.status)
                      : "未契約"}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                  {plansReliable ? formatDate(m.contractStartedAt) : "-"}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                  {plansReliable ? formatDate(m.subscription?.currentPeriodEnd ?? null) : "-"}
                </td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{formatDate(m.registeredAt)}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                  {plansReliable ? (m.stripeCustomerId ?? "-") : "-"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-500 dark:text-neutral-400">{m.id}</td>
                <td className="px-4 py-3 text-neutral-800 dark:text-neutral-100" data-testid="member-grant">
                  <GrantCell
                    userId={m.id}
                    grant={grants.map.get(m.id) ?? null}
                    active={grants.map.get(m.id)?.active ?? false}
                    ready={grants.status === "ok"}
                  />
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-neutral-400 dark:text-neutral-500">
                  {profilesStatus === "unavailable" ? "会員データを取得できませんでした" : "条件に一致する会員がいません"}
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

/** 1人分の「ステータス変更」欄: いまの無料付与の状態と、ステータス（プレミアム／無料）・最終日を指定して変更するフォーム */
function GrantCell({
  userId,
  grant,
  active,
  ready,
}: {
  userId: string;
  grant: { source: "admin" | "trial"; endsAt: string; note: string | null } | null;
  active: boolean;
  ready: boolean;
}) {
  return (
    <div className="flex min-w-[320px] flex-col gap-2">
      {grant && (
        <p className="text-xs">
          {active ? (
            <span className="font-medium text-emerald-700 dark:text-emerald-400">
              {GRANT_SOURCE_LABEL[grant.source]}中（{formatGrantEnd(grant.endsAt)} まで）
            </span>
          ) : (
            <span className="text-neutral-500 dark:text-neutral-400">
              {GRANT_SOURCE_LABEL[grant.source]}は {formatGrantEnd(grant.endsAt)} に終了
            </span>
          )}
          {grant.note ? <span className="ml-1 text-neutral-500 dark:text-neutral-400">（{grant.note}）</span> : null}
        </p>
      )}
      {ready && (
        <form action={changeMemberStatusAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="userId" value={userId} />
          <select
            name="status"
            defaultValue={active ? "premium" : "free"}
            aria-label="変更後のステータス"
            className="rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="premium">プレミアム（無料付与）</option>
            <option value="free">無料プラン</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            最終日
            <input
              type="date"
              name="until"
              defaultValue={grant && active ? grant.endsAt.slice(0, 10) : jstDateAfterDays(30)}
              min={jstDateAfterDays(1)}
              aria-label="プレミアムの最終日（その日の終わりまで）"
              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <input
            type="text"
            name="note"
            maxLength={200}
            placeholder="メモ（任意）"
            aria-label="メモ（任意）"
            className="w-36 rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
          >
            変更する
          </button>
        </form>
      )}
    </div>
  );
}
