import fs from "node:fs";
import { chromium } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import writeExcelFile from "write-excel-file/node";
import { zipSync, strToU8 } from "fflate";
import { fixtures } from "./fixtures/paths";
import { tools } from "@/lib/tools/data";
import { categories } from "@/lib/tools/categories";

/**
 * Phase 14: テスト用バイナリフィクスチャの生成（global setup）。
 *
 * - 実データ・個人情報は一切使用しない。すべて合成データ。
 * - 新しい依存パッケージは追加しない。既存の依存関係（pdf-lib / write-excel-file /
 *   fflate / @playwright/test 自体が使うChromium）だけでPDF・XLSX・ZIP・PNG・JPG・
 *   WebM動画を生成する。
 * - 生成物は tests/fixtures/generated/ に書き出し、.gitignore で除外する
 *   （テスト実行のたびに作り直す使い捨てフィクスチャのため）。
 */
// playwright.config.ts と同じ理由（サンドボックス環境の事前導入Chromiumの
// リビジョンずれ対策）で、指定されていれば実行ファイルパスを明示する。
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
  : undefined;

export default async function globalSetup() {
  fs.mkdirSync(fixtures.dir.generated, { recursive: true });

  await Promise.all([generatePdfs(), generateXlsx(), generateZip(), generateImages(), generateVideo()]);
  await warmupRoutes();
}

/**
 * `next dev`（Turbopack）はルートごとに初回アクセス時にオンデマンドで
 * コンパイルするため、テスト本体（複数workerによる並列アクセス）が
 * 「初回コンパイル待ち」で不安定・タイムアウトになるのを避けるために、
 * テスト対象になりうる全ルートへ事前に軽くアクセスしてコンパイルを
 * 済ませておく（実際のアサーションは行わない。あくまでウォームアップ）。
 */
async function warmupRoutes() {
  const port = process.env.PLAYWRIGHT_TEST_PORT ?? "3100";
  const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${port}`;

  const staticRoutes = ["/", "/tools", "/pricing", "/about", "/contact", "/terms", "/privacy"];
  const categoryRoutes = categories.map((c) => `/tools/${c.id}`);
  const toolRoutes = tools.map((t) => `/tools/${t.id}`);
  const routes = Array.from(new Set([...staticRoutes, ...categoryRoutes, ...toolRoutes]));

  const CONCURRENCY = 4;
  let index = 0;
  async function worker() {
    while (index < routes.length) {
      const route = routes[index];
      index += 1;
      try {
        const res = await fetch(`${baseURL}${route}`, { signal: AbortSignal.timeout(60_000) });
        await res.arrayBuffer();
      } catch {
        // ウォームアップは失敗しても致命的ではない（該当ルートは本番テストで
        // 通常どおりタイムアウト込みで検証される）。ここでは握りつぶす。
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

async function generatePdfs() {
  // 1ページのみのPDF（pdf-split等の「単純なケース」用）
  const single = await PDFDocument.create();
  const font = await single.embedFont(StandardFonts.Helvetica);
  const page1 = single.addPage([300, 400]);
  page1.drawText("Mr.Satto test fixture - page 1", { x: 20, y: 360, size: 12, font, color: rgb(0, 0, 0) });
  fs.writeFileSync(fixtures.singlePagePdf, await single.save());

  // 3ページのPDF（pdf-merge/pdf-split/pdf-to-image/pdf-to-text等の共通フィクスチャ）
  const multi = await PDFDocument.create();
  const multiFont = await multi.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i += 1) {
    const page = multi.addPage([300, 400]);
    page.drawText(`Mr.Satto test fixture - page ${i}`, { x: 20, y: 360, size: 12, font: multiFont, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(fixtures.multiPagePdf, await multi.save());
}

async function generateXlsx() {
  const sheetData = [
    ["id", "name", "quantity", "price"],
    [1, "テスト商品A", 2, 1000],
    [2, "テスト商品B", 5, 2500],
    [3, "テスト商品C", 1, 500],
  ];
  await writeExcelFile(sheetData).toFile(fixtures.xlsx);
}

async function generateZip() {
  const files = {
    "sample.csv": strToU8(fs.readFileSync(fixtures.csv, "utf8")),
    "sample.json": strToU8(fs.readFileSync(fixtures.json, "utf8")),
  };
  const zipped = zipSync(files, { level: 6 });
  fs.writeFileSync(fixtures.zip, zipped);
}

async function generateImages() {
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    await page.setContent(
      `<html><body style="margin:0"><canvas id="c" width="64" height="64"></canvas>
       <script>
         const ctx = document.getElementById('c').getContext('2d');
         ctx.fillStyle = '#1d4ed8';
         ctx.fillRect(0, 0, 64, 64);
         ctx.fillStyle = '#ffffff';
         ctx.fillRect(16, 16, 32, 32);
       </script></body></html>`
    );
    const pngDataUrl = await page.$eval("#c", (el) => (el as HTMLCanvasElement).toDataURL("image/png"));
    const jpgDataUrl = await page.$eval("#c", (el) => (el as HTMLCanvasElement).toDataURL("image/jpeg", 0.9));
    fs.writeFileSync(fixtures.png, Buffer.from(pngDataUrl.split(",")[1], "base64"));
    fs.writeFileSync(fixtures.jpg, Buffer.from(jpgDataUrl.split(",")[1], "base64"));
  } finally {
    await browser.close();
  }
}

async function generateVideo() {
  // Playwright標準の動画録画機能（内部でffmpegを使用、追加依存なし）を使って
  // ごく短いWebM動画を合成する。video-thumbnail等のテストで使う。
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext({
      recordVideo: { dir: fixtures.dir.generated, size: { width: 160, height: 120 } },
    });
    const page = await context.newPage();
    await page.setContent(
      `<html><body style="margin:0;background:#1d4ed8"><div style="width:160px;height:120px;background:#ffffff"></div></body></html>`
    );
    await page.waitForTimeout(600);
    const video = page.video();
    await context.close();
    if (video) {
      const generatedPath = await video.path();
      fs.renameSync(generatedPath, fixtures.webm);
    }
  } finally {
    await browser.close();
  }
}
