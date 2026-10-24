import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { NetworkRecorder } from "../helpers/network-guard";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { CONSENT_VERSION } from "@/lib/ai/calendar-assist";

/**
 * 年度カレンダー作成: 予定表の取り込み（ドラッグ&ドロップ・PDF・画像・スキャンPDF・確認と修正）のE2Eテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAI・Stripe・Supabaseには接続しない。
 * 実際のAIが画像をどう読み取るか・消費するトークンは、このテストでは確認できない。
 */

const SLUG = "/tools/fiscal-calendar";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_000, remainingAiTokens: 29_999_000, periodEnd: "2026-11-30T00:00:00Z" } };

async function openTool(page: Page) {
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
    return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
  });
  await page.getByLabel("年度", { exact: true }).selectOption("2026");
}

interface TestFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** ブラウザのcanvasで、文字の入った画像（PNG）を作る */
async function makePng(page: Page, text = "4/6(月) 入学式"): Promise<Buffer> {
  const base64 = await page.evaluate((t) => {
    const c = document.createElement("canvas");
    c.width = 1400;
    c.height = 900;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000";
    ctx.font = "48px sans-serif";
    ctx.fillText(t, 80, 160);
    return c.toDataURL("image/png").split(",")[1];
  }, text);
  return Buffer.from(base64, "base64");
}

/** 文字情報のない（画像だけの）PDF＝スキャンしたPDFの代わり */
async function scannedPdf(png: Buffer, pages: number): Promise<TestFile> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawImage(img, { x: 20, y: 400, width: 555, height: 357 });
  }
  return { name: "スキャン.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

/** 文字情報のあるPDF（表）。標準フォントで書けるよう、英数字だけの表にする */
async function textPdf(): Promise<TestFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const rows = [
    ["Date", "Event", "Start"],
    ["2026/04/06", "Entrance ceremony", "10:00"],
    ["2026/04/07", "Opening day", "09:00"],
    ["2026/05/11", "Parents meeting", "14:00"],
    ["2026/06/15", "Sports day", "08:30"],
  ];
  rows.forEach((r, i) => {
    page.drawText(r[0], { x: 50, y: 760 - i * 30, size: 12, font });
    page.drawText(r[1], { x: 200, y: 760 - i * 30, size: 12, font });
    page.drawText(r[2], { x: 400, y: 760 - i * 30, size: 12, font });
  });
  return { name: "行事予定.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}


/** 月ごとの列に、日・曜日・予定が縦に並ぶ行事予定表（学校の年間行事予定表の形式）のPDF。2027年1〜3月と、翌年度の4月 */
async function monthlyPdf(): Promise<TestFile> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(process.cwd(), "public/fonts/NotoSansJP-Regular.ttf")), { subset: true });
  const page = doc.addPage([842, 595]);
  const cols = [
    { x: 58, year: 2027, month: 1, events: { 1: ["「元日」"], 5: ["教育相談再開", "入試願書受付開始"], 8: ["始業式 追認考査"], 25: ["学年末考査①"] } as Record<number, string[]> },
    { x: 210, year: 2027, month: 2, events: { 3: ["教科会 成績等入力"], 26: ["卒業証書授与式"] } as Record<number, string[]> },
    { x: 361, year: 2027, month: 3, events: { 19: ["修了式"] } as Record<number, string[]> },
    { x: 514, year: 2027, month: 4, events: { 9: ["入学式"] } as Record<number, string[]> },
  ];
  const week = "日月火水木金土";
  for (const c of cols) {
    page.drawText(`${c.month}月`, { x: c.x + 66, y: 499, size: 7, font });
    const days = new Date(Date.UTC(c.year, c.month, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const y = 486 - (d - 1) * 12.5;
      page.drawText(String(d), { x: c.x, y, size: 7, font });
      page.drawText(week[new Date(Date.UTC(c.year, c.month - 1, d)).getUTCDay()], { x: c.x + 8, y, size: 7, font });
      (c.events[d] ?? []).forEach((text, i) => page.drawText(text, { x: c.x + 18 + i * 60, y, size: 7, font }));
    }
  }
  return { name: "行事予定表.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

async function xlsxFile(rows: unknown[][], name = "予定表.xlsx"): Promise<TestFile> {
  const blob = await writeXlsxSheets([{ name: "予定表", rows }]);
  return { name, mimeType: XLSX_MIME, buffer: Buffer.from(await blob.arrayBuffer()) };
}

/** ファイルをドロップ領域へドロップする（ブラウザの実際のドラッグ&ドロップのイベントを発生させる） */
async function drop(page: Page, files: TestFile[]) {
  await page.evaluate(
    ({ files }) => {
      const dt = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
      }
      const el = document.querySelector('[data-testid="events-dropzone"]')!;
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.buffer.toString("base64") })) },
  );
}

interface Recorded {
  usageCalls: number;
  assistBodies: Record<string, unknown>[];
}

async function mockAi(
  page: Page,
  opts: { usage?: unknown; delayMs?: number; assist?: (body: Record<string, unknown>) => { status: number; body: unknown } } = {},
): Promise<Recorded> {
  const rec: Recorded = { usageCalls: 0, assistBodies: [] };
  await page.route("**/api/ai/usage", async (route: Route) => {
    rec.usageCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.usage ?? USAGE_OK) });
  });
  await page.route("**/api/ai/calendar-assist", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    rec.assistBodies.push(body);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const r = opts.assist?.(body) ?? { status: 500, body: { error: "x", message: "テスト用のエラー" } };
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  return rec;
}

const sug = (row: number, over: Record<string, unknown>) => ({
  row,
  date: null,
  title: null,
  startTime: null,
  endTime: null,
  confidence: "high",
  inferred: false,
  note: "",
  sourceText: "",
  page: 1,
  weekday: null,
  ...over,
});

const okAssist = (suggestions: unknown[]) => () => ({ status: 200, body: { ok: true, model: "standard", mode: "image", source: "image", suggestions, rejected: 0, usage: USAGE_OK.usage } });

const STANDARD_RESULT = [
  sug(1, { date: "2026-04-06", title: "入学式", startTime: "10:00", weekday: "月", sourceText: "4/6(月) 入学式" }), // 確実: 最初から反映の候補
  sug(2, { date: "2026-05-11", title: "保護者会", confidence: "medium", inferred: true, note: "年が書かれていないため、2026年としました", sourceText: "5/11 保護者会" }), // 推測: 候補にしない
  sug(3, { date: "2026-06-16", title: "運動会", weekday: "月", sourceText: "6/16(月) 運動会" }), // 曜日が合わない(2026-06-16は火曜): 候補にしない
  sug(4, { date: "2027-05-01", title: "年度外の行事", sourceText: "2027/5/1 年度外の行事" }), // 年度外: 反映できない
];

async function chooseImageAndReach(page: Page, rec?: Recorded) {
  await page.getByTestId("events-file").setInputFiles({ name: "予定表.png", mimeType: "image/png", buffer: await makePng(page) });
  await expect(page.getByTestId("image-assist")).toBeVisible({ timeout: 30_000 });
  void rec;
}

async function consentAndRun(page: Page) {
  await page.getByTestId("image-consent").check();
  await page.getByTestId("image-run").click();
}

test.describe("予定表の取り込み: ドラッグ&ドロップ・ファイルの種類", () => {
  test("ドロップ領域が見え、ドラッグ中は表示が変わる。ファイルを選ぶボタンもある", async ({ page }) => {
    await openTool(page);
    await expect(page.getByTestId("events-dropzone")).toBeVisible();
    await expect(page.getByTestId("events-drop-label")).toContainText("ドラッグ＆ドロップ");
    await expect(page.getByRole("button", { name: "ファイルを選ぶ", exact: true })).toBeVisible();
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="events-dropzone"]')!;
      el.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    });
    await expect(page.getByTestId("events-dropzone")).toHaveAttribute("data-dragging", "true");
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="events-dropzone"]')!;
      el.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }));
    });
    await expect(page.getByTestId("events-dropzone")).toHaveAttribute("data-dragging", "false");
  });

  test("Excelをドロップして読み込める。ファイル名が出て、別のファイルを選ぶ・取り消すができる", async ({ page }) => {
    await openTool(page);
    await drop(page, [await xlsxFile([["日付", "予定"], [new Date(Date.UTC(2026, 3, 6)), "入学式"], [new Date(Date.UTC(2026, 3, 7)), "始業式"]])]);
    await expect(page.getByTestId("events-count-recognized")).toContainText("2件", { timeout: 30_000 });
    await expect(page.getByTestId("events-file-name")).toHaveText("予定表.xlsx");
    // 別のファイルに替える（選ぶボタンの文言が変わる）
    await expect(page.getByRole("button", { name: "別のファイルを選ぶ", exact: true })).toBeVisible();
    await page.getByTestId("events-file").setInputFiles(await xlsxFile([["日付", "予定"], [new Date(Date.UTC(2026, 3, 8)), "遠足"]], "新しい予定表.xlsx"));
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件", { timeout: 30_000 });
    await expect(page.getByTestId("events-file-name")).toHaveText("新しい予定表.xlsx");
    await page.getByTestId("events-clear").click();
    await expect(page.getByTestId("events-summary")).toHaveCount(0);
  });

  test("CSV（ボタンで選ぶ・ドロップ）も、Excelと同じように読み込める", async ({ page }) => {
    await openTool(page);
    const csv = Buffer.from("日付,予定,開始時刻\n2026/04/06,入学式,10:00\n2026/04/07,始業式,\n四月十日,棚卸し,\n", "utf-8");
    await drop(page, [{ name: "予定.csv", mimeType: "text/csv", buffer: csv }]);
    await expect(page.getByTestId("events-count-recognized")).toContainText("2件", { timeout: 30_000 });
    await expect(page.getByTestId("events-count-baddate")).toContainText("1件");
    await page.getByTestId("events-clear").click();
    await page.getByTestId("events-file").setInputFiles({ name: "予定.csv", mimeType: "text/csv", buffer: csv });
    await expect(page.getByTestId("events-count-recognized")).toContainText("2件", { timeout: 30_000 });
  });

  test("対応していない形式は、分かりやすく断る。AIも呼ばれず、読み込み済みの予定は残る", async ({ page }) => {
    const rec = await mockAi(page);
    await openTool(page);
    await drop(page, [await xlsxFile([["日付", "予定"], [new Date(Date.UTC(2026, 3, 6)), "入学式"]])]);
    await expect(page.getByTestId("events-summary")).toBeVisible({ timeout: 30_000 });
    const bad: TestFile[] = [
      { name: "メモ.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
      { name: "資料.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("x") },
      { name: "写真.heic", mimeType: "image/heic", buffer: Buffer.from("x") },
      { name: "写真.webp", mimeType: "image/webp", buffer: Buffer.from("x") },
    ];
    for (const f of bad) {
      await drop(page, [f]);
      await expect(page.getByTestId("events-file-error"), f.name).toContainText("対応していません");
    }
    await drop(page, [{ name: "古い.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("x") }]);
    await expect(page.getByTestId("events-file-error")).toContainText(".xlsx");
    // 複数ファイル（Excelと画像など）は一度に読めない
    await drop(page, [await xlsxFile([["日付", "予定"]], "a.xlsx"), { name: "b.png", mimeType: "image/png", buffer: await makePng(page) }]);
    await expect(page.getByTestId("events-file-error")).toContainText("一度に選べる");
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件");
    expect(rec.assistBodies).toHaveLength(0);
    expect(rec.usageCalls).toBe(0);
  });

  test("壊れたPDF・壊れた画像は、エラーを示して、画面は使い続けられる", async ({ page }) => {
    await openTool(page);
    await drop(page, [{ name: "壊れた.pdf", mimeType: "application/pdf", buffer: Buffer.from("これはPDFではありません") }]);
    await expect(page.getByTestId("events-file-error")).toContainText("読み込みに失敗", { timeout: 30_000 });
    await drop(page, [{ name: "壊れた.png", mimeType: "image/png", buffer: Buffer.from("これはPNGではありません") }]);
    await expect(page.getByTestId("events-file-error")).toContainText("画像として読み込めません", { timeout: 30_000 });
    await expect(page.getByTestId("events-busy")).toHaveCount(0);
    // その後も、普通のファイルを読み込める
    await drop(page, [await xlsxFile([["日付", "予定"], [new Date(Date.UTC(2026, 3, 6)), "入学式"]])]);
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件", { timeout: 30_000 });
  });
});

test.describe("予定表の取り込み: 文字のPDF", () => {
  test("文字情報のあるPDFは、ブラウザの中だけで表を読み取る（AIは呼ばない・何も送信しない）。結果はExcelと同じ流れ", async ({ page }) => {
    const rec = await mockAi(page);
    const recorder = new NetworkRecorder(page);
    await openTool(page);
    await drop(page, [await textPdf()]);
    await expect(page.getByTestId("events-source-note")).toContainText("PDFの文字情報から表を読み取りました", { timeout: 60_000 });
    await expect(page.getByTestId("events-count-recognized")).toContainText("4件");
    await expect(page.getByTestId("events-count-inyear")).toContainText("4件");
    await expect(page.getByTestId("events-file-name")).toHaveText("行事予定.pdf");
    // 既存の予定プレビュー・生成にそのまま使える
    const preview = page.getByTestId("calendar-preview").first();
    await expect(preview.locator('[data-date="2026-04-06"]')).toContainText("Entrance ceremony");
    expect(rec.assistBodies).toHaveLength(0);
    expect(rec.usageCalls).toBe(0);
    const origin = new URL(page.url()).origin;
    // 開発サーバー自身のエラー表示用の通信(/__nextjs...)を除き、POSTなどの送信は1つもない
    expect(recorder.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD" && !new URL(r.url).pathname.startsWith("/__nextjs"))).toEqual([]);
    expect(recorder.requests.filter((r) => !r.url.startsWith(origin) && r.method !== "GET")).toEqual([]);
  });


  test("月ごとの列に日・曜日・予定が並ぶ行事予定表のPDFは、AIを使わず、曜日から年を決めて予定にする。年度外の月は配置されない", async ({ page }) => {
    const rec = await mockAi(page);
    await openTool(page);
    await drop(page, [await monthlyPdf()]);
    await expect(page.getByTestId("events-source-note")).toContainText("月ごとに日・曜日・予定が並ぶ行事予定表", { timeout: 90_000 });
    await expect(page.getByTestId("events-source-note")).toContainText("曜日に合う年");
    // 2027年1〜3月は対象年度(2026年度)内、2027年4月は翌年度なので対象年度外。「元日」は祝日なので読み取らない
    await expect(page.getByTestId("events-count-recognized")).toContainText("8件");
    await expect(page.getByTestId("events-count-inyear")).toContainText("7件");
    await expect(page.getByTestId("events-count-outyear")).toContainText("1件");
    const preview = page.getByTestId("calendar-preview").first();
    await page.getByRole("button", { name: "1月", exact: true }).click();
    const jan = page.getByTestId("calendar-preview").first();
    await expect(jan.locator('[data-date="2027-01-05"]')).toContainText("教育相談再開");
    await expect(jan.locator('[data-date="2027-01-05"]')).toContainText("入試願書受付開始");
    await expect(jan.locator('[data-date="2027-01-08"]')).toContainText("始業式 追認考査");
    await expect(jan.locator('[data-date="2027-01-25"]')).toContainText("学年末考査①");
    void preview;
    await page.getByRole("button", { name: "3月", exact: true }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2027-03-19"]')).toContainText("修了式");
    expect(rec.assistBodies).toHaveLength(0);
    expect(rec.usageCalls).toBe(0);
  });

  test("文字として読めたPDFも、うまくいかなければ、画像としてAIで読み取り直せる（同意の前は何も送らない）", async ({ page }) => {
    const rec = await mockAi(page);
    await openTool(page);
    await drop(page, [await textPdf()]);
    await expect(page.getByTestId("events-count-recognized")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("events-pdf-as-image").click();
    await expect(page.getByTestId("image-assist")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("image-thumb")).toHaveCount(1);
    expect(rec.assistBodies).toHaveLength(0);
  });
});

test.describe("予定表の取り込み: 画像・スキャンPDF（AIで読み取り、確認・修正してから反映）", () => {
  test("画像: 選ぶだけでは何も送られない。送る画像を見せ、同意するまで実行できない。結果を確認・修正して反映できる", async ({ page }) => {
    const rec = await mockAi(page, { assist: okAssist(STANDARD_RESULT) });
    const recorder = new NetworkRecorder(page);
    await openTool(page);
    await chooseImageAndReach(page);

    // 選んだだけでは、AIは呼ばれない。送る画像と、送るものの説明が出る
    expect(rec.assistBodies).toHaveLength(0);
    await expect(page.getByTestId("events-pending-name")).toHaveText("予定表.png");
    await expect(page.getByTestId("image-thumb")).toHaveCount(1);
    await expect(page.getByTestId("image-send-count")).toContainText("送る画像：1枚");
    await expect(page.getByTestId("image-assist")).toContainText("元のファイルそのものは送りません");
    await expect(page.getByTestId("ai-usage")).toContainText("残り");
    await expect(page.getByTestId("image-run")).toBeDisabled();
    await page.getByTestId("image-consent").check();
    await expect(page.getByTestId("image-run")).toBeEnabled();
    await page.getByTestId("image-run").click();

    await expect(page.getByTestId("image-results")).toBeVisible();
    // 送られたのは、画像（縮小したJPEG）・対象年度・モデル・同意だけ
    expect(rec.assistBodies).toHaveLength(1);
    const sent = rec.assistBodies[0] as { mode: string; source: string; model: string; rangeStart: string; consent: unknown; images: { mediaType: string; base64: string }[]; rows?: unknown };
    expect(sent.mode).toBe("image");
    expect(sent.source).toBe("image");
    expect(sent.model).toBe("standard");
    expect(sent.rangeStart).toBe("2026-04-01");
    expect(sent.consent).toEqual({ accepted: true, version: CONSENT_VERSION });
    expect(sent.rows).toBeUndefined();
    expect(sent.images).toHaveLength(1);
    expect(sent.images[0].mediaType).toBe("image/jpeg");
    expect(sent.images[0].base64.startsWith("/9j/")).toBe(true); // JPEGの先頭。元のPNGそのものではない
    expect(sent.images[0].base64.length * 0.75).toBeLessThan(750_000);
    // 同意は毎回確認する（実行後に外れる）
    await expect(page.getByTestId("image-consent")).not.toBeChecked();

    // 結果: 確実なものだけが最初から反映の候補。推測・曜日の不一致・年度外は、目立たせ、候補にしない
    const results = page.getByTestId("image-result");
    await expect(results).toHaveCount(4);
    await expect(results.nth(0).getByTestId("image-result-adopt")).toBeChecked();
    await expect(results.nth(1).getByTestId("image-badge-inferred")).toBeVisible();
    await expect(results.nth(1).getByTestId("image-result-adopt")).not.toBeChecked();
    await expect(results.nth(2).getByTestId("image-badge-weekday")).toContainText("曜日が合いません");
    await expect(results.nth(2).getByTestId("image-result-adopt")).not.toBeChecked();
    await expect(results.nth(3).getByTestId("image-badge-problem")).toContainText("対象年度外");
    await expect(results.nth(3).getByTestId("image-result-adopt")).toBeDisabled();
    await expect(results.nth(0)).toContainText("画像上の文字：4/6(月) 入学式");
    await expect(page.getByTestId("image-apply")).toContainText("1件");

    // 修正する: 推測された日付を直して反映の対象にし、曜日の合わない日付を直す（警告が消える）
    await results.nth(1).getByTestId("image-edit-title").fill("保護者会（全体）");
    await results.nth(1).getByTestId("image-result-adopt").check();
    await results.nth(2).getByTestId("image-edit-date").fill("2026-06-15");
    await expect(results.nth(2).getByTestId("image-badge-weekday")).toHaveCount(0);
    await results.nth(2).getByTestId("image-result-adopt").check();
    await expect(page.getByTestId("image-apply")).toContainText("3件");
    await page.getByTestId("image-apply").click();

    // 既存の取り込みの流れに乗る: 件数・年度内外・注意が出て、プレビューに修正した内容が載る
    await expect(page.getByTestId("events-count-recognized")).toContainText("3件");
    await expect(page.getByTestId("events-count-inyear")).toContainText("3件");
    await expect(page.getByTestId("events-source-note")).toContainText("AIが画像から読み取った内容");
    await expect(page.getByTestId("events-pending")).toHaveCount(0);
    const preview = page.getByTestId("calendar-preview").first();
    await expect(preview.locator('[data-date="2026-04-06"]')).toContainText("10:00 入学式");
    await page.getByRole("button", { name: "5月", exact: true }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-05-11"]')).toContainText("保護者会（全体）");
    await page.getByRole("button", { name: "6月", exact: true }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-06-15"]')).toContainText("運動会");

    // 保存しない・余計に送らない: ブラウザの保存領域に画像は残らず、AIの呼び出しは1回だけ
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(stored).not.toContain("/9j/");
    expect(rec.assistBodies).toHaveLength(1);
    const origin = new URL(page.url()).origin;
    expect(recorder.requests.filter((r) => r.method === "POST" && !r.url.startsWith(origin))).toEqual([]);
  });

  test("スキャンPDF（文字情報なし）: ページを画像にして、AIで読み取る準備をする。送るのは先頭の4ページまで", async ({ page }) => {
    const rec = await mockAi(page, { assist: () => ({ status: 200, body: { ok: true, model: "standard", mode: "image", source: "scanned-pdf", suggestions: [sug(1, { date: "2026-04-06", title: "入学式", page: 2 })], rejected: 0, usage: USAGE_OK.usage } }) });
    await openTool(page);
    await drop(page, [await scannedPdf(await makePng(page), 6)]);
    await expect(page.getByTestId("image-assist")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("image-note")).toContainText("文字情報がありませんでした");
    await expect(page.getByTestId("image-note")).toContainText("先頭の4ページ（全6ページ）");
    await expect(page.getByTestId("image-thumb")).toHaveCount(4);
    await expect(page.getByTestId("image-send-count")).toContainText("送る画像：4枚");
    expect(rec.assistBodies).toHaveLength(0);
    await consentAndRun(page);
    await expect(page.getByTestId("image-results")).toBeVisible();
    const sent = rec.assistBodies[0] as { mode: string; source: string; images: { mediaType: string; base64: string }[] };
    expect(sent.mode).toBe("image");
    expect(sent.source).toBe("scanned-pdf");
    expect(sent.images).toHaveLength(4);
    for (const im of sent.images) {
      expect(im.mediaType).toBe("image/jpeg");
      expect(im.base64.startsWith("/9j/")).toBe(true);
    }
    // 画像が複数枚のときは、何枚目から読み取ったかを示す
    await expect(page.getByTestId("image-result").first()).toContainText("2枚目");
  });

  test("複数の画像（最大4枚）をまとめて選べる。5枚目以降は断る", async ({ page }) => {
    const rec = await mockAi(page, { assist: okAssist([]) });
    await openTool(page);
    const png = await makePng(page);
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i + 1}.png`, mimeType: "image/png", buffer: png }));
    await drop(page, files(5));
    await expect(page.getByTestId("events-file-error")).toContainText("4枚まで");
    await drop(page, files(3));
    await expect(page.getByTestId("image-thumb")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId("image-send-count")).toContainText("送る画像：3枚");
    await consentAndRun(page);
    await expect(page.getByTestId("image-empty")).toBeVisible();
    expect((rec.assistBodies[0] as { images: unknown[] }).images).toHaveLength(3);
  });

  test("二重実行の防止: 読み取り中は実行ボタンが無効で、連打してもAIの呼び出しは1回。進捗が出て、同意は外れる", async ({ page }) => {
    const rec = await mockAi(page, { delayMs: 1500, assist: okAssist([sug(1, { date: "2026-04-06", title: "入学式" })]) });
    await openTool(page);
    await chooseImageAndReach(page);
    await page.getByTestId("image-consent").check();
    await page.getByTestId("image-run").dblclick();
    await expect(page.getByTestId("image-progress")).toBeVisible();
    await expect(page.getByTestId("image-run")).toBeDisabled();
    await expect(page.getByTestId("image-cancel")).toBeVisible();
    await expect(page.getByTestId("image-results")).toBeVisible({ timeout: 15_000 });
    expect(rec.assistBodies).toHaveLength(1);
    await expect(page.getByTestId("image-progress")).toHaveCount(0);
    await expect(page.getByTestId("image-run")).toBeDisabled(); // 同意が外れたため、もう一度同意するまで実行できない
    // 2回目は、同意し直せば実行できる（別の依頼ID）
    await page.getByTestId("image-consent").check();
    await page.getByTestId("image-run").click();
    await expect.poll(() => rec.assistBodies.length, { timeout: 15_000 }).toBe(2);
    expect(rec.assistBodies[0].requestId).not.toBe(rec.assistBodies[1].requestId);
  });

  test("中止・取り消し: 読み取り中に中止できる。取り消すと選択した画像は消え、別のファイルに替えられる", async ({ page }) => {
    const rec = await mockAi(page, { delayMs: 5000, assist: okAssist([]) });
    await openTool(page);
    await chooseImageAndReach(page);
    await consentAndRun(page);
    await page.getByTestId("image-cancel").click();
    await expect(page.getByTestId("image-error")).toContainText("中止");
    await expect(page.getByTestId("image-progress")).toHaveCount(0);
    expect(rec.assistBodies).toHaveLength(1);
    await page.getByTestId("events-clear").click();
    await expect(page.getByTestId("events-pending")).toHaveCount(0);
    // 別のファイル（Excel）に替えられる
    await drop(page, [await xlsxFile([["日付", "予定"], [new Date(Date.UTC(2026, 3, 6)), "入学式"]])]);
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件", { timeout: 30_000 });
  });

  test("AIが失敗しても、メッセージを示すだけ。利用枠の不足・混雑・出力不正も同じ。Excelなど他の取り込みは続けられる", async ({ page }) => {
    let n = 0;
    const responses = [
      { status: 429, body: { error: "quota_exceeded", message: "今期のAI利用枠を使い切りました。次の更新日にリセットされます。" } },
      { status: 502, body: { error: "ai_invalid_output", message: "AIの出力の形式が正しくなかったため、結果を使えませんでした。" } },
      { status: 504, body: { error: "ai_unknown", message: "AIの応答に時間がかかりすぎたため、読み取りを中止しました。" } },
    ];
    await mockAi(page, { assist: () => responses[n++] });
    await openTool(page);
    await chooseImageAndReach(page);
    for (const r of responses) {
      await consentAndRun(page);
      await expect(page.getByTestId("image-error")).toContainText((r.body as { message: string }).message.slice(0, 10));
      await expect(page.getByTestId("image-run")).toBeDisabled();
    }
    await drop(page, [await xlsxFile([["日付", "予定"], [new Date(Date.UTC(2026, 3, 6)), "入学式"]])]);
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件", { timeout: 30_000 });
  });

  test("Premiumでない・ログインしていない・利用できないときは、理由を示し、AIの実行はできない（画像は送られない）", async ({ page }) => {
    for (const reason of ["not_premium", "login_required", "unavailable"] as const) {
      const rec = await mockAi(page, { usage: { available: false, reason } });
      await openTool(page);
      await chooseImageAndReach(page);
      await expect(page.getByTestId("ai-unavailable")).toBeVisible();
      if (reason === "not_premium") await expect(page.getByTestId("ai-upgrade-link")).toBeVisible();
      if (reason === "login_required") await expect(page.getByTestId("ai-login-link")).toBeVisible();
      await page.getByTestId("image-consent").check();
      await expect(page.getByTestId("image-run")).toBeDisabled();
      expect(rec.assistBodies, reason).toHaveLength(0);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("高精度を選ぶと、モデルの種類がそのまま依頼に入る", async ({ page }) => {
    const rec = await mockAi(page, { assist: okAssist([]) });
    await openTool(page);
    await chooseImageAndReach(page);
    await page.getByTestId("image-tier-advanced").check();
    await consentAndRun(page);
    await expect(page.getByTestId("image-empty")).toBeVisible();
    expect(rec.assistBodies[0].model).toBe("advanced");
  });

  test("スマートフォン幅でも、送る画像・結果の確認画面が横にはみ出さない", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockAi(page, { assist: okAssist(STANDARD_RESULT) });
    await openTool(page);
    await chooseImageAndReach(page);
    await consentAndRun(page);
    await expect(page.getByTestId("image-results")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("events-dropzone")).toBeVisible();
    await expect(page.getByRole("button", { name: "別のファイルを選ぶ", exact: true })).toBeVisible();
  });
});
