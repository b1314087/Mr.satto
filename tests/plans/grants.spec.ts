import { test, expect } from "@playwright/test";
import {
  ADMIN_GRANT_DAY_CHOICES,
  ADMIN_GRANT_MAX_DAYS,
  TRIAL_DAYS,
  applyGrantToPlan,
  grantEndMs,
  isGrantActive,
  trialOfferState,
  type PremiumGrant,
} from "@/lib/plans/grants";

/** プレミアムの無料付与・3日間の無料お試しの、判定ルールのテスト（画面・DBは使わない） */
const NOW = Date.parse("2026-10-30T00:00:00Z");
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
  test("画面の選択肢は、すべて上限以内", () => {
    for (const d of ADMIN_GRANT_DAY_CHOICES) expect(grantEndMs(NOW, d)).not.toBeNull();
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
