import { test, expect } from "@playwright/test";
import { PLAN_LIMITS } from "@/lib/plans/tool-limits";

/**
 * 料金ページの「件数の上限」の1行（無料：少なめ／スタンダード：一部ツールで上限アップ／プレミアム：上限が最大）が、
 * 実際の上限（PLAN_LIMITS）とずれていないことを確かめる。
 */
test.describe("料金ページの件数の上限の表示", () => {
  const limits = Object.values(PLAN_LIMITS);

  test("スタンダードはどのツールでも無料以上で、一部のツールでは無料より多い", () => {
    for (const l of limits) expect(l.standard).toBeGreaterThanOrEqual(l.free);
    expect(limits.some((l) => l.standard > l.free)).toBe(true);
  });

  test("プレミアムはどのツールでも、スタンダード・無料以上（上限が最大）", () => {
    for (const l of limits) {
      expect(l.premium).toBeGreaterThanOrEqual(l.standard);
      expect(l.premium).toBeGreaterThanOrEqual(l.free);
    }
  });
});
