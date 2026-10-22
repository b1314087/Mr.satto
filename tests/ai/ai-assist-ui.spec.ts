import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { CONSENT_VERSION } from "@/lib/ai/calendar-assist";

/**
 * 年度カレンダー作成: AIで読み取る補助（画面）のE2Eテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAI・Stripe・Supabaseには接続しない。
 */

const SLUG = "/tools/fiscal-calendar";
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const HEADER = ["日付", "予定", "開始時刻", "終了時刻", "備考"];

async function openTool(page: Page) {
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
    return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
  });
  await page.getByLabel("年度", { exact: true }).selectOption("2026");
}

async function loadFile(page: Page, rows: unknown[][]) {
  const blob = await writeXlsxSheets([{ name: "予定表", rows }]);
  await page.getByTestId("events-file").setInputFiles({
    name: "予定表.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await blob.arrayBuffer()),
  });
  await expect(page.getByTestId("events-summary")).toBeVisible({ timeout: 30_000 });
}

const ROWS = (): unknown[][] => [
  HEADER,
  [d(2026, 4, 1), "入社式", "10:00", null, "社外秘のメモ"], // 2行目: 通常に読める
  ["四月二十日", "棚卸し", "09:00", null, "倉庫"], // 3行目: 日付を読めない
  ["五月の連休明け", "全体会議", null, null, "本社"], // 4行目: 日付を読めない
  [d(2026, 6, 1), "", null, null, ""], // 5行目: 予定名が空
];

const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_234_567, remainingAiTokens: 28_765_433, periodEnd: "2026-11-30T00:00:00Z" } };

interface Recorded {
  usageCalls: number;
  assistBodies: Record<string, unknown>[];
}

async function mockAi(page: Page, opts: { usage?: unknown; assist?: (body: Record<string, unknown>) => { status: number; body: unknown } }): Promise<Recorded> {
  const rec: Recorded = { usageCalls: 0, assistBodies: [] };
  await page.route("**/api/ai/usage", async (route: Route) => {
    rec.usageCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.usage ?? USAGE_OK) });
  });
  await page.route("**/api/ai/calendar-assist", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    rec.assistBodies.push(body);
    const r = opts.assist?.(body) ?? { status: 500, body: { error: "x", message: "テスト用のエラー" } };
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  return rec;
}

const suggestion = (row: number, over: Record<string, unknown>) => ({
  row,
  date: null,
  title: null,
  startTime: null,
  endTime: null,
  confidence: "high",
  inferred: false,
  note: "",
  ...over,
});

test.describe("年度カレンダー: AIで読み取る補助", () => {
  test("読み取れない行がなければAIの案内は出ない。通常の読み取りや生成でAIのAPIは呼ばれない", async ({ page }) => {
    const rec = await mockAi(page, {});
    await openTool(page);
    await loadFile(page, [HEADER, [d(2026, 4, 1), "入社式", "10:00", null, ""]]);
    await expect(page.getByTestId("ai-assist")).toHaveCount(0);
    await page.getByRole("button", { name: /Excelを作成/ }).first().click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    expect(rec.usageCalls).toBe(0);
    expect(rec.assistBodies).toHaveLength(0);
  });

  test("読み取れない行があっても、パネルを開くまでAIのAPIは呼ばれず、通常の結果はそのまま使える", async ({ page }) => {
    const rec = await mockAi(page, {});
    await openTool(page);
    await loadFile(page, ROWS());
    await expect(page.getByTestId("ai-assist")).toBeVisible();
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件");
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-04-01"]')).toContainText("入社式");
    expect(rec.usageCalls).toBe(0);
    expect(rec.assistBodies).toHaveLength(0);
  });

  test("Premiumでない・ログインしていない・利用できないときは、理由を示し、実行はできない", async ({ page }) => {
    await mockAi(page, { usage: { available: false, reason: "not_premium" } });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await expect(page.getByTestId("ai-unavailable")).toContainText("Premiumプランの機能");
    await expect(page.getByTestId("ai-upgrade-link")).toHaveAttribute("href", "/pricing");
    await expect(page.getByTestId("ai-run")).toHaveCount(0);
    await expect(page.getByTestId("ai-consent")).toHaveCount(0);
    // 通常の結果は影響を受けない
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件");
  });

  test("送る行・列を選び、内容を確認し、同意してから実行する。送られるのは選んだ内容と同意だけ", async ({ page }) => {
    const rec = await mockAi(page, {
      assist: (body) => ({
        status: 200,
        body: {
          ok: true,
          model: body.model,
          suggestions: [suggestion(3, { date: "2026-04-20", title: "棚卸し", startTime: "09:00" })],
          rejected: 0,
          usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_300_000, remainingAiTokens: 28_700_000, periodEnd: "2026-11-30T00:00:00Z" },
        },
      }),
    });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();

    // 使用量はAIトークンで表示し、円・ドルは出さない
    const usage = page.getByTestId("ai-usage");
    await expect(usage).toContainText("AIトークン");
    await expect(usage).toContainText("2026/11/30");
    await expect(usage).not.toContainText(/円|\$|USD/);

    // 初期状態: 日付・予定・開始・終了の4列だけ（備考は選ばれていない）
    await expect(page.getByTestId("ai-col-4")).not.toBeChecked();
    await expect(page.getByTestId("ai-preview-count")).toContainText("送る行：3行 ／ 送る列：4列");
    await expect(page.getByTestId("ai-preview")).not.toContainText("倉庫");

    // 行を1つ除外する（5行目）
    await page.getByTestId("ai-row-5").uncheck();
    await expect(page.getByTestId("ai-preview-count")).toContainText("送る行：2行");

    // 同意するまで実行できない
    await expect(page.getByTestId("ai-run")).toBeDisabled();
    await page.getByTestId("ai-consent").check();
    await expect(page.getByTestId("ai-run")).toBeEnabled();
    await page.getByTestId("ai-run").click();
    await expect(page.getByTestId("ai-results")).toBeVisible();

    expect(rec.assistBodies).toHaveLength(1);
    const body = rec.assistBodies[0] as { rows: { row: number; cells: string[] }[]; headers: string[]; consent: unknown; model: string; rangeStart: string; rangeEnd: string };
    expect(body.consent).toEqual({ accepted: true, version: CONSENT_VERSION });
    expect(body.model).toBe("standard");
    expect(body.rows.map((r) => r.row)).toEqual([3, 4]);
    expect(body.headers).toHaveLength(4);
    expect(body.rows[0].cells).toEqual(["四月二十日", "棚卸し", "09:00", ""]);
    expect(JSON.stringify(body)).not.toContain("社外秘のメモ");
    expect(JSON.stringify(body)).not.toContain("入社式");
    expect(JSON.stringify(body)).not.toContain("倉庫");
    expect(body.rangeStart).toBe("2026-04-01");
    expect(body.rangeEnd).toBe("2027-03-31");

    // 実行後は同意が外れる（毎回確認する）
    await expect(page.getByTestId("ai-consent")).not.toBeChecked();
    await expect(page.getByTestId("ai-run")).toBeDisabled();
    // 更新された使用量が表示される
    await expect(page.getByTestId("ai-usage")).toContainText("130万");
  });

  test("列を追加して送れる。追加した列だけ内容に含まれる", async ({ page }) => {
    const rec = await mockAi(page, { assist: (b) => ({ status: 200, body: { ok: true, model: b.model, suggestions: [], rejected: 0 } }) });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await page.getByTestId("ai-col-4").check();
    await expect(page.getByTestId("ai-preview")).toContainText("倉庫");
    await expect(page.getByTestId("ai-preview")).not.toContainText("社外秘のメモ"); // 送る行（読み取れなかった行）ではない
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();
    await expect(page.getByTestId("ai-results")).toBeVisible();
    expect((rec.assistBodies[0] as { headers: string[] }).headers).toHaveLength(5);
  });

  test("推測した日付・確度が低い提案は、目立たせて最初は採用に入れない。直して採用するとカレンダーに載る", async ({ page }) => {
    await mockAi(page, {
      assist: (body) => ({
        status: 200,
        body: {
          ok: true,
          model: body.model,
          suggestions: [
            suggestion(3, { date: "2026-04-20", title: "棚卸し", startTime: "09:00", confidence: "high", inferred: false }),
            suggestion(4, { date: "2026-05-07", title: "全体会議", confidence: "medium", inferred: true, note: "年が書かれていないため、対象年度から2026年と推測しました" }),
            suggestion(5, { date: null, title: null, confidence: "low", note: "読み取れませんでした" }),
          ],
          rejected: 1,
        },
      }),
    });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();

    const results = page.getByTestId("ai-result");
    await expect(results).toHaveCount(3);
    await expect(page.getByTestId("ai-results")).toContainText("捨てました");
    const row3 = page.locator('[data-testid="ai-result"][data-row="3"]');
    const row4 = page.locator('[data-testid="ai-result"][data-row="4"]');
    const row5 = page.locator('[data-testid="ai-result"][data-row="5"]');
    await expect(row3.getByTestId("ai-badge-inferred")).toHaveCount(0);
    await expect(row3.getByTestId("ai-result-adopt")).toBeChecked();
    await expect(row4.getByTestId("ai-badge-inferred")).toBeVisible();
    await expect(row4.getByTestId("ai-note")).toContainText("推測");
    await expect(row4.getByTestId("ai-result-adopt")).not.toBeChecked();
    await expect(row5.getByTestId("ai-badge-problem")).toContainText("日付を入力");
    await expect(row5.getByTestId("ai-result-adopt")).toBeDisabled();

    // 推測した日付は、利用者が確認して直してから採用できる
    await row4.getByTestId("ai-edit-date").fill("2026-05-11");
    await row4.getByTestId("ai-result-adopt").check();
    await page.getByTestId("ai-adopt").click();

    await expect(page.getByTestId("ai-adopted")).toContainText("2件");
    const preview = page.getByTestId("calendar-preview").first();
    await expect(preview.locator('[data-date="2026-04-20"]')).toContainText("棚卸し");
    await page.getByRole("button", { name: "5月", exact: true }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-05-11"]')).toContainText("全体会議");
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-05-07"]')).not.toContainText("全体会議");

    // 採用を取り消すと、カレンダーから消える
    await page.getByTestId("ai-adopted-remove").first().click();
    await expect(page.getByTestId("ai-adopted-item")).toHaveCount(1);
  });

  test("対象年度外の日付は採用できない", async ({ page }) => {
    await mockAi(page, {
      assist: (body) => ({ status: 200, body: { ok: true, model: body.model, suggestions: [suggestion(3, { date: "2028-04-20", title: "棚卸し" })], rejected: 0 } }),
    });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();
    const row3 = page.locator('[data-testid="ai-result"][data-row="3"]');
    await expect(row3.getByTestId("ai-badge-problem")).toContainText("対象年度外");
    await expect(page.getByTestId("ai-adopt")).toBeDisabled();
  });

  test("AIが失敗しても、メッセージを示すだけで、通常の読み取り・カレンダー作成は続けられる", async ({ page }) => {
    await mockAi(page, { assist: () => ({ status: 504, body: { error: "ai_unknown", message: "AIの応答に時間がかかりすぎたため、読み取りを中止しました。通常の読み取り結果はそのまま使えます。" } }) });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();
    await expect(page.getByTestId("ai-error")).toContainText("時間がかかりすぎた");
    await expect(page.getByTestId("ai-results")).toHaveCount(0);
    await expect(page.getByTestId("ai-consent")).not.toBeChecked();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-04-01"]')).toContainText("入社式");
    // AIが失敗しても、通常どおりExcelを作成してダウンロードできる
    await page.getByRole("button", { name: /Excelを作成/ }).first().click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件");
  });

  test("標準で読めなかった行は、高精度で再確認できる。同意はあらためて確認する", async ({ page }) => {
    const rec = await mockAi(page, {
      assist: (body) =>
        body.model === "standard"
          ? { status: 200, body: { ok: true, model: "standard", suggestions: [suggestion(3, { date: "2026-04-20", title: "棚卸し" }), suggestion(4, { date: null, title: "全体会議", confidence: "low" })], rejected: 0 } }
          : { status: 200, body: { ok: true, model: "advanced", suggestions: [suggestion(4, { date: "2026-05-07", title: "全体会議", confidence: "medium", inferred: true })], rejected: 0 } },
    });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();
    await expect(page.getByTestId("ai-results")).toBeVisible();

    await page.getByTestId("ai-rerun-advanced").click();
    await expect(page.getByTestId("ai-tier-advanced")).toBeChecked();
    await expect(page.getByTestId("ai-consent")).not.toBeChecked();
    await expect(page.getByTestId("ai-run")).toBeDisabled();
    await expect(page.getByTestId("ai-preview-count")).toContainText("送る行：1行");
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();
    await expect(page.locator('[data-testid="ai-result"][data-row="4"]').getByTestId("ai-badge-inferred")).toBeVisible();

    expect(rec.assistBodies).toHaveLength(2);
    expect(rec.assistBodies[1].model).toBe("advanced");
    expect((rec.assistBodies[1] as { rows: { row: number }[] }).rows.map((r) => r.row)).toEqual([4]);
    // 前回の結果（3行目）は残る
    await expect(page.locator('[data-testid="ai-result"][data-row="3"]')).toBeVisible();
  });

  test("列の割り当てを変えると、採用したAIの提案は破棄される（行の意味が変わるため）", async ({ page }) => {
    await mockAi(page, {
      assist: (body) => ({ status: 200, body: { ok: true, model: body.model, suggestions: [suggestion(3, { date: "2026-04-20", title: "棚卸し" })], rejected: 0 } }),
    });
    await openTool(page);
    await loadFile(page, ROWS());
    await page.getByTestId("ai-open").click();
    await page.getByTestId("ai-consent").check();
    await page.getByTestId("ai-run").click();
    await page.getByTestId("ai-adopt").click();
    await expect(page.getByTestId("ai-adopted-item")).toHaveCount(1);
    await page.getByTestId("events-mapping").locator("summary").click();
    await page.getByTestId("events-col-end").selectOption("4");
    await expect(page.getByTestId("ai-adopted-item")).toHaveCount(0);
  });
});
