import { test, expect } from "@playwright/test";
import {
  buildDashboardStatsView,
  classifyQuery,
  computeDashboardStats,
  describeMembersIssue,
  formatStatValue,
  formatUsageCount,
} from "@/lib/admin/stats";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";

/**
 * 管理画面の集計・取得状態の表示ロジックの単体テスト（Phase 1-5）。
 *
 * 目的: データ取得に失敗したときに「0人」「0回」といった正常な値に見えないこと、
 * 取得成功で本当に0件のときとは区別されることを保証する。
 * ブラウザ・Supabase・Stripeには一切接続しない（純粋関数のみを検証する）。
 */

const standard = { effectivePlan: "standard" as const };
const premium = { effectivePlan: "premium" as const };
const free = { effectivePlan: "free" as const };

test.describe("会員数・プラン別人数・MRR", () => {
  test("取得成功・0人: 0と表示でき、「取得できません」ではない", () => {
    const view = buildDashboardStatsView([], "ok", "ok");
    expect(view.totalUsers).toEqual({ kind: "value", value: 0 });
    expect(formatStatValue(view.totalUsers)).toBe("0");
    expect(formatStatValue(view.estimatedMonthlyRevenueYen, "円")).toBe("0円");
    expect(describeMembersIssue("ok", "ok")).toBeNull();
  });

  test("取得成功・複数人: 人数とMRRが従来どおりの計算式で出る", () => {
    const members = [free, free, free, standard, standard, premium];
    const view = buildDashboardStatsView(members, "ok", "ok");
    expect(formatStatValue(view.totalUsers)).toBe("6");
    expect(formatStatValue(view.freeUsers)).toBe("3");
    expect(formatStatValue(view.standardUsers)).toBe("2");
    expect(formatStatValue(view.premiumUsers)).toBe("1");
    expect(formatStatValue(view.payingUsers)).toBe("3");
    const expected = 2 * PLAN_DEFINITIONS.standard.priceYen + PLAN_DEFINITIONS.premium.priceYen;
    expect(computeDashboardStats(members).estimatedMonthlyRevenueYen).toBe(expected);
    expect(formatStatValue(view.estimatedMonthlyRevenueYen, "円")).toBe(`${expected.toLocaleString()}円`);
  });

  test("会員データの取得失敗: すべて「取得できません」で、0人と表示しない", () => {
    const view = buildDashboardStatsView([], "unavailable", "unavailable");
    for (const value of Object.values(view)) {
      expect(value).toEqual({ kind: "unavailable" });
      expect(formatStatValue(value)).toBe("取得できません");
    }
    expect(describeMembersIssue("unavailable", "ok")).toContain("会員データを取得できませんでした");
  });

  test("会員データの一部のみ取得: 誤った合計を表示しない", () => {
    const view = buildDashboardStatsView([free, standard], "partial", "ok");
    expect(view.totalUsers).toEqual({ kind: "unavailable" });
    expect(view.estimatedMonthlyRevenueYen).toEqual({ kind: "unavailable" });
    expect(describeMembersIssue("partial", "ok")).toContain("一部しか取得できませんでした");
  });

  test("契約情報だけ取得失敗: 総ユーザー数は出すが、プラン別人数とMRRは出さない", () => {
    // 契約情報が無いと有料会員もFreeとして計算されてしまうため、人数・売上を出してはいけない
    const members = [free, free, free];
    const view = buildDashboardStatsView(members, "ok", "unavailable");
    expect(formatStatValue(view.totalUsers)).toBe("3");
    expect(view.freeUsers).toEqual({ kind: "unavailable" });
    expect(view.standardUsers).toEqual({ kind: "unavailable" });
    expect(view.premiumUsers).toEqual({ kind: "unavailable" });
    expect(view.payingUsers).toEqual({ kind: "unavailable" });
    expect(view.estimatedMonthlyRevenueYen).toEqual({ kind: "unavailable" });
    expect(describeMembersIssue("ok", "unavailable")).toContain("契約情報を取得できませんでした");
  });

  test("契約情報の一部のみ取得も、プラン別人数とMRRは出さない", () => {
    const view = buildDashboardStatsView([free, standard], "ok", "partial");
    expect(formatStatValue(view.totalUsers)).toBe("2");
    expect(view.payingUsers).toEqual({ kind: "unavailable" });
    expect(view.estimatedMonthlyRevenueYen).toEqual({ kind: "unavailable" });
  });
});

test.describe("利用回数", () => {
  test("取得成功・ログなし: 0と表示する（取得失敗とは別の表示）", () => {
    expect(formatUsageCount("ok", 0)).toBe("0");
  });

  test("取得成功・ログあり: 回数を表示する", () => {
    expect(formatUsageCount("ok", 1234)).toBe("1,234");
  });

  test("取得失敗: 0と表示しない", () => {
    expect(formatUsageCount("unavailable", 0)).toBe("取得できません");
    expect(formatUsageCount("unavailable", 0)).not.toBe(formatUsageCount("ok", 0));
  });

  test("一部のみ取得: 不完全な回数を表示しない", () => {
    expect(formatUsageCount("partial", 57)).toBe("一部のみ取得");
  });
});

test.describe("Supabaseの取得結果の判定(classifyQuery)", () => {
  test("エラー: unavailable（行は空だが0件という意味ではない）", () => {
    expect(classifyQuery({ data: null, error: { message: "boom" }, count: null })).toEqual({
      rows: [],
      status: "unavailable",
    });
  });

  test("データなし(null)でエラーもない場合も unavailable", () => {
    expect(classifyQuery({ data: null, error: null, count: null }).status).toBe("unavailable");
  });

  test("成功・0件: ok", () => {
    expect(classifyQuery({ data: [], error: null, count: 0 })).toEqual({ rows: [], status: "ok" });
  });

  test("成功・複数件（総数と一致）: ok", () => {
    expect(classifyQuery({ data: [1, 2, 3], error: null, count: 3 })).toEqual({ rows: [1, 2, 3], status: "ok" });
  });

  test("総数が取得行数より多い: partial", () => {
    expect(classifyQuery({ data: [1, 2], error: null, count: 5 })).toEqual({ rows: [1, 2], status: "partial" });
  });

  test("総数が不明(count無し)でも、データがあれば ok", () => {
    expect(classifyQuery({ data: [1], error: null }).status).toBe("ok");
  });
});
