import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { readXlsxSheet } from "../helpers/xlsx-inspect";

/**
 * ロードマップC 工程3：背景除去・CSV・Excel の重い処理を、画面とは別の処理（Worker）で行うテスト。
 * - Worker で処理した結果と、従来どおり画面側で処理した結果が同じこと（画素・セルの値・CSVの文字）
 * - Worker が使えない環境（__mrsattoNoWorker）では画面側で処理されること
 * - キャンセルしたら途中の結果を出さず、Worker が残らないこと
 */

let dir = "";
let photo = "";
let bigCsv = "";
let bigXlsx = "";

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "heavy-worker-"));
  photo = path.join(dir, "photo.png");
  // 人物の代わりに、模様のある物体（中央の円）と、なだらかな背景の画像
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "gradients=s=1600x1000:seed=7", "-f", "lavfi", "-i", "testsrc2=s=500x500", "-filter_complex", "[0][1]overlay=550:250", "-frames:v", "1", photo]);
  // 大きなCSV（3万行・日本語・引用符・改行・数値・日付・空欄）
  bigCsv = path.join(dir, "big.csv");
  const lines = ["番号,名前,日付,金額,メモ"];
  for (let i = 0; i < 30000; i++) {
    const memo = i % 97 === 0 ? `"改行\nあり,カンマ"` : i % 53 === 0 ? `"引用""符"` : i % 11 === 0 ? "" : `メモ${i}`;
    lines.push(`${i},名前${i}　さん,2026-11-${String((i % 28) + 1).padStart(2, "0")},${(i * 37) % 100000}.5,${memo}`);
  }
  fs.writeFileSync(bigCsv, lines.join("\r\n"), "utf8");
  bigXlsx = path.join(dir, "big.xlsx");
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * このサイトが作る Worker（turbopack-worker の名前で読み込まれる）の数。
 * Excelの部品の中で一時的に作られる Worker（blob:）は数えない
 */
function appWorkers(page: Page): number {
  return page.workers().filter((w) => w.url().includes("turbopack-worker")).length;
}

async function noWorker(page: Page) {
  await page.addInitScript(() => {
    (globalThis as unknown as { __mrsattoNoWorker: boolean }).__mrsattoNoWorker = true;
  });
}

/** ダウンロードしたPNGの画素（RGBA）を、ffmpeg で読み出す */
function pngPixels(file: string): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 64 * 1024 * 1024 });
}

async function removeBackground(page: Page, mode: "ai" | "color"): Promise<{ file: string; engine: string | null }> {
  await page.goto("/tools/background-remover");
  await uploadFixture(page, photo);
  await expect(page.getByTestId("bg-preview")).toBeVisible({ timeout: 30_000 });
  if (mode === "color") await page.getByRole("button", { name: /色を指定して消す/ }).click();
  const run = page.getByRole("button", { name: "背景を透明にする" });
  await expect(run).toBeEnabled({ timeout: 120_000 });
  await run.click();
  const download = await clickAndDownload(page, "ダウンロード");
  const file = path.join(dir, `${mode}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await download.saveAs(file);
  const engine = await page.getByTestId("bg-engine").getAttribute("data-engine").catch(() => null);
  return { file, engine };
}

test.describe("背景除去（Worker）", () => {
  test.setTimeout(240_000);

  for (const mode of ["ai", "color"] as const) {
    test(`${mode === "ai" ? "AI" : "色指定"}：Worker で処理した結果が、画面側で処理した結果と画素まで同じ`, async ({ page, browser, baseURL }) => {
      const w = await removeBackground(page, mode);
      expect(w.engine).toBe("worker");

      const ctx = await browser.newContext({ baseURL });
      const { setDevPlanOverride } = await import("../helpers/dev-plan");
      await setDevPlanOverride(ctx, "premium", baseURL!);
      const page2 = await ctx.newPage();
      await noWorker(page2);
      const m = await removeBackground(page2, mode);
      expect(m.engine).toBe("main");
      await ctx.close();

      const a = pngPixels(w.file);
      const b = pngPixels(m.file);
      expect(a.length).toBe(1600 * 1000 * 4);
      expect(a.equals(b)).toBe(true);
      // 透明な所・半透明な所・不透明な所が、どれもある（切り抜きが効いている）
      let clear = 0, half = 0, solid = 0;
      for (let i = 3; i < a.length; i += 4) {
        if (a[i] === 0) clear++;
        else if (a[i] === 255) solid++;
        else half++;
      }
      expect(clear).toBeGreaterThan(1000);
      expect(solid).toBeGreaterThan(1000);
      if (mode === "ai") expect(half).toBeGreaterThan(100);
    });
  }

  test("書き出しの途中でキャンセルすると、結果を出さず、背景除去の Worker が残らない", async ({ page }) => {
    const big = path.join(dir, "big24.jpg");
    if (!fs.existsSync(big)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=6000x4000", "-frames:v", "1", "-q:v", "4", big]);
    await page.goto("/tools/background-remover");
    await uploadFixture(page, big);
    await expect(page.getByTestId("bg-preview")).toBeVisible({ timeout: 30_000 });
    const run = page.getByRole("button", { name: "背景を透明にする" });
    await expect(run).toBeEnabled({ timeout: 120_000 });
    const before = appWorkers(page);
    expect(before).toBe(1); // プレビュー用の推論で作った、背景除去の Worker（AIのモデルを持っている）
    await run.click();
    await page.getByRole("button", { name: "キャンセル" }).click({ timeout: 10_000 });
    await expect(page.getByTestId("bg-canceled")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    // AIのモデルを持っていた Worker も含めて終了している（プレビュー用の推論で作った Worker の数より増えない）
    await expect.poll(() => appWorkers(page), { timeout: 10_000 }).toBe(0);
    // キャンセルのあとも、もう一度実行できる
    await run.click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 180_000 });
  });

  test("スライダーを続けて動かしても、最後の値のプレビューになり、エラーにならない", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/tools/background-remover");
    await uploadFixture(page, photo);
    await expect(page.getByRole("button", { name: "背景を透明にする" })).toBeEnabled({ timeout: 120_000 });
    const slider = page.getByRole("slider").first();
    for (const v of ["10", "90", "30", "70", "95"]) await slider.fill(v);
    await page.waitForTimeout(500);
    expect(await slider.inputValue()).toBe("95");
    expect(errors).toEqual([]);
  });
});

async function convertCsv(page: Page, file: string): Promise<{ out: string; workers: number }> {
  let workers = 0;
  page.on("worker", (w) => {
    if (w.url().includes("turbopack-worker")) workers++;
  });
  await page.goto("/tools/csv-to-excel");
  await uploadFixture(page, file);
  await page.getByRole("button", { name: "Excelに変換する", exact: true }).click();
  const download = await clickAndDownload(page, "ダウンロード");
  const out = path.join(dir, `out-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  await download.saveAs(out);
  return { out, workers };
}

test.describe("CSV・Excel（Worker）", () => {
  test.setTimeout(240_000);

  test("大きなCSV→Excel：Worker で変換し、画面側で変換したものとセルの値がすべて同じ。Worker は残らない", async ({ page, browser, baseURL }) => {
    const w = await convertCsv(page, bigCsv);
    expect(w.workers).toBeGreaterThan(0);
    await expect.poll(() => appWorkers(page), { timeout: 10_000 }).toBe(0);

    const ctx = await browser.newContext({ baseURL });
    const { setDevPlanOverride } = await import("../helpers/dev-plan");
    await setDevPlanOverride(ctx, "premium", baseURL!);
    const page2 = await ctx.newPage();
    await noWorker(page2);
    const m = await convertCsv(page2, bigCsv);
    expect(m.workers).toBe(0);
    await ctx.close();

    const a = await readXlsxSheet(w.out);
    const b = await readXlsxSheet(m.out);
    expect(a.rows.length).toBeGreaterThanOrEqual(30000);
    expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
    // 改行・カンマ・引用符を含むセルも、そのまま入っている
    const cells = a.rows.flat().map((c) => String(c ?? ""));
    expect(cells).toContain("改行\nあり,カンマ");
    expect(cells).toContain('引用"符');
    fs.copyFileSync(w.out, bigXlsx);
  });

  test("小さなCSVは、Worker を作らずに画面側で変換する（余計な手間をかけない）", async ({ page }) => {
    const small = path.join(dir, "small.csv");
    fs.writeFileSync(small, "a,b\n1,2\n", "utf8");
    const r = await convertCsv(page, small);
    expect(r.workers).toBe(0);
  });

  test("大きなExcel→CSV：Worker で読み取り、画面側で読み取ったものとCSVの文字がすべて同じ", async ({ page, browser, baseURL }) => {
    if (!fs.existsSync(bigXlsx)) {
      const w = await convertCsv(page, bigCsv);
      fs.copyFileSync(w.out, bigXlsx);
    }
    expect(fs.statSync(bigXlsx).size).toBeGreaterThan(512 * 1024);
    async function toCsv(p: Page): Promise<{ text: string; workers: number }> {
      let workers = 0;
      p.on("worker", (w) => {
        if (w.url().includes("turbopack-worker")) workers++;
      });
      await p.goto("/tools/excel-to-csv");
      await uploadFixture(p, bigXlsx);
      await p.getByRole("button", { name: /CSVに変換|変換する/ }).first().click();
      const download = await clickAndDownload(p, /ダウンロード/);
      const out = path.join(dir, `out-${Date.now()}.csv`);
      await download.saveAs(out);
      return { text: fs.readFileSync(out, "utf8"), workers };
    }
    const w = await toCsv(page);
    expect(w.workers).toBeGreaterThan(0);
    const ctx = await browser.newContext({ baseURL });
    const { setDevPlanOverride } = await import("../helpers/dev-plan");
    await setDevPlanOverride(ctx, "premium", baseURL!);
    const page2 = await ctx.newPage();
    await noWorker(page2);
    const m = await toCsv(page2);
    expect(m.workers).toBe(0);
    await ctx.close();
    expect(w.text).toBe(m.text);
    expect(w.text.split("\r\n").length).toBeGreaterThan(30000);
  });

  test("大きなCSVの変換をキャンセルすると、結果を出さず、Worker が残らない。もう一度変換できる", async ({ page }) => {
    const huge = path.join(dir, "huge.csv");
    if (!fs.existsSync(huge)) fs.writeFileSync(huge, Array.from({ length: 6 }, () => fs.readFileSync(bigCsv, "utf8")).join("\r\n"), "utf8");
    await page.goto("/tools/csv-to-excel");
    await uploadFixture(page, huge);
    await page.getByRole("button", { name: "Excelに変換する", exact: true }).click();
    await expect.poll(() => appWorkers(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(page.getByTestId("convert-canceled")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    await expect.poll(() => appWorkers(page), { timeout: 10_000 }).toBe(0);
    await page.getByRole("button", { name: "Excelに変換する", exact: true }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 180_000 });
  });

  test("壊れたExcelファイルは、Worker の中でも日本語のエラーになり、Worker が残らない", async ({ page }) => {
    const broken = path.join(dir, "broken.xlsx");
    fs.writeFileSync(broken, Buffer.alloc(700 * 1024, 7));
    await page.goto("/tools/excel-to-csv");
    await uploadFixture(page, broken);
    await page.getByRole("button", { name: /CSVに変換|変換する/ }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: "broken.xlsx の読み込みに失敗しました" }).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => appWorkers(page), { timeout: 10_000 }).toBe(0);
  });
});
