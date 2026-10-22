import { test, expect } from "@playwright/test";
import { AI_PERIOD_END_GRACE_MS, resolveAiPlan, resolveEffectivePlan, type SubscriptionSnapshot } from "@/lib/plans/effective-plan";
import { weekdayHintForRow, weekdayMismatchMessage } from "@/lib/calendar/event-import";

/**
 * AIを使える契約かどうかの判定（純粋な関数）と、AIの結果の曜日の照合。外部サービスには接続しない。
 * サーバーでの強制そのもの（未ログイン・Free・利用枠）は service.spec.ts、契約状態の同期は tests/stripe が担当する。
 */

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function sub(over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return { plan: "premium", status: "active", currentPeriodEnd: iso(NOW + 10 * DAY), cancelAtPeriodEnd: false, ...over };
}

test.describe("契約状態の判定: 取得できない・有効でないときは、安全側（Free）", () => {
  test("契約が取得できない(null)・未知の状態・支払い遅れ・解約済みは、Free", () => {
    expect(resolveEffectivePlan(null)).toBe("free");
    for (const status of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", "", "unknown-status"]) {
      expect(resolveEffectivePlan(sub({ status })), status).toBe("free");
    }
    expect(resolveEffectivePlan(sub())).toBe("premium");
    expect(resolveEffectivePlan(sub({ status: "trialing" }))).toBe("premium");
  });
});

test.describe("AIを使える契約か(resolveAiPlan): 期間が過ぎても更新が確認できない契約を、AIだけ止める", () => {
  test("期間内の契約は、そのままPremium", () => {
    expect(resolveAiPlan("premium", sub(), NOW)).toBe("premium");
    expect(resolveAiPlan("premium", sub({ cancelAtPeriodEnd: true }), NOW)).toBe("premium"); // 解約予約でも、期間の終了までは使える
  });

  test("期間の終了から猶予(3日)までは、更新通知の遅れとしてPremiumのまま。過ぎたらFree", () => {
    const ended = (ago: number) => sub({ currentPeriodEnd: iso(NOW - ago) });
    expect(resolveAiPlan("premium", ended(1 * DAY), NOW)).toBe("premium");
    expect(resolveAiPlan("premium", ended(AI_PERIOD_END_GRACE_MS - 1000), NOW)).toBe("premium");
    expect(resolveAiPlan("premium", ended(AI_PERIOD_END_GRACE_MS + 1000), NOW)).toBe("free");
    expect(resolveAiPlan("premium", ended(400 * DAY), NOW)).toBe("free");
  });

  test("解約予約のある契約は、期間の終了で猶予なしに終わる（終了通知が届いていなくても）", () => {
    expect(resolveAiPlan("premium", sub({ cancelAtPeriodEnd: true, currentPeriodEnd: iso(NOW - 1000) }), NOW)).toBe("free");
    expect(resolveAiPlan("premium", sub({ cancelAtPeriodEnd: true, currentPeriodEnd: iso(NOW + 1000) }), NOW)).toBe("premium");
  });

  test("期間の終了日が不明・読めない古い行は判定できないので、status のまま。Premium以外は変えない", () => {
    expect(resolveAiPlan("premium", sub({ currentPeriodEnd: null }), NOW)).toBe("premium");
    expect(resolveAiPlan("premium", sub({ currentPeriodEnd: "not-a-date" }), NOW)).toBe("premium");
    expect(resolveAiPlan("premium", null, NOW)).toBe("premium"); // 開発用のプラン上書き(契約なし)。本番では起きない（利用者IDが無いためAIは使えない）
    expect(resolveAiPlan("free", sub({ currentPeriodEnd: iso(NOW - 400 * DAY) }), NOW)).toBe("free");
    expect(resolveAiPlan("standard", sub({ plan: "standard" }), NOW)).toBe("standard");
  });
});

test.describe("AIの結果と元の行の曜日の照合", () => {
  const mapping = { date: 0, title: 1, start: null, end: null };
  const rows = [
    ["日付", "予定", "曜日"],
    ["4/20(月)", "棚卸し", ""], // 2026-04-20 は月曜日
    ["4/21（月）", "会議", ""], // 2026-04-21 は火曜日 → 曜日が合わない
    ["五月の連休明け", "全体会議", ""],
    ["4/22", "研修", "水"], // 曜日の列
    ["4/23", "研修", "月曜日"], // 2026-04-23 は木曜日 → 合わない
    ["4/24", "研修", "祝"], // 曜日として読めない文字は照合しない
  ];

  test("日付のセルの付記・「曜日」列から、書かれている曜日を読む", () => {
    expect(weekdayHintForRow(rows, 0, mapping, 2)).toBe(1);
    expect(weekdayHintForRow(rows, 0, mapping, 3)).toBe(1);
    expect(weekdayHintForRow(rows, 0, mapping, 4)).toBeNull();
    expect(weekdayHintForRow(rows, 0, mapping, 5)).toBe(3);
    expect(weekdayHintForRow(rows, 0, mapping, 6)).toBe(1);
    expect(weekdayHintForRow(rows, 0, mapping, 7)).toBeNull();
    expect(weekdayHintForRow(rows, 0, mapping, 99)).toBeNull();
  });

  test("日付と曜日が合わないときだけ説明を返す。曜日が無い・日付が読めないときは照合しない", () => {
    expect(weekdayMismatchMessage("2026-04-20", 1)).toBeNull();
    expect(weekdayMismatchMessage("2026-04-21", 1)).toContain("火曜日");
    expect(weekdayMismatchMessage("2026-04-21", 1)).toContain("「月」");
    expect(weekdayMismatchMessage("2026-04-23", 1)).not.toBeNull();
    expect(weekdayMismatchMessage("2026-04-20", null)).toBeNull();
    expect(weekdayMismatchMessage("", 1)).toBeNull();
    expect(weekdayMismatchMessage("2026/04/20", 1)).toBeNull();
  });
});
