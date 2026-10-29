import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { checkAdminAccess } from "@/lib/admin/auth";
import { fetchMemberById } from "@/lib/admin/data";
import { MEMBER_NOTICE_MESSAGES, isMemberId } from "@/lib/admin/member-links";
import { MemberStatusForm } from "@/components/admin/member-status-form";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { SUBSCRIPTION_STATUS_LABEL } from "@/lib/plans/status-labels";
import { fetchGrantFor, fetchTrialClaimedAt } from "@/lib/plans/grant-store";
import { GRANT_SOURCE_LABEL, applyActiveGrantToPlan, formatGrantEnd } from "@/lib/plans/grants";

export const metadata: Metadata = {
  title: "会員の詳細 | 管理画面",
  robots: { index: false, follow: false },
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeZone: "Asia/Tokyo" }).format(d);
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(d);
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section
      data-testid={testId}
      className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h2 className="mb-3 text-base font-semibold text-neutral-900 dark:text-white">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: { label: string; value: ReactNode; mono?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[11rem_1fr]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-neutral-500 dark:text-neutral-400">{row.label}</dt>
          <dd className={`break-all text-neutral-800 dark:text-neutral-100 ${row.mono ? "font-mono text-xs" : ""}`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BackLink() {
  return (
    <Link href="/admin/members" className="text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
      ← 会員一覧へ戻る
    </Link>
  );
}

export default async function AdminMemberDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const access = await checkAdminAccess();
  if (access.status !== "ok") return null;

  const { id } = await params;
  const { notice } = await searchParams;

  if (!isMemberId(id)) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p data-testid="member-not-found" className="text-sm text-neutral-600 dark:text-neutral-300">
          会員が見つかりません（ユーザーIDの形が正しくありません）。
        </p>
      </div>
    );
  }

  const userId = id.toLowerCase();
  const [result, grantResult, trialClaimedAt] = await Promise.all([
    fetchMemberById(userId),
    fetchGrantFor(userId),
    fetchTrialClaimedAt(userId),
  ]);

  if (result.status !== "ok") {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <p data-testid="member-not-found" className="text-sm text-neutral-600 dark:text-neutral-300">
          {result.status === "not_found" ? "会員が見つかりません。" : "会員データを取得できませんでした。しばらくしてから、もう一度お試しください。"}
        </p>
      </div>
    );
  }

  const member = result.member;
  const grant = grantResult.grant;
  const plan = applyActiveGrantToPlan(member.effectivePlan, grant?.active ?? false);
  const subscription = member.subscription;

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      {notice && MEMBER_NOTICE_MESSAGES[notice] && (
        <p
          role="status"
          data-testid="admin-notice"
          className="rounded-lg border border-neutral-300 bg-white px-4 py-3 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {MEMBER_NOTICE_MESSAGES[notice]}
        </p>
      )}

      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white" data-testid="member-detail-title">
          {member.username ?? "ユーザー名未設定"}
        </h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{member.email ?? "-"}</p>
      </div>

      <Section title="基本情報" testId="member-section-basic">
        <Rows
          rows={[
            { label: "ユーザー名", value: member.username ?? "未設定" },
            { label: "メールアドレス", value: member.email ?? "-" },
            { label: "登録日", value: formatDate(member.registeredAt) },
            { label: "ユーザーID", value: member.id, mono: true },
          ]}
        />
      </Section>

      <Section title="プランと契約" testId="member-section-contract">
        <Rows
          rows={[
            { label: "プラン", value: PLAN_DEFINITIONS[plan].name },
            {
              label: "契約状況",
              value: subscription ? (SUBSCRIPTION_STATUS_LABEL[subscription.status] ?? subscription.status) : "未契約",
            },
            { label: "契約開始日", value: formatDate(member.contractStartedAt) },
            { label: "次回更新日", value: formatDate(subscription?.currentPeriodEnd ?? null) },
            {
              label: "解約の予約",
              value: subscription ? (subscription.cancelAtPeriodEnd ? "あり（期間の終わりに解約）" : "なし") : "-",
            },
            { label: "Stripe Customer ID", value: member.stripeCustomerId ?? "-", mono: true },
            { label: "Stripe Subscription ID", value: member.stripeSubscriptionId ?? "-", mono: true },
          ]}
        />
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          有料の契約（支払い）の変更・解約・返金は、Stripeの管理画面で行います。この画面の「ステータス変更」は、Stripeの契約には影響しません。
        </p>
      </Section>

      <Section title="ステータス変更（無料付与）" testId="member-section-grant">
        {grantResult.status === "not_ready" && (
          <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            無料付与の保存先（データベース）がまだ用意できていません。SQL（0008_premium_grants.sql）をSupabaseで実行してください。
          </p>
        )}
        {grantResult.status === "unavailable" && (
          <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">無料付与の情報を取得できませんでした。</p>
        )}
        <Rows
          rows={[
            {
              label: "いまの状態",
              value: grant ? (
                grant.active ? (
                  <span className="font-medium text-emerald-700 dark:text-emerald-400">
                    {GRANT_SOURCE_LABEL[grant.source]}中（{formatGrantEnd(grant.endsAt)} まで）
                  </span>
                ) : (
                  `${GRANT_SOURCE_LABEL[grant.source]}は ${formatGrantEnd(grant.endsAt)} に終了`
                )
              ) : (
                "無料付与なし"
              ),
            },
            { label: "付与の開始", value: grant ? formatDateTime(grant.startsAt) : "-" },
            { label: "メモ", value: grant?.note ?? "-" },
            {
              label: "無料お試し",
              value: trialClaimedAt === "unknown" ? "確認できません" : trialClaimedAt ? `使用済み（${formatDateTime(trialClaimedAt)}）` : "未使用",
            },
          ]}
        />
        {grantResult.status === "ok" && (
          <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <MemberStatusForm userId={member.id} grantEndsAt={grant?.endsAt ?? null} active={grant?.active ?? false} returnTo="detail" withNote />
          </div>
        )}
      </Section>
    </div>
  );
}
