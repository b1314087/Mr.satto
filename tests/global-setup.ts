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
import {
  TEMPLATE_PAGE,
  TEMPLATE_FIELDS,
  THREE_PERSON_TEMPLATE_FIELDS,
  FIELD_LABEL_TEXT,
  PERSON_A,
  PERSON_B,
  PERSON_C,
  PERSON_D,
  SCANNED_TEMPLATE_FIELDS,
  SCANNED_TEMPLATE_FIELDS_PERSON2,
  SCANNED_PERSON_A,
  SCANNED_PERSON_B,
  type DummyPerson,
  type TemplateFieldSpec,
} from "./fixtures/template-layout";

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
  await generateTemplateFixtures();
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

/**
 * Phase 18: 記入されたPDF→Excel「テンプレートモード」テスト用フィクスチャ生成。
 *
 * 実在の人物・個人情報は一切使用しない（tests/fixtures/template-layout.ts に
 * まとめた架空のダミーデータのみ）。座標定義をテスト本体（テンプレート編集画面で
 * 入力枠のX/Y/幅/高さを数値入力する箇所）と共有することで、フィクスチャの
 * 実際の印字位置とテストが登録する入力枠がずれないようにしている。
 *
 * 1人目の「氏名」だけは、印字ラベル「氏名：」を枠の内側に含む位置にしている
 * （開発指示書16章の固定文字除外の検証用）。
 */
async function generateTemplateFixtures() {
  const jpFontBytes = fs.readFileSync(path.join(__dirname, "..", "public", "fonts", "NotoSansJP-Regular.ttf"));

  async function newTemplateDoc() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(jpFontBytes, { subset: false });
    return { doc, font };
  }

  function drawLabelsAndBoxes(
    page: Awaited<ReturnType<PDFDocument["addPage"]>>,
    font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
    fields: TemplateFieldSpec[] = TEMPLATE_FIELDS
  ) {
    for (const field of fields) {
      const labelText = FIELD_LABEL_TEXT[field.label];
      // 枠がラベルを内包する項目(person1の氏名)はラベルを枠の左端(x)から描き、
      // それ以外は枠の外側(x=40)にラベルを置く「素直な」レイアウトにする。
      const labelX = field.x <= 41 ? field.x : 40;
      page.drawText(labelText, { x: labelX, y: field.y + 5, size: 12, font, color: rgb(0.15, 0.15, 0.15) });
      page.drawRectangle({
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        borderColor: rgb(0.5, 0.5, 0.5),
        borderWidth: 1,
      });
    }
  }

  function valueXFor(field: TemplateFieldSpec, font: Awaited<ReturnType<PDFDocument["embedFont"]>>): number {
    if (field.x <= 41) {
      const labelWidth = font.widthOfTextAtSize(FIELD_LABEL_TEXT[field.label], 12);
      return field.x + labelWidth + 4;
    }
    return field.x + 4;
  }

  function drawPersonValues(
    page: Awaited<ReturnType<PDFDocument["addPage"]>>,
    font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
    personIndex: number,
    person: DummyPerson,
    fields: TemplateFieldSpec[] = TEMPLATE_FIELDS
  ) {
    for (const field of fields.filter((f) => f.personIndex === personIndex)) {
      const value = person[field.label as keyof DummyPerson];
      const x = valueXFor(field, font);
      page.drawText(value, { x, y: field.y + 5, size: 11, font, color: rgb(0, 0, 0) });
    }
  }

  // 1. 空のテンプレートPDF（ラベルと枠の罫線のみ、入力値はなし）
  {
    const { doc, font } = await newTemplateDoc();
    const page = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    drawLabelsAndBoxes(page, font);
    fs.writeFileSync(fixtures.templateBlankPdf, await doc.save());
  }

  // 2. 記入済み（2人ともフル入力、テキストレイヤーあり）
  {
    const { doc, font } = await newTemplateDoc();
    const page = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    drawLabelsAndBoxes(page, font);
    drawPersonValues(page, font, 1, PERSON_A);
    drawPersonValues(page, font, 2, PERSON_B);
    fs.writeFileSync(fixtures.templateFilledPdf, await doc.save());
  }

  // 3. 2人目が空欄（人物存在判定・除外設定の検証用）
  {
    const { doc, font } = await newTemplateDoc();
    const page = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    drawLabelsAndBoxes(page, font);
    drawPersonValues(page, font, 1, PERSON_A);
    fs.writeFileSync(fixtures.templateFilledEmptySecondPdf, await doc.save());
  }

  // 4. 複数ページ（同一レイアウトを2ページへ適用。合計4人分）
  {
    const { doc, font } = await newTemplateDoc();
    const page1 = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    drawLabelsAndBoxes(page1, font);
    drawPersonValues(page1, font, 1, PERSON_A);
    drawPersonValues(page1, font, 2, PERSON_B);
    const page2 = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    drawLabelsAndBoxes(page2, font);
    drawPersonValues(page2, font, 1, PERSON_C);
    drawPersonValues(page2, font, 2, PERSON_D);
    fs.writeFileSync(fixtures.templateFilledMultiPagePdf, await doc.save());
  }

  // 5. 1ページに3人分（「1ページ3人」ケースの検証用。開発指示書44章）
  {
    const { doc, font } = await newTemplateDoc();
    const page = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    drawLabelsAndBoxes(page, font, THREE_PERSON_TEMPLATE_FIELDS);
    drawPersonValues(page, font, 1, PERSON_A, THREE_PERSON_TEMPLATE_FIELDS);
    drawPersonValues(page, font, 2, PERSON_B, THREE_PERSON_TEMPLATE_FIELDS);
    drawPersonValues(page, font, 3, PERSON_C, THREE_PERSON_TEMPLATE_FIELDS);
    fs.writeFileSync(fixtures.templateFilledThreePersonPdf, await doc.save());
  }

  // 6. スキャン画像（文字レイヤーを持たない、OCRフォールバック検証用）
  await generateScannedTemplateFixture();
}

/**
 * OCRフォールバック（開発指示書17・18章）検証用の、文字レイヤーを持たない
 * スキャン画像PDF。認識精度を安定させるため、内容は英数字のみにしている
 * （日本語OCRの精度検証自体は目的ではなく、あくまで「テキストレイヤーが
 * 無いページでOCR経路が正しく動くこと」の検証が目的のため）。
 *
 * 「記入済み」だけでなく「空のテンプレート」も同じレイアウトで生成する。
 * テンプレート確認時の固定文字取得（captureFixedTextForTemplate、開発指示書16章）は
 * 必ずユーザーが最初に登録した空のテンプレートPDF自身に対してOCRを行う仕様のため、
 * テストでも実際のアプリの使い方と同じく「空のテンプレートPDFを登録 → 記入済み
 * スキャンPDFを処理」という2つの別ファイルを用意する（同じファイルを両方に使うと、
 * 固定文字として値まで丸ごと取り込んでしまい、正しい検証にならないため）。
 */
async function generateScannedTemplateFixture() {
  const allFields = [...SCANNED_TEMPLATE_FIELDS, ...SCANNED_TEMPLATE_FIELDS_PERSON2];
  const personValues: Record<number, Record<string, string>> = { 1: SCANNED_PERSON_A, 2: SCANNED_PERSON_B };

  await renderScannedFieldsToPdf(allFields, (f) => `${f.label}: ${personValues[f.personIndex][f.label]}`, fixtures.templateFilledScannedPdf);
  // 空のテンプレート側は、記入欄の枠とラベル（末尾の":"まで）だけを描画し、値は一切含めない。
  await renderScannedFieldsToPdf(allFields, (f) => `${f.label}:`, fixtures.templateBlankScannedPdf);
}

async function renderScannedFieldsToPdf(fields: TemplateFieldSpec[], textForField: (field: TemplateFieldSpec) => string, outputPath: string) {
  const scale = 2;
  const w = Math.round(TEMPLATE_PAGE.width * scale);
  const h = Math.round(TEMPLATE_PAGE.height * scale);

  const drawCommands = fields
    .map((f) => {
      const left = Math.round(f.x * scale);
      const top = Math.round((TEMPLATE_PAGE.height - f.y - f.height) * scale);
      const width = Math.round(f.width * scale);
      const height = Math.round(f.height * scale);
      const text = textForField(f);
      const baselineY = top + Math.round(height * 0.68);
      return `
        ctx.strokeStyle = '#888888';
        ctx.lineWidth = 1;
        ctx.strokeRect(${left}, ${top}, ${width}, ${height});
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 22px sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(${JSON.stringify(text)}, ${left + 6}, ${baselineY});
      `;
    })
    .join("\n");

  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(
      `<html><body style="margin:0"><canvas id="c" width="${w}" height="${h}"></canvas>
       <script>
         const ctx = document.getElementById('c').getContext('2d');
         ctx.fillStyle = '#ffffff';
         ctx.fillRect(0, 0, ${w}, ${h});
         ${drawCommands}
       </script></body></html>`
    );
    const dataUrl = await page.$eval("#c", (el) => (el as HTMLCanvasElement).toDataURL("image/png"));
    const pngBytes = Buffer.from(dataUrl.split(",")[1], "base64");

    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([TEMPLATE_PAGE.width, TEMPLATE_PAGE.height]);
    const embedded = await doc.embedPng(pngBytes);
    pdfPage.drawImage(embedded, { x: 0, y: 0, width: TEMPLATE_PAGE.width, height: TEMPLATE_PAGE.height });
    fs.writeFileSync(outputPath, await doc.save());
  } finally {
    await browser.close();
  }
}
