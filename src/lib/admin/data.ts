import "server-only";

import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { resolveEffectivePlan, type SubscriptionSnapshot } from "@/lib/plans/current-plan";
import { PLAN_DEFINITIONS, type Plan } from "@/lib/plans/types";
import { tools } from "@/lib/tools/data";

/**
 * 管理画面(/admin)専用のデータ取得層。
 *
 * 全会員を横断的に読む必要があるため、通常のRLS前提クライアント
 * （src/lib/supabase/server.ts、「自分の行だけ」しか読めない）ではなく、
 * Service Role Key を使うクライアント（src/lib/supabase/service.ts）を使う。
 * これはStripe Webhookハンドラ専用だったクライアントの、2つ目の正式な
 * 用途として追加する（新しいSupabaseクライアントの仕組みは作らない）。
 *
 * 重要：この層の関数は、呼び出し側が checkAdminAccess()（src/lib/admin/auth.ts）
 * で管理者と確認した後にのみ呼び出すこと。この層自体は管理者判定を行わない
 * （判定と取得の責務を分離する）。
 *
 * 会員一覧はDBの結合(JOIN)や新しいVIEWを追加せず、profiles と subscriptions を
 * それぞれ取得してアプリケーション側でuser_idをキーに結合する。現状の会員規模
 * であれば十分な性能であり、「不要なDBオブジェクトを追加しない」という
 * 指示書の方針を優先した。将来、会員数が大きく増えた場合はDB側の集計・JOINへの
 * 切り替えを検討すること。
 */

export interface MemberRow {
  id: string;
  email: string | null;
  /** profiles.created_at（会員登録日） */
  registeredAt: string;
  /** 実効プラン（実際にツール利用へ反映されるプラン。resolveEffectivePlan()で算出） */
  effectivePlan: Plan;
  /** Stripe契約のスナップショット（契約したことが一度もない場合はnull） */
  subscription: SubscriptionSnapshot | null;
  stripeCustomerId: string | null;
  /** subscriptions行のcreated_at（＝Stripe Customer/契約が最初に紐付いた日。契約開始日の目安） */
  contractStartedAt: string | null;
}

interface RawProfileRow {
  id: string;
  email: string | null;
  created_at: string;
}

interface RawSubscriptionRow {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string | null;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
}

async function fetchAllProfiles(): Promise<RawProfileRow[]> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, created_at")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as RawProfileRow[];
}

async function fetchAllSubscriptions(): Promise<Map<string, RawSubscriptionRow>> {
  const map = new Map<string, RawSubscriptionRow>();
  const supabase = getSupabaseServiceClient();
  if (!supabase) return map;
  const { data, error } = await supabase
    .from("subscriptions")
    .select(
      "user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, cancel_at_period_end, created_at"
    );
  if (error || !data) return map;
  for (const row of data as RawSubscriptionRow[]) {
    map.set(row.user_id, row);
  }
  return map;
}

function toSnapshot(row: RawSubscriptionRow | undefined): SubscriptionSnapshot | null {
  if (!row || !row.plan || !row.status) return null;
  return {
    plan: row.plan as Exclude<Plan, "free">,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
  };
}

/** 全会員を取得する（profiles × subscriptions をアプリ側で結合）。管理者判定後にのみ呼ぶこと。 */
export async function fetchAllMembers(): Promise<MemberRow[]> {
  const [profiles, subsMap] = await Promise.all([fetchAllProfiles(), fetchAllSubscriptions()]);
  return profiles.map((profile) => {
    const raw = subsMap.get(profile.id);
    const subscription = toSnapshot(raw);
    return {
      id: profile.id,
      email: profile.email,
      registeredAt: profile.created_at,
      effectivePlan: resolveEffectivePlan(subscription),
      subscription,
      stripeCustomerId: raw?.stripe_customer_id ?? null,
      contractStartedAt: raw?.created_at ?? null,
    };
  });
}

export interface MemberListFilter {
  /** メールアドレスの部分一致検索（大文字小文字を区別しない） */
  query?: string;
  plan?: Plan;
  /** 契約状態の生ステータス（"none" = 契約したことがない） */
  status?: string;
}

export function filterMembers(members: MemberRow[], filter: MemberListFilter): MemberRow[] {
  return members.filter((m) => {
    if (filter.query) {
      const q = filter.query.trim().toLowerCase();
      if (q.length > 0 && !(m.email ?? "").toLowerCase().includes(q)) return false;
    }
    if (filter.plan && m.effectivePlan !== filter.plan) return false;
    if (filter.status) {
      const status = m.subscription?.status ?? "none";
      if (status !== filter.status) return false;
    }
    return true;
  });
}

export interface PaginatedResult<T> {
  items: T[];
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): PaginatedResult<T> {
  const totalCount = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), totalPages, currentPage, totalCount };
}

/** ダッシュボードのKPI集計 */
export interface AdminDashboardStats {
  totalUsers: number;
  freeUsers: number;
  /** 現在アクティブなStandard契約者数（解約済み等は含まない） */
  standardUsers: number;
  /** 現在アクティブなPremium契約者数（解約済み等は含まない） */
  premiumUsers: number;
  /** 現在の有料会員数（standard + premium） */
  payingUsers: number;
  /**
   * 現在有効な契約 × 各プラン単価から算出する、見込みの月間経常収益(MRR)。
   * Stripeへ実際に入金された金額（日割り・クーポン・決済手数料・失敗分等を
   * 反映した実績値）ではない点に注意。実績の売上額はコード側では保持しておらず
   * （推測値を表示しない、という指示書の方針により、ここでは表示しない）、
   * 必要であればStripeダッシュボードのレポートを正とする。
   */
  estimatedMonthlyRevenueYen: number;
}

export function computeDashboardStats(members: MemberRow[]): AdminDashboardStats {
  const totalUsers = members.length;
  let standardUsers = 0;
  let premiumUsers = 0;
  for (const m of members) {
    if (m.effectivePlan === "standard") standardUsers += 1;
    if (m.effectivePlan === "premium") premiumUsers += 1;
  }
  const payingUsers = standardUsers + premiumUsers;
  const freeUsers = totalUsers - payingUsers;
  const estimatedMonthlyRevenueYen =
    standardUsers * PLAN_DEFINITIONS.standard.priceYen + premiumUsers * PLAN_DEFINITIONS.premium.priceYen;
  return { totalUsers, freeUsers, standardUsers, premiumUsers, payingUsers, estimatedMonthlyRevenueYen };
}

// ============================================================
// ツール利用状況（tool_usage_daily）
// ============================================================
//
// 重要な制約：tool_usage_daily（supabase/migrations/0002_tool_usage_daily.sql）は
// Mr.Satto全体のアクセスログではない。「記入済みPDF→Excel」1ツールの
// Standardプラン向け「1日10回まで」制限を数えるためだけに使われている
// （src/lib/tools/filled-pdf-to-excel/daily-usage.ts）。他の97ツールは
// ブラウザ内完結・サーバー非送信という設計方針そのものにより、利用回数を
// サーバー側で記録していない。そのため、ここで表示できるのは
// 「利用ログが存在するツールの利用回数」のみであり、サイト全体のツール
// 利用回数ではない。推測値で埋めることはしない。

interface RawUsageRow {
  tool_id: string;
  usage_date: string;
  count: number;
}

export interface ToolUsageRow {
  toolId: string;
  /** src/lib/tools/data.ts に登録されているツール名（見つからない場合はtoolIdをそのまま表示） */
  toolName: string;
  todayCount: number;
  monthCount: number;
}

export interface DailyUsagePoint {
  date: string;
  count: number;
}

export interface ToolUsageSummary {
  todayTotal: number;
  monthTotal: number;
  byTool: ToolUsageRow[];
  dailyThisMonth: DailyUsagePoint[];
}

function todayInTokyo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
}

function monthStartInTokyo(): string {
  const today = todayInTokyo();
  return `${today.slice(0, 7)}-01`;
}

function getToolName(toolId: string): string {
  return tools.find((t) => t.id === toolId)?.name ?? toolId;
}

const EMPTY_USAGE_SUMMARY: ToolUsageSummary = { todayTotal: 0, monthTotal: 0, byTool: [], dailyThisMonth: [] };

/** 今月分（Asia/Tokyo基準）のツール利用ログを集計する。管理者判定後にのみ呼ぶこと。 */
export async function fetchToolUsageSummary(): Promise<ToolUsageSummary> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return EMPTY_USAGE_SUMMARY;

  const today = todayInTokyo();
  const monthStart = monthStartInTokyo();

  const { data, error } = await supabase
    .from("tool_usage_daily")
    .select("tool_id, usage_date, count")
    .gte("usage_date", monthStart)
    .order("usage_date", { ascending: true });

  if (error || !data) return EMPTY_USAGE_SUMMARY;

  const rows = data as RawUsageRow[];
  let todayTotal = 0;
  let monthTotal = 0;
  const byToolMap = new Map<string, { today: number; month: number }>();
  const dailyMap = new Map<string, number>();

  for (const row of rows) {
    monthTotal += row.count;
    dailyMap.set(row.usage_date, (dailyMap.get(row.usage_date) ?? 0) + row.count);

    const bucket = byToolMap.get(row.tool_id) ?? { today: 0, month: 0 };
    bucket.month += row.count;
    if (row.usage_date === today) {
      bucket.today += row.count;
      todayTotal += row.count;
    }
    byToolMap.set(row.tool_id, bucket);
  }

  const byTool: ToolUsageRow[] = Array.from(byToolMap.entries())
    .map(([toolId, v]) => ({ toolId, toolName: getToolName(toolId), todayCount: v.today, monthCount: v.month }))
    .sort((a, b) => b.monthCount - a.monthCount);

  const dailyThisMonth: DailyUsagePoint[] = Array.from(dailyMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { todayTotal, monthTotal, byTool, dailyThisMonth };
}
