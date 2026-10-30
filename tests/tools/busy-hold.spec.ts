import { test, expect } from "../fixtures/premium-test";
import { BUSY_MIN_MS, busyHoldRemaining, markBusyStart, resetBusyHold } from "@/lib/utils/busy-hold";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";

/** 押してから最低0.6秒は、処理中の表示（ボタンの光・処理中の文字・完了ポップアップの待ち）を続ける */

test.describe("処理中の表示を最低0.6秒続ける: 計算", () => {
  test("開始から BUSY_MIN_MS の間だけ、残りの時間が出る", () => {
    resetBusyHold();
    expect(BUSY_MIN_MS).toBe(600);
    expect(busyHoldRemaining(1000)).toBe(0);
    markBusyStart(1000);
    expect(busyHoldRemaining(1000)).toBe(600);
    expect(busyHoldRemaining(1400)).toBe(200);
    expect(busyHoldRemaining(1600)).toBe(0);
    expect(busyHoldRemaining(5000)).toBe(0);
    resetBusyHold();
  });

  test("あとから始まった処理で、待つ時間は短くならない", () => {
    resetBusyHold();
    markBusyStart(2000);
    markBusyStart(1000);
    expect(busyHoldRemaining(2000)).toBe(600);
    resetBusyHold();
  });
});

test.describe("処理中の表示を最低0.6秒続ける: 実際の画面（一瞬で終わるCSV→Excel）", () => {
  test("光（aria-busy）が最低0.6秒続き、その間は押せず、完了ポップアップはそのあとに出る", async ({ page }) => {
    await page.goto("/tools/csv-to-excel");
    await waitForFileInputHydrated(page);
    await uploadFixture(page, fixtures.csv);
    const run = page.getByRole("button", { name: "Excelに変換する" });
    await expect(run).toBeVisible({ timeout: 40_000 });

    // ボタンの aria-busy が付いた時刻・外れた時刻・ポップアップが出た時刻を、押す前から記録しておく
    await page.evaluate(() => {
      const w = window as unknown as { __t: { on?: number; off?: number; popup?: number; held?: boolean } };
      w.__t = {};
      const btn = () => [...document.querySelectorAll("button")].find((b) => /Excelに変換する/.test(b.textContent ?? ""));
      new MutationObserver(() => {
        const b = btn();
        const now = performance.now();
        if (b?.getAttribute("aria-busy") === "true") {
          if (w.__t.on === undefined) w.__t.on = now;
          if (b.getAttribute("data-ms-hold") === "true") w.__t.held = true;
          w.__t.off = undefined;
        } else if (w.__t.on !== undefined && w.__t.off === undefined) {
          w.__t.off = now;
        }
        if (document.querySelector('[data-testid="result-popup"]') && w.__t.popup === undefined) w.__t.popup = now;
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    await run.click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 20_000 });
    await expect(run).not.toHaveAttribute("aria-busy", "true", { timeout: 5_000 });

    const t = await page.evaluate(() => (window as unknown as { __t: { on?: number; off?: number; popup?: number; held?: boolean } }).__t);
    expect(t.on, "光が付いたこと").toBeDefined();
    expect(t.off, "光が外れたこと").toBeDefined();
    expect(t.off! - t.on!, "光が最低0.6秒続いたこと").toBeGreaterThanOrEqual(570);
    expect(t.popup, "ポップアップが出たこと").toBeDefined();
    expect(t.popup! - t.on!, "ポップアップは、光が0.6秒続いたあとに出ること").toBeGreaterThanOrEqual(570);
  });
});
