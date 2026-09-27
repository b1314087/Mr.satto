import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
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
  await generateStampFixtures();
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

  // 日本語PDFフィクスチャ（Phase 15: PDF記入・注釈の日本語まわりのテスト用。
  // アプリ本体と同じNoto Sans JP・subset:falseで埋め込む）
  const jp = await PDFDocument.create();
  jp.registerFontkit(fontkit);
  const jpFontBytes = fs.readFileSync(path.join(__dirname, "..", "public", "fonts", "NotoSansJP-Regular.ttf"));
  const jpFont = await jp.embedFont(jpFontBytes, { subset: false });
  const jpPage = jp.addPage([300, 400]);
  jpPage.drawText("日本語のテストPDF", { x: 20, y: 360, size: 14, font: jpFont, color: rgb(0, 0, 0) });
  fs.writeFileSync(fixtures.japanesePdf, await jp.save());

  // 横向き(landscape)PDFフィクスチャ（Phase 15: 座標変換の向き違いテスト用）
  const landscape = await PDFDocument.create();
  const landscapeFont = await landscape.embedFont(StandardFonts.Helvetica);
  const landscapePage = landscape.addPage([400, 300]); // 幅 > 高さ
  landscapePage.drawText("Mr.Satto test fixture - landscape", { x: 20, y: 260, size: 12, font: landscapeFont, color: rgb(0, 0, 0) });
  fs.writeFileSync(fixtures.landscapePdf, await landscape.save());
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

/**
 * Phase 16: 電子印鑑生成（印影取り込み）テスト用フィクスチャ生成。
 *
 * 実在の印鑑・個人情報は一切使用せず、すべてCanvasで合成した架空の
 * 「白地に赤い円」を印影に見立てた図形を使う。generateImages()と同じ
 * Chromiumのページ内Canvasで描画する方式を再利用し、新規依存は追加しない。
 */
async function generateStampFixtures() {
  const browser = await chromium.launch(launchOptions);
  try {
    // setContent()の使い回しによる状態残留を避けるため、図形ごとに
    // 新しいページを開いてCanvasを描画・書き出す。
    async function drawCanvasPng(size: number, script: string, mimeType: "image/png" | "image/jpeg" = "image/png", quality?: number) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      try {
        await page.setContent(
          `<html><body style="margin:0"><canvas id="c" width="${size}" height="${size}"></canvas><script>${script}</script></body></html>`
        );
        const dataUrl = await page.$eval(
          "#c",
          (el, args) => (el as HTMLCanvasElement).toDataURL(args.mimeType, args.quality),
          { mimeType, quality }
        );
        return Buffer.from(dataUrl.split(",")[1], "base64");
      } finally {
        await page.close();
      }
    }

    // 標準的な印影サンプル（白背景に赤い円、内側にも小さな模様）
    const stampScript = `
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 300, 300);
      ctx.strokeStyle = '#b7282e';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(150, 150, 110, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#b7282e';
      ctx.font = 'bold 90px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('印', 150, 158);
    `;
    fs.writeFileSync(fixtures.stampPng, await drawCanvasPng(300, stampScript, "image/png"));
    fs.writeFileSync(fixtures.stampJpg, await drawCanvasPng(300, stampScript, "image/jpeg", 0.92));

    // 小さい印影（大きな白背景の中に小さな赤い円のみ。自動トリミングの確認用）
    const smallScript = `
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 300, 300);
      ctx.fillStyle = '#b7282e';
      ctx.beginPath();
      ctx.arc(150, 150, 18, 0, Math.PI * 2);
      ctx.fill();
    `;
    fs.writeFileSync(fixtures.stampSmallPng, await drawCanvasPng(300, smallScript));

    // 背景が複雑な印影（グラデーション+模様の背景。完全分離を前提にしないテスト用）
    const complexScript = `
      const ctx = document.getElementById('c').getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 300, 300);
      grad.addColorStop(0, '#f5f0e6');
      grad.addColorStop(1, '#e2d9c4');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 300, 300);
      ctx.strokeStyle = 'rgba(120,110,90,0.25)';
      for (let i = 0; i < 300; i += 12) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 300);
        ctx.stroke();
      }
      ctx.strokeStyle = '#b7282e';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(150, 150, 100, 0, Math.PI * 2);
      ctx.stroke();
    `;
    fs.writeFileSync(fixtures.stampComplexBgPng, await drawCanvasPng(300, complexScript));

    // 大きめの画像（処理上限・パフォーマンスのエッジケース確認用）
    const largeScript = `
      const ctx = document.getElementById('c').getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1600, 1600);
      ctx.strokeStyle = '#b7282e';
      ctx.lineWidth = 40;
      ctx.beginPath();
      ctx.arc(800, 800, 600, 0, Math.PI * 2);
      ctx.stroke();
    `;
    fs.writeFileSync(fixtures.stampLargeImagePng, await drawCanvasPng(1600, largeScript));

    // 既に透明背景を持つPNG（背景を白で塗らず、円の外側はclearRectのまま=透明）。
    // 取り込みフローが「元から透明な画像」を扱っても壊れないことの確認用。
    const transparentScript = `
      const ctx = document.getElementById('c').getContext('2d');
      ctx.clearRect(0, 0, 300, 300);
      ctx.fillStyle = '#b7282e';
      ctx.beginPath();
      ctx.arc(150, 150, 100, 0, Math.PI * 2);
      ctx.fill();
    `;
    fs.writeFileSync(fixtures.stampTransparentPng, await drawCanvasPng(300, transparentScript));

    // 印影を含む複数ページPDF（1ページ目はテキストのみ、2ページ目に印影画像を埋め込み）
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page1 = pdf.addPage([300, 400]);
    page1.drawText("Mr.Satto test fixture - stamp doc page 1", { x: 20, y: 360, size: 12, font, color: rgb(0, 0, 0) });
    const page2 = pdf.addPage([300, 400]);
    const stampPngBytes = fs.readFileSync(fixtures.stampPng);
    const embeddedPng = await pdf.embedPng(stampPngBytes);
    page2.drawImage(embeddedPng, { x: 50, y: 150, width: 150, height: 150 });
    fs.writeFileSync(fixtures.stampPdf, await pdf.save());
  } finally {
    await browser.close();
  }
}
