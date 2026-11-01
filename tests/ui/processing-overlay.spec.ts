import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { waitForFileInputHydrated } from "../helpers/tool-runner";

/**
 * 処理中の画面（src/components/common/processing-status.tsx・globals.css の .ms-busy-*）。全ツール共通。
 * 処理している間、画面全体を薄暗くし、中央のパネルの周りを光が周回する。後ろの画面は操作できない。
 * 中止できる処理では、パネルに中止のボタンが出る。動きを減らす設定では、光を回さない。
 */

let workDir = "";
test.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "busy-overlay-"));
});
test.afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** 写真のような大きな画像を2ページに入れたPDF（圧縮に少し時間がかかる） */
async function writePhotoPdf(page: Page): Promise<string> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2000;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 3000, 2000);
    g.addColorStop(0, "#3b82f6");
    g.addColorStop(1, "#10b981");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 3000, 2000);
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.35)`;
      ctx.beginPath();
      ctx.arc((i * 97) % 3000, (i * 61) % 2000, 4 + (i % 30), 0, Math.PI * 2);
      ctx.fill();
    }
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(Buffer.from(base64, "base64"));
  for (let i = 0; i < 2; i++) doc.addPage([595, 842]).drawImage(image, { x: 50, y: 300, width: 495, height: 330 });
  const file = path.join(workDir, "photo.pdf");
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function startCompress(page: Page) {
  await page.goto("/tools/pdf-compress");
  const src = await writePhotoPdf(page);
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(src);
  const run = page.getByRole("button", { name: "圧縮する" });
  await expect(run).toBeEnabled({ timeout: 20_000 });
  await run.click();
}

test.describe("処理中の画面", () => {
  test("処理中は画面全体が薄暗くなり、中央のパネルの周りを光が回る。後ろの画面は操作できず、終わると消える", async ({ page }) => {
    await startCompress(page);
    const overlay = page.getByTestId("busy-overlay");
    const panel = page.getByTestId("busy-panel");
    await expect(overlay).toBeVisible();
    // 目標のサイズに合わせている間は、何回目かをパネルに出す
    await expect(panel).toContainText(/目標のサイズに合わせて調整しています…（\d回目／最大6回）/);
    await expect(panel.getByRole("status")).toBeVisible();

    // 画面全体を覆い、薄暗くしている
    const cover = await overlay.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return { w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, bg: st.backgroundColor, position: st.position };
    });
    expect(cover.position).toBe("fixed");
    // 縦のスクロールバーの幅（最大20px程度）を除いた、画面いっぱいを覆う
    expect(cover.w).toBeGreaterThanOrEqual(cover.vw - 20);
    expect(cover.h).toBeGreaterThanOrEqual(cover.vh - 20);
    expect(cover.bg).toMatch(/rgba\(6, 12, 26, 0\.55\)/);

    // パネルの縁の光が、回り続けている
    const glow = await panel.evaluate((el) => {
      const st = getComputedStyle(el, "::after");
      return { name: st.animationName, iteration: st.animationIterationCount, content: st.content };
    });
    expect(glow.name).toBe("ms-busy-orbit");
    expect(glow.iteration).toBe("infinite");

    // 後ろの画面（目標のサイズの欄）は、処理中は押せない
    const blocked = await page
      .getByTestId("compress-target-mb")
      .click({ timeout: 1_000, trial: true })
      .then(() => false)
      .catch(() => true);
    expect(blocked).toBe(true);

    // 終わると消え、完了の表示になる
    await expect(page.getByTestId("compress-result")).toBeVisible({ timeout: 60_000 });
    await expect(overlay).toHaveCount(0);
  });

  test("動きを減らす設定では、光を回さず、縁に固定の光を出す", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await startCompress(page);
    const panel = page.getByTestId("busy-panel");
    await expect(panel).toBeVisible();
    const glow = await panel.evaluate((el) => getComputedStyle(el, "::after").animationName);
    expect(glow).toBe("none");
    await expect(page.getByTestId("compress-result")).toBeVisible({ timeout: 60_000 });
  });

  test("中止できる処理（年度カレンダーの予定の読み込み）は、パネルの中止のボタンで止められる", async ({ page }) => {
    await page.goto("/tools/fiscal-calendar");
    await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
      return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
    });
    // 文字のPDF（たくさんのページ）。読み込みに時間がかかる間に、中止する
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 80; i++) doc.addPage([595, 842]).drawText(`2026/4/${(i % 28) + 1} Event ${i}`, { x: 50, y: 790, size: 12, font });
    await page.getByTestId("events-file").setInputFiles({ name: "予定.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) });

    const cancel = page.getByTestId("busy-panel").getByTestId("events-clear");
    await expect(cancel).toHaveText("読み込みを中止する");
    await cancel.click();
    await expect(page.getByTestId("busy-overlay")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("events-count-recognized")).toHaveCount(0);
  });

  test("別の処理（予定の読み込み）が終わったあと、処理していない表示まで処理中の画面に残らず、そのまま操作できる", async ({ page }) => {
    await page.goto("/tools/fiscal-calendar");
    await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
    await page.waitForFunction(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
      return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
    });
    const csv = Buffer.from("日付,予定\n2026/4/6,入学式\n", "utf8");
    await page.getByTestId("events-file").setInputFiles({ name: "予定.csv", mimeType: "text/csv", buffer: csv });
    await expect(page.getByTestId("events-count-recognized")).toContainText("1件", { timeout: 30_000 });
    // 読み込みの処理中の画面は、0.6秒ほどで消える。カレンダー本体の表示が「処理中」のまま残らない
    await expect(page.getByTestId("busy-overlay")).toHaveCount(0, { timeout: 3_000 });
    await page.getByRole("button", { name: /Excelを作成/ }).first().click({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
  });
});
