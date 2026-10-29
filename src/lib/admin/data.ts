import "server-only";

import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { resolveEffectivePlan, type SubscriptionSnapshot } from "@/lib/plans/current-plan";
import { type Plan } from "@/lib/plans/types";
import { classifyQuery, computeDashboardStats, type AdminDashboardStats, type DataStatus } from "./stats";
import { tools } from "@/lib/tools/data";
import { matchesMemberQuery } from "./member-search";

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
  /** ユーザー名（登録時または後から設定。未設定の会員は null） */
  username: string | null;
  /** profiles.created_at（会員登録日） */
  registeredAt: string;
  /** 実効プラン（実際にツール利用へ反映されるプラン。resolveEffectivePlan()で算出） */
  effectivePlan: Plan;
  /** Stripe契約のスナップショット（契約したことが一度もない場合はnull） */
  subscription: SubscriptionSnapshot | null;
  stripeCustomerId: string | null;
  /** Stripe の契約ID（詳細ページで表示する。契約したことがなければ null） */
  stripeSubscriptionId: string | null;
  /** subscriptions行のcreated_at（＝Stripe Customer/契約が最初に紐付いた日。契約開始日の目安） */
  contractStartedAt: string | null;
}

interface RawProfileRow {
  id: string;
  email: string | null;
  username?: string | null;
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

async function fetchAllProfiles(): Promise<{ rows: RawProfileRow[]; status: DataStatus }> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { rows: [], status: "unavailable" };
  const withUsername = await supabase
    .from("profiles")
    .select("id, email, username, created_at", { count: "exact" })
    .order("created_at", { ascending: false });
  if (!withUsername.error) {
    return classifyQuery<RawProfileRow>({ data: withUsername.data as RawProfileRow[] | null, error: null, count: withUsername.count });
  }
  // ユーザー名の列を追加するSQL（0006）が、まだ適用されていない場合: ユーザー名なしで取得し直す（会員一覧を使えなくしない）
  const result = await supabase
    .from("profiles")
    .select("id, email, created_at", { count: "exact" })
    .order("created_at", { ascending: false });
  return classifyQuery<RawProfileRow>({ data: result.data as RawProfileRow[] | null, error: result.error, count: result.count });
}

async function fetchAllSubscriptions(): Promise<{ map: Map<string, RawSubscriptionRow>; status: DataStatus }> {
  const map = new Map<string, RawSubscriptionRow>();
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { map, status: "unavailable" };
  const result = await supabase
    .from("subscriptions")
    .select(
      "user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, cancel_at_period_end, created_at",
      { count: "exact" }
    );
  const { rows, status } = classifyQuery<RawSubscriptionRow>({
    data: result.data as RawSubscriptionRow[] | null,
    error: result.error,
    count: result.count,
  });
  for (const row of rows) map.set(row.user_id, row);
  return { map, status };
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

export interface MembersFetchResult {
  members: MemberRow[];
  /** 会員(profiles)の取得状態。unavailableのとき members は空だが、会員が0人という意味ではない */
  profiles: DataStatus;
  /**
   * 契約(subscriptions)の取得状態。ok以外のとき、members の effectivePlan / subscription は
   * 「契約情報なし＝Free」として計算された不正確な値なので、画面に出してはいけない。
   */
  subscriptions: DataStatus;
}

/** 全会員を取得する（profiles × subscriptions をアプリ側で結合）。管理者判定後にのみ呼ぶこと。 */
export async function fetchAllMembersResult(): Promise<MembersFetchResult> {
  const [profiles, subs] = await Promise.all([fetchAllProfiles(), fetchAllSubscriptions()]);
  const members = profiles.rows.map((profile) => {
    const raw = subs.map.get(profile.id);
    const subscription = toSnapshot(raw);
    return {
      id: profile.id,
      email: profile.email,
      username: profile.username ?? null,
      registeredAt: profile.created_at,
      effectivePlan: resolveEffectivePlan(subscription),
      subscription,
      stripeCustomerId: raw?.stripe_customer_id ?? null,
      stripeSubscriptionId: raw?.stripe_subscription_id ?? null,
      contractStartedAt: raw?.created_at ?? null,
    };
  });
  return { members, profiles: profiles.status, subscriptions: subs.status };
}

export type MemberDetailResult =
  | { status: "ok"; member: MemberRow }
  | { status: "not_found" }
  | { status: "unavailable" };

/** 会員1人分の情報を取得する（詳細ページ用）。管理者判定後にのみ呼ぶこと。 */
export async function fetchMemberById(userId: string): Promise<MemberDetailResult> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { status: "unavailable" };

  let profile: RawProfileRow | null = null;
  const withUsername = await supabase.from("profiles").select("id, email, username, created_at").eq("id", userId).maybeSingle();
  if (!withUsername.error) {
    profile = withUsername.data as RawProfileRow | null;
  } else {
    // ユーザー名の列を追加するSQL（0006）が未適用のとき: ユーザー名なしで取得し直す
    const fallback = await supabase.from("profiles").select("id, email, created_at").eq("id", userId).maybeSingle();
    if (fallback.error) return { status: "unavailable" };
    profile = fallback.data as RawProfileRow | null;
  }
  if (!profile) return { status: "not_found" };

  const subResult = await supabase
    .from("subscriptions")
    .select("user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, cancel_at_period_end, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  // 契約情報を読めないときに「未契約（Free）」と誤って見せないよう、読めなかったことを返す
  if (subResult.error) return { status: "unavailable" };
  const raw = (subResult.data as RawSubscriptionRow | null) ?? undefined;
  const subscription = toSnapshot(raw);
  return {
    status: "ok",
    member: {
      id: profile.id,
      email: profile.email,
      username: profile.username ?? null,
      registeredAt: profile.created_at,
      effectivePlan: resolveEffectivePlan(subscription),
      subscription,
      stripeCustomerId: raw?.stripe_customer_id ?? null,
      stripeSubscriptionId: raw?.stripe_subscription_id ?? null,
      contractStartedAt: raw?.created_at ?? null,
    },
  };
}

export interface MemberListFilter {
  /** メールアドレス・ユーザー名の部分一致検索（大文字小文字・全角半角を区別しない） */
  query?: string;
  plan?: Plan;
  /** 契約状態の生ステータス（"none" = 契約したことがない） */
  status?: string;
}

export function filterMembers(members: MemberRow[], filter: MemberListFilter): MemberRow[] {
  return members.filter((m) => {
    if (filter.query) {
      if (!matchesMemberQuery(m, filter.query)) return false;
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

// ダッシュボードのKPI集計の計算ロジックは ./stats.ts（取得失敗時の表示制御もそこで行う）
export { computeDashboardStats };
export type { AdminDashboardStats };

// ============================================================
// ツール利用状況（tool_usage_daily）
// ============================================================
//
// 重要な制約：tool_usage_daily（supabase/migrations/0002_tool_usage_daily.sql）は
// Mr.Satto全体のアクセスログではない。もともと「記入済みPDF→Excel」1ツールの
// Standardプラン向け1日あたり利用回数制限を数えるためだけに使われていたが、
// 利用制限見直し（2026・第2版）でこのツールのStandard向け1日あたり回数上限が
// 撤廃されたため、現在このツールはこのテーブルへの書き込みを行っていない
// （以前の呼び出し元だった src/lib/tools/filled-pdf-to-excel/daily-usage.ts は
// 削除済み）。そのため、このテーブルを参照する以下の集計は、今後
// 「記入済みPDF→Excel」については新規データが増えず、過去の記録のみを示す
// ことになる。他の98ツールは、ブラウザ内完結・サーバー非送信という設計方針
// そのものにより、利用回数をサーバー側で記録していない。そのため、ここで
// 表示できるのは「利用ログが存在するツールの利用回数」のみであり、サイト
// 全体のツール利用回数ではない。推測値で埋めることはしない。

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
  /**
   * 利用ログの取得状態。ok以外（サービスロールキー未設定・DBエラー・一部のみ取得）の場合、
   * 下の数値は「利用回数が0回」という意味ではなく、「取得できなかった（正しい値ではない）」という意味。
   * 「ok かつ 0件」は、取得できたうえでログが無いことを表す。
   */
  status: DataStatus;
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

// 取得できなかった場合の値。数値の0は「未取得」を表すだけで、利用回数が0回という意味ではない。
const UNAVAILABLE_USAGE_SUMMARY: ToolUsageSummary = {
  status: "unavailable",
  todayTotal: 0,
  monthTotal: 0,
  byTool: [],
  dailyThisMonth: [],
};

/** 今月分（Asia/Tokyo基準）のツール利用ログを集計する。管理者判定後にのみ呼ぶこと。 */
export async function fetchToolUsageSummary(): Promise<ToolUsageSummary> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return UNAVAILABLE_USAGE_SUMMARY;

  const today = todayInTokyo();
  const monthStart = monthStartInTokyo();

  const result = await supabase
    .from("tool_usage_daily")
    .select("tool_id, usage_date, count", { count: "exact" })
    .gte("usage_date", monthStart)
    .order("usage_date", { ascending: true });

  const { rows, status } = classifyQuery<RawUsageRow>({
    data: result.data as RawUsageRow[] | null,
    error: result.error,
    count: result.count,
  });
  if (status === "unavailable") return UNAVAILABLE_USAGE_SUMMARY;
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

  return { status, todayTotal, monthTotal, byTool, dailyThisMonth };
}

// ============================================================
// サイトの訪問数（site_visits_daily）
// ============================================================

export interface SiteVisitsResult {
  rows: { date: string; visitors: number; pageviews: number }[];
  /** unavailable のとき（表が未作成・接続設定なしなど）、訪問数は「不明」であり0ではない */
  status: DataStatus;
}

/** 日ごとの訪問者数・閲覧数を取得する（最大で約5年分）。管理者判定後にのみ呼ぶこと。 */
export async function fetchSiteVisits(): Promise<SiteVisitsResult> {
  const supabase = getSupabaseServiceClient();
  if (!supabase) return { rows: [], status: "unavailable" };
  const result = await supabase
    .from("site_visits_daily")
    .select("visit_date, visitors, pageviews", { count: "exact" })
    .order("visit_date", { ascending: false })
    .limit(2000);
  const outcome = classifyQuery<{ visit_date: string; visitors: number; pageviews: number }>({
    data: result.data as { visit_date: string; visitors: number; pageviews: number }[] | null,
    error: result.error,
    count: result.count,
  });
  return {
    rows: outcome.rows.map((r) => ({ date: r.visit_date, visitors: Number(r.visitors) || 0, pageviews: Number(r.pageviews) || 0 })),
    status: outcome.status,
  };
}
