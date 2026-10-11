import { PLAN_DEFINITIONS, type Plan } from "@/lib/plans/types";

/**
 * 管理画面の集計ロジック（純粋関数のみ。Supabaseや環境変数には依存しない）。
 *
 * データ取得に失敗したときに、画面へ「0人」「0回」などの「正常な値」として表示してしまわないよう、
 * 取得状態（DataStatus）を値とは別に持ち回るための共通部品。
 * "server-only" には依存しないので、自動テストから直接importできる。
 */

/**
 * - ok: 全件を取得できた（結果が0件でも、取得できていればok）
 * - partial: 一部しか取得できなかった（件数の総数が、取得できた行数より多い）
 * - unavailable: 取得できなかった（接続設定なし・DBエラーなど）。件数は「不明」であり0ではない
 */
export type DataStatus = "ok" | "partial" | "unavailable";

export interface QueryOutcome<T> {
  rows: T[];
  status: DataStatus;
}

/** Supabase(PostgREST)のselect結果を、取得状態つきの結果へ変換する。`count: "exact"` で取得した値を渡すこと */
export function classifyQuery<T>(result: {
  data: T[] | null | undefined;
  error: unknown;
  count?: number | null;
}): QueryOutcome<T> {
  if (result.error || !result.data) return { rows: [], status: "unavailable" };
  if (typeof result.count === "number" && result.count > result.data.length) {
    return { rows: result.data, status: "partial" };
  }
  return { rows: result.data, status: "ok" };
}

// ============================================================
// ダッシュボードのKPI
// ============================================================

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
   * 反映した実績値）ではない点に注意。
   */
  estimatedMonthlyRevenueYen: number;
}

/** 会員一覧からKPIを計算する（計算式は従来から変更していない） */
export function computeDashboardStats(members: { effectivePlan: Plan }[]): AdminDashboardStats {
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

/** 画面に出す1つの数値。取得できなかった値は「0」ではなく unavailable にする */
export type StatValue = { kind: "value"; value: number } | { kind: "unavailable" };

export interface DashboardStatsView {
  totalUsers: StatValue;
  freeUsers: StatValue;
  standardUsers: StatValue;
  premiumUsers: StatValue;
  payingUsers: StatValue;
  estimatedMonthlyRevenueYen: StatValue;
}

const UNAVAILABLE: StatValue = { kind: "unavailable" };

/**
 * 取得状態に応じて、画面に出してよい数値だけを返す。
 * - 総ユーザー数: 会員(profiles)を全件取得できたときのみ
 * - プラン別人数・MRR: 会員と契約(subscriptions)の両方を全件取得できたときのみ
 *   （契約情報が欠けると、有料会員がFreeとして数えられ、誤った人数・売上になるため）
 */
export function buildDashboardStatsView(
  members: { effectivePlan: Plan }[],
  profiles: DataStatus,
  subscriptions: DataStatus
): DashboardStatsView {
  const stats = computeDashboardStats(members);
  const profilesOk = profiles === "ok";
  const plansOk = profilesOk && subscriptions === "ok";
  const v = (ok: boolean, value: number): StatValue => (ok ? { kind: "value", value } : UNAVAILABLE);
  return {
    totalUsers: v(profilesOk, stats.totalUsers),
    freeUsers: v(plansOk, stats.freeUsers),
    standardUsers: v(plansOk, stats.standardUsers),
    premiumUsers: v(plansOk, stats.premiumUsers),
    payingUsers: v(plansOk, stats.payingUsers),
    estimatedMonthlyRevenueYen: v(plansOk, stats.estimatedMonthlyRevenueYen),
  };
}

/** StatValueを画面用の文字列にする。unavailableは「取得できません」（0とは区別する） */
export function formatStatValue(value: StatValue, suffix = ""): string {
  return value.kind === "value" ? `${value.value.toLocaleString()}${suffix}` : "取得できません";
}

/** 会員データの取得状態から、管理者向けの注意文を作る。問題がなければnull。エラーの詳細は含めない */
export function describeMembersIssue(profiles: DataStatus, subscriptions: DataStatus): string | null {
  if (profiles === "unavailable") {
    return "会員データを取得できませんでした。人数・売上の目安は表示していません（0人という意味ではありません）。Supabaseの接続設定を確認してください。";
  }
  if (profiles === "partial") {
    return "会員データの一部しか取得できませんでした。人数・売上の目安は、誤った値を表示しないよう表示していません。";
  }
  if (subscriptions === "unavailable") {
    return "契約情報を取得できませんでした。プラン別の人数と売上の目安は表示していません（総ユーザー数のみ取得できています）。";
  }
  if (subscriptions === "partial") {
    return "契約情報の一部しか取得できませんでした。プラン別の人数と売上の目安は、誤った値を表示しないよう表示していません。";
  }
  return null;
}

/** 利用ログの取得状態を、画面用の文字列にする（数値のとき以外は0と区別できる文言） */
export function formatUsageCount(status: DataStatus, count: number): string {
  if (status === "ok") return count.toLocaleString();
  return status === "partial" ? "一部のみ取得" : "取得できません";
}
