import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import {
  DOCUMENT_SERIAL_STORAGE_KEY,
  buildDocumentNumber,
  compactIssueDate,
  parseSerialStore,
  recordSerial,
  suggestNextSerial,
} from "@/lib/documents/document-number";

/**
 * 書類番号の自動採番：「記号-発行日-末尾」。末尾は通し番号（プルダウン）か時刻（時分）。
 * 通し番号は、このブラウザで前回使った番号の次を最初から選んでおく。
 */

test.describe("書類番号: 組み立て（計算）", () => {
  test("記号・発行日・末尾を組み合わせる", () => {
    const now = new Date(2026, 10, 1, 15, 13, 5);
    expect(buildDocumentNumber({ type: "invoice", issueDate: "2026-11-01", mode: "serial", serial: 1, now })).toBe("INV-20261101-001");
    expect(buildDocumentNumber({ type: "estimate", issueDate: "2026-10-31", mode: "serial", serial: 12, now })).toBe("EST-20261031-012");
    expect(buildDocumentNumber({ type: "order", issueDate: "2026-11-01", mode: "time", serial: 1, now })).toBe("ORD-20261101-1513");
    // 発行日が空・読めないときは今日の日付
    expect(compactIssueDate("", now)).toBe("20261101");
  });

  test("前回の次を提案し、壊れた記録は無視する", () => {
    expect(parseSerialStore("{壊れた")).toEqual({});
    expect(parseSerialStore('{"invoice:20261101":3,"x":"a","y":-1}')).toEqual({ "invoice:20261101": 3 });
    const s = recordSerial({}, "invoice:20261101", 3);
    expect(suggestNextSerial(s, "invoice:20261101")).toBe(4);
    expect(suggestNextSerial(s, "invoice:20261102")).toBe(1);
    // 前の番号を選び直しても、記録は大きい方を残す
    expect(recordSerial(s, "invoice:20261101", 2)["invoice:20261101"]).toBe(3);
    // 上限（050）を超えない
    expect(suggestNextSerial({ k: 50 }, "k")).toBe(50);
  });
});

async function open(page: Page, slug: string) {
  await page.goto(`/tools/${slug}`);
  await page.getByTestId("document-number-apply").waitFor({ timeout: 60_000 });
}

/**
 * 発行日を入れてから番号を入れる。
 * 画面の準備（ハイドレーション）の前に入れた発行日は、準備が終わるときに初期値（今日）へ戻ることがある。
 * そのまま番号を入れると、今日の日付で番号が作られ、今日の分の通し番号まで記録されてしまう（監査の「原因未確定」document-number）。
 * そこで、発行日が画面の状態に入ったこと（プレビューの「発行日: …」に出たこと）を確かめてから、1回だけ押す。
 */
async function applyWithIssueDate(page: Page, isoDate: string) {
  const dateInput = page.locator('input[type="date"]').first();
  await expect(async () => {
    await dateInput.fill(isoDate);
    await expect(page.getByTestId("tool-preview")).toContainText(`発行日: ${isoDate}`, { timeout: 1_500 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId("document-number-apply").click();
  const input = page.getByTestId("document-number");
  await expect(input).not.toHaveValue("");
  return input.inputValue();
}

test.describe("書類番号: 画面", () => {
  test("請求書: 発行日と通し番号で番号が入り、次は続きの番号が選ばれる。選び直しもできる", async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, "invoice-generator");
    expect(await applyWithIssueDate(page, "2026-11-01")).toBe("INV-20261101-001");

    // 次は 002 が選ばれている。押すと 002
    const select = page.getByTestId("document-number-serial");
    await expect(select).toHaveValue("2");
    await expect(page.getByTestId("document-number-hint")).toContainText("001 まで使いました");
    await page.getByTestId("document-number-apply").click();
    await expect(page.getByTestId("document-number")).toHaveValue("INV-20261101-002");

    // プルダウンで 010 を選んで入れる
    await select.selectOption("10");
    await page.getByTestId("document-number-apply").click();
    await expect(page.getByTestId("document-number")).toHaveValue("INV-20261101-010");
    await expect(select).toHaveValue("11");

    // 発行日を変えると、その日の 001 から
    await page.locator('input[type="date"]').first().fill("2026-11-02");
    await expect(select).toHaveValue("1");

    // ページを開き直しても、続きの番号を覚えている（このブラウザの中だけ）
    await page.reload();
    await page.getByTestId("document-number-apply").waitFor();
    // 開き直した直後（画面の準備の前）に入れた発行日は戻ることがあるので、プレビューに出るまで入れ直す
    await expect(async () => {
      await page.locator('input[type="date"]').first().fill("2026-11-01");
      await expect(page.getByTestId("tool-preview")).toContainText("発行日: 2026-11-01", { timeout: 1_500 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("document-number-serial")).toHaveValue("11");
    const stored = await page.evaluate((k) => localStorage.getItem(k), DOCUMENT_SERIAL_STORAGE_KEY);
    expect(JSON.parse(stored ?? "{}")).toEqual({ "invoice:20261101": 10 });
  });

  test("見積書: 時刻を選ぶと、末尾が時分の4桁になり、通し番号の記録は増えない", async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.setFixedTime(new Date(2026, 10, 1, 15, 13, 0));
    await open(page, "estimate-generator");
    await page.locator('input[type="date"]').first().fill("2026-11-01");
    await expect(async () => {
      await page.getByTestId("document-number-mode-time").check();
      await expect(page.getByTestId("document-number-serial")).toHaveCount(0, { timeout: 1_500 });
    }).toPass({ timeout: 20_000 });
    await page.getByTestId("document-number-apply").click();
    await expect(page.getByTestId("document-number")).toHaveValue("EST-20261101-1513");
    expect(await page.evaluate((k) => localStorage.getItem(k), DOCUMENT_SERIAL_STORAGE_KEY)).toBeNull();
  });

  test("見積書と請求書の通し番号は別々に数える（同じ取引で末尾をそろえやすい）", async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, "estimate-generator");
    expect(await applyWithIssueDate(page, "2026-11-01")).toBe("EST-20261101-001");
    await open(page, "invoice-generator");
    expect(await applyWithIssueDate(page, "2026-11-01")).toBe("INV-20261101-001");
  });
});
