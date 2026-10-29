import { test, expect } from "@playwright/test";
import {
  ADMIN_GRANT_MAX_DAYS,
  TRIAL_DAYS,
  applyGrantToPlan,
  grantEndFromDate,
  AI_TRIAL_LIMIT_MICRO_USD,
  jstDateAfterDays,
  grantEndMs,
  isGrantActive,
  trialOfferState,
  type PremiumGrant,
} from "@/lib/plans/grants";

/** プレミアムの無料付与・3日間の無料お試しの、判定ルールのテスト（画面・DBは使わない） */
const NOW = Date.parse("2026-10-30T00:00:00Z"); // 日本時間 2026-10-30 09:00
const DAY = 24 * 60 * 60 * 1000;
const grant = (startOffsetDays: number, endOffsetDays: number, source: PremiumGrant["source"] = "admin"): PremiumGrant => ({
  source,
  startsAt: new Date(NOW + startOffsetDays * DAY).toISOString(),
  endsAt: new Date(NOW + endOffsetDays * DAY).toISOString(),
});

test.describe("isGrantActive", () => {
  test("期間内だけ有効（開始は含み、終了ちょうどは含まない）", () => {
    expect(isGrantActive(grant(-1, 2), NOW)).toBe(true);
    expect(isGrantActive(grant(0, 3), NOW)).toBe(true);
    expect(isGrantActive(grant(-3, 0), NOW)).toBe(false);
    expect(isGrantActive(grant(-5, -1), NOW)).toBe(false);
    expect(isGrantActive(grant(1, 3), NOW)).toBe(false);
  });
  test("付与なし・読めない日付は無効", () => {
    expect(isGrantActive(null, NOW)).toBe(false);
    expect(isGrantActive({ source: "admin", startsAt: "x", endsAt: "y" }, NOW)).toBe(false);
  });
});

test.describe("grantEndMs", () => {
  test("日数は1〜上限の整数だけ", () => {
    expect(grantEndMs(NOW, TRIAL_DAYS)).toBe(NOW + 3 * DAY);
    expect(grantEndMs(NOW, ADMIN_GRANT_MAX_DAYS)).toBe(NOW + ADMIN_GRANT_MAX_DAYS * DAY);
    for (const bad of [0, -1, 1.5, ADMIN_GRANT_MAX_DAYS + 1, Number.NaN]) expect(grantEndMs(NOW, bad)).toBeNull();
  });
});

test.describe("grantEndFromDate（管理者が指定する最終日）", () => {
  // NOW = 2026-10-30 09:00（日本時間）
  test("指定した日の終わり（日本時間 23:59:59.999）まで有効", () => {
    const end = grantEndFromDate("2026-11-05", NOW);
    expect(end).toBe(Date.parse("2026-11-05T23:59:59.999+09:00"));
    expect(isGrantActive({ source: "admin", startsAt: new Date(NOW).toISOString(), endsAt: new Date(end as number).toISOString() }, Date.parse("2026-11-05T23:00:00+09:00"))).toBe(true);
    expect(isGrantActive({ source: "admin", startsAt: new Date(NOW).toISOString(), endsAt: new Date(end as number).toISOString() }, Date.parse("2026-11-06T00:00:00+09:00"))).toBe(false);
  });
  test("今日（まだ終わっていない）を指定できる。過去の日は不可", () => {
    expect(grantEndFromDate("2026-10-30", NOW)).not.toBeNull();
    expect(grantEndFromDate("2026-10-29", NOW)).toBeNull();
  });
  test("形式が正しくない・存在しない日付・上限（約3年）超えは不可", () => {
    for (const bad of ["", "2026/11/05", "2026-11-5", "2026-02-30", "2026-13-01", "abc", "2026-11-05T00:00"]) expect(grantEndFromDate(bad, NOW), bad).toBeNull();
    expect(grantEndFromDate("2026-11-05", NOW)).not.toBeNull();
    expect(grantEndFromDate("2031-01-01", NOW)).toBeNull();
    expect(grantEndFromDate("2029-10-01", NOW)).not.toBeNull();
  });
  test("画面の初期値の日付は YYYY-MM-DD", () => {
    expect(jstDateAfterDays(30)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

test.describe("無料お試しのAI枠", () => {
  test("100円相当（165円/ドル）を超えない", () => {
    expect((AI_TRIAL_LIMIT_MICRO_USD / 1_000_000) * 165).toBeLessThanOrEqual(100);
    expect((AI_TRIAL_LIMIT_MICRO_USD / 1_000_000) * 165).toBeGreaterThan(95);
  });
});

test.describe("applyGrantToPlan", () => {
  test("有効な付与があれば、free・standardはpremiumに引き上げる", () => {
    expect(applyGrantToPlan("free", grant(-1, 2), NOW)).toBe("premium");
    expect(applyGrantToPlan("standard", grant(-1, 2), NOW)).toBe("premium");
  });
  test("期限が切れたら、元のプランに戻る", () => {
    expect(applyGrantToPlan("free", grant(-5, -1), NOW)).toBe("free");
    expect(applyGrantToPlan("standard", grant(-5, -1), NOW)).toBe("standard");
  });
  test("すでにpremiumなら、そのまま。付与でプランが下がることはない", () => {
    expect(applyGrantToPlan("premium", null, NOW)).toBe("premium");
    expect(applyGrantToPlan("premium", grant(-5, -1), NOW)).toBe("premium");
  });
});

test.describe("trialOfferState", () => {
  const base = { signedIn: true, subscriptionPremium: false, grantActive: false, trialUsed: false };
  test("未ログインは会員登録の案内", () => expect(trialOfferState({ ...base, signedIn: false })).toBe("guest"));
  test("ログイン済みで未使用なら、ボタンを出す", () => expect(trialOfferState(base)).toBe("available"));
  test("使用済みなら出さない", () => expect(trialOfferState({ ...base, trialUsed: true })).toBe("hidden"));
  test("付与中は、利用中の表示", () => expect(trialOfferState({ ...base, grantActive: true })).toBe("active"));
  test("Stripeの契約でプレミアムなら出さない", () => expect(trialOfferState({ ...base, subscriptionPremium: true, grantActive: true })).toBe("hidden"));
});
