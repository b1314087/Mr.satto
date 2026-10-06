import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import writeExcelFile from "write-excel-file/node";
import { zipSync, strToU8 } from "fflate";
import { fixtures } from "./fixtures/paths";
import { buildMinimalXlsx, type XlsxSheetSpec, type XlsxCellSpec } from "./fixtures/xlsx-writer";
import { buildMinimalDocx, type DocxDocumentSpec, type DocxParagraphSpec } from "./fixtures/docx-writer";
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
  CHECKBOX_PAGE,
  CHECKBOX_TEMPLATE_FIELDS,
  CHECKBOX_PERSON_NAME,
  ADJACENT_PAGE,
  ADJACENT_TEMPLATE_FIELDS,
  ADJACENT_PERSON,
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

  await Promise.all([
    generatePdfs(),
    generateXlsx(),
    generateZip(),
    generateImages(),
    generateVideo(),
    generateVideoWithMetadata(),
  ]);
  await generateStampFixtures();
  await generateTemplateFixtures();
  await generateCheckboxAndAdjacentTemplateFixtures();
  generateExcelToPdfFixtures();
  generateWordToPdfFixtures();
  await generatePdfToExcelFixtures();
  await generatePdfToWordScannedFixture();
  await generatePdfToExcelScannedFixtures();
  await generateLightweightToolsFixtures();
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

  const staticRoutes = ["/", "/tools", "/pricing", "/about", "/terms", "/privacy", "/auth/forgot-password"];
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

    // Step 4: 証明写真サイズ変換テスト用の横長(landscape)画像。
    const landscapePage = await browser.newPage({ viewport: { width: 300, height: 200 } });
    await landscapePage.setContent(
      `<html><body style="margin:0"><canvas id="c" width="300" height="200"></canvas>
       <script>
         const ctx = document.getElementById('c').getContext('2d');
         ctx.fillStyle = '#1d4ed8';
         ctx.fillRect(0, 0, 300, 200);
         ctx.fillStyle = '#ffffff';
         ctx.beginPath();
         ctx.arc(150, 100, 60, 0, Math.PI * 2);
         ctx.fill();
       </script></body></html>`
    );
    const landscapeDataUrl = await landscapePage.$eval("#c", (el) =>
      (el as HTMLCanvasElement).toDataURL("image/jpeg", 0.9)
    );
    fs.writeFileSync(fixtures.landscapeJpg, Buffer.from(landscapeDataUrl.split(",")[1], "base64"));

    // Step 5: 画像結合テスト用の縦長(portrait)画像。sample.png(64x64)・
    // landscapeJpg(300x200)とサイズ・向きが異なる画像を混在させて結合結果を確認する。
    const portraitPage = await browser.newPage({ viewport: { width: 120, height: 200 } });
    await portraitPage.setContent(
      `<html><body style="margin:0"><canvas id="c" width="120" height="200"></canvas>
       <script>
         const ctx = document.getElementById('c').getContext('2d');
         ctx.fillStyle = '#16a34a';
         ctx.fillRect(0, 0, 120, 200);
         ctx.fillStyle = '#ffffff';
         ctx.fillRect(30, 60, 60, 80);
       </script></body></html>`
    );
    const portraitDataUrl = await portraitPage.$eval("#c", (el) =>
      (el as HTMLCanvasElement).toDataURL("image/png")
    );
    fs.writeFileSync(fixtures.portraitPng, Buffer.from(portraitDataUrl.split(",")[1], "base64"));

    // 破損ファイル（拡張子は.pngだが中身が不正なバイト列）の異常系テスト用。
    // 実在の画像形式を装わない、明らかに無効なバイト列にする。
    fs.writeFileSync(fixtures.corruptedImage, Buffer.from("not a valid png file", "utf-8"));
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
 * 動画メタデータ削除ツール検証用フィクスチャ。
 *
 * システムにインストール済みのffmpeg（Playwrightの動画録画機能が内部で
 * 使っているものと同一。新規依存は追加しない）を直接呼び出し、タイトル・
 * 作成者・コメント（位置情報を模したダミー座標を含む文字列）を明示的に
 * 埋め込んだ短いMP4を生成する。実在の人物・位置情報は一切使用しない。
 *
 * これにより、video-metadata-removeツールのE2Eテストで「処理後に
 * これらのメタデータタグが実際に消えている」ことをffprobeで検証できる
 * （ボタンを押せたかどうかだけでなく、実際の効果を確認する方針）。
 */
async function generateVideoWithMetadata() {
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x120:d=1:r=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-metadata",
      "title=TestTitle",
      "-metadata",
      "artist=TestArtist",
      "-metadata",
      "comment=TestComment 35.6895,139.6917",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      fixtures.videoWithMetadataMp4,
    ],
    { stdio: "ignore" }
  );
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
 * Phase 18.2: checkbox枠（A-19）・隣接Field分離（A-11/A-12）テスト用フィクスチャ。
 *
 * checkbox枠は、空のテンプレート側は罫線の四角だけ（記入なし）、記入済み側は
 * 「チェックあり」（四角の内側を黒く塗りつぶす）と「チェックなし」（四角のみ、
 * 記入なしのまま）の2種類を用意する。塗りつぶし量・黒画素割合で判定する
 * ルールベース判定（checkbox-detection.ts）を、文字認識ではなく実際に
 * 「黒く塗られているかどうか」で検証できるようにするため。
 *
 * 隣接Fieldは、2つのtext枠を隙間なく横に並べ、各枠の値をその境界のすぐ内側まで
 * 印字することで、「1つのtext itemが片方の枠だけに正しく割り当てられるか」
 * （矩形の重なり面積ベースの判定、A-11/A-12）を検証する。
 */
async function generateCheckboxAndAdjacentTemplateFixtures() {
  const jpFontBytes = fs.readFileSync(path.join(__dirname, "..", "public", "fonts", "NotoSansJP-Regular.ttf"));

  async function newDoc() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(jpFontBytes, { subset: false });
    return { doc, font };
  }

  const nameField = CHECKBOX_TEMPLATE_FIELDS[0];
  const checkboxField = CHECKBOX_TEMPLATE_FIELDS[1];

  function drawCheckboxLayout(
    page: Awaited<ReturnType<PDFDocument["addPage"]>>,
    font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
    opts: { withName: boolean; checked: boolean }
  ) {
    // 氏名欄（textフィールド）
    page.drawRectangle({
      x: nameField.x,
      y: nameField.y,
      width: nameField.width,
      height: nameField.height,
      borderColor: rgb(0.5, 0.5, 0.5),
      borderWidth: 1,
    });
    if (opts.withName) {
      page.drawText(CHECKBOX_PERSON_NAME, { x: nameField.x + 4, y: nameField.y + 5, size: 11, font, color: rgb(0, 0, 0) });
    }

    // 同意欄（checkboxフィールド）: 罫線の四角。チェックありの場合だけ内側を黒く塗りつぶす。
    page.drawRectangle({
      x: checkboxField.x,
      y: checkboxField.y,
      width: checkboxField.width,
      height: checkboxField.height,
      borderColor: rgb(0.2, 0.2, 0.2),
      borderWidth: 1.5,
    });
    if (opts.checked) {
      const inset = 5;
      page.drawRectangle({
        x: checkboxField.x + inset,
        y: checkboxField.y + inset,
        width: checkboxField.width - inset * 2,
        height: checkboxField.height - inset * 2,
        color: rgb(0, 0, 0),
      });
    }
  }

  // 1. 空のテンプレート（氏名・同意とも未記入）
  {
    const { doc, font } = await newDoc();
    const page = doc.addPage([CHECKBOX_PAGE.width, CHECKBOX_PAGE.height]);
    drawCheckboxLayout(page, font, { withName: false, checked: false });
    fs.writeFileSync(fixtures.templateBlankCheckboxPdf, await doc.save());
  }

  // 2. 記入済み・チェックあり
  {
    const { doc, font } = await newDoc();
    const page = doc.addPage([CHECKBOX_PAGE.width, CHECKBOX_PAGE.height]);
    drawCheckboxLayout(page, font, { withName: true, checked: true });
    fs.writeFileSync(fixtures.templateFilledCheckboxCheckedPdf, await doc.save());
  }

  // 3. 記入済み・チェックなし
  {
    const { doc, font } = await newDoc();
    const page = doc.addPage([CHECKBOX_PAGE.width, CHECKBOX_PAGE.height]);
    drawCheckboxLayout(page, font, { withName: true, checked: false });
    fs.writeFileSync(fixtures.templateFilledCheckboxUncheckedPdf, await doc.save());
  }

  // 4. 隣接Field: 空のテンプレート（枠線のみ）
  const [adjField1, adjField2] = ADJACENT_TEMPLATE_FIELDS;
  function drawAdjacentBoxes(page: Awaited<ReturnType<PDFDocument["addPage"]>>) {
    for (const field of ADJACENT_TEMPLATE_FIELDS) {
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
  {
    const { doc } = await newDoc();
    const page = doc.addPage([ADJACENT_PAGE.width, ADJACENT_PAGE.height]);
    drawAdjacentBoxes(page);
    fs.writeFileSync(fixtures.templateBlankAdjacentPdf, await doc.save());
  }

  // 5. 隣接Field: 記入済み（境界のすぐ内側まで文字を寄せて印字する）
  {
    const { doc, font } = await newDoc();
    const page = doc.addPage([ADJACENT_PAGE.width, ADJACENT_PAGE.height]);
    drawAdjacentBoxes(page);
    page.drawText(ADJACENT_PERSON.氏名, { x: adjField1.x + 4, y: adjField1.y + 6, size: 11, font, color: rgb(0, 0, 0) });
    page.drawText(ADJACENT_PERSON.住所, { x: adjField2.x + 4, y: adjField2.y + 6, size: 11, font, color: rgb(0, 0, 0) });
    fs.writeFileSync(fixtures.templateFilledAdjacentPdf, await doc.save());
  }
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

/**
 * Phase 18.2 B節: excel-to-pdf「Excelの印刷ページ=PDFのページ」テスト用フィクスチャ生成。
 *
 * write-excel-file（既存依存）は印刷範囲・ページ設定(Fit to Page/scale)・余白・
 * 非表示行列・改ページ・セル罫線を書き出せないため、tests/fixtures/xlsx-writer.ts の
 * 手組みXLSXビルダー（fflateのみ使用、新規依存なし）で、これらの印刷設定を
 * 直接埋め込んだ最小限のXLSXを生成する。実在の企業・個人データは一切使用しない。
 *
 * Fit to Width/Height を明示指定したケース(B-13)は、内容量に関わらず必ず
 * 指定ページ数になる(computePageGrid の splitIntoExactGroups による保証)ため、
 * セルの内容自体は「行数・列数が指定ページ数以上あること」だけを満たす
 * 単純なダミー値で十分（実際のフォント計測に依存しない、決定的なテスト）。
 */
function generateExcelToPdfFixtures() {
  function cell(value: string | number, border?: XlsxCellSpec["border"]): XlsxCellSpec {
    return { value, border };
  }

  function grid(rows: number, cols: number, labelPrefix = ""): (XlsxCellSpec | null)[][] {
    return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(`${labelPrefix}R${r}C${c}`)));
  }

  function write(path: string, sheets: XlsxSheetSpec[]) {
    fs.writeFileSync(path, buildMinimalXlsx(sheets));
  }

  // Test1(B-20): A4/横向き/Fit to Width 1 × Fit to Height 1 → 必ず1ページ
  // (内容量だけでは複数ページになりうる量を用意し、それでも1ページになることを確認する)
  write(fixtures.excelFit1x1Xlsx, [
    {
      name: "Sheet1",
      rows: grid(15, 6, "FIT1X1_"),
      paperSize: 9, // A4
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
    },
  ]);

  // Test2(B-20): Fit to Width 1 × Fit to Height 3 → 必ず3ページ(横1×縦3)
  write(fixtures.excelFit1x3Xlsx, [
    {
      name: "Sheet1",
      rows: grid(12, 4, "FIT1X3_"),
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 3,
    },
  ]);

  // Test3(B-20): Fit to Width 2 × Fit to Height 2 → 必ず4ページ(横2×縦2)
  write(fixtures.excelFit2x2Xlsx, [
    {
      name: "Sheet1",
      rows: grid(8, 8, "FIT2X2_"),
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 2,
      fitToHeight: 2,
    },
  ]);

  // Test4(B-20/K-2): 印刷範囲(Print Area)の外にあるデータはPDFに含まれてはならない
  {
    const rows: (XlsxCellSpec | null)[][] = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 6 }, (_, c) => (r <= 2 && c <= 2 ? cell(`INSIDE_R${r}C${c}`) : cell(`OUTSIDE_R${r}C${c}`)))
    );
    write(fixtures.excelPrintAreaXlsx, [
      { name: "Sheet1", rows, paperSize: 9, orientation: "portrait", printArea: "A1:C3" },
    ]);
  }

  // 非表示行・非表示列(B-16): 非表示に設定した行・列の内容はPDFに含まれてはならない
  {
    const rows: (XlsxCellSpec | null)[][] = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 4 }, (_, c) => {
        if (r === 1) return cell(`HIDDEN_ROW_TEXT_C${c}`);
        if (c === 2) return cell(`HIDDEN_COL_TEXT_R${r}`);
        return cell(`VISIBLE_TEXT_R${r}C${c}`);
      })
    );
    write(fixtures.excelHiddenXlsx, [
      { name: "Sheet1", rows, paperSize: 9, orientation: "portrait", hiddenRows: [1], hiddenCols: [2] },
    ]);
  }

  // 明示的な改ページ(B-15): 指定した行の直後で必ずページが分かれる
  write(fixtures.excelPageBreakXlsx, [
    {
      name: "Sheet1",
      rows: Array.from({ length: 6 }, (_, r) => [cell(`BREAK_ROW${r}`)]),
      paperSize: 9,
      orientation: "portrait",
      rowBreaksAfter: [2], // 3行目(0始まりで2)の直後で改ページ
    },
  ]);

  // セル罫線(B-6〜B-9): 実際に罫線が設定されているセル・辺だけを描画する
  // (2x2グリッド。セル(0,0)はbottom+right、セル(1,1)はtopのみ。合計3辺)
  write(fixtures.excelBorderPartialXlsx, [
    {
      name: "Sheet1",
      rows: [
        [cell("BORDER_A", { bottom: true, right: true }), cell("BORDER_B")],
        [cell("BORDER_C"), cell("BORDER_D", { top: true })],
      ],
      paperSize: 9,
      orientation: "portrait",
    },
  ]);

  // Gridlines(常に描画しない)・罫線なしの大きな表(B-7/B-21): 罫線情報が一切無ければ、
  // 表がどれだけ大きくても・複数ページにまたがっても、線は一切描画されない
  write(fixtures.excelBorderlessLargeXlsx, [
    {
      name: "Sheet1",
      rows: grid(20, 10, "NOBORDER_"),
      paperSize: 9,
      orientation: "portrait",
    },
  ]);

  // 用紙サイズ(B-10): A3・縦
  write(fixtures.excelPaperA3PortraitXlsx, [
    { name: "Sheet1", rows: grid(2, 2, "A3_"), paperSize: 8, orientation: "portrait" },
  ]);

  // 用紙サイズ(B-10): Letter・横
  write(fixtures.excelPaperLetterLandscapeXlsx, [
    { name: "Sheet1", rows: grid(2, 2, "LETTER_"), paperSize: 1, orientation: "landscape" },
  ]);

  // 余白(B-12): 明示的な余白設定(インチ)がPDFの描画開始位置に反映される
  write(fixtures.excelMarginsXlsx, [
    {
      name: "Sheet1",
      rows: [[cell("MARGIN_TEST")]],
      paperSize: 9,
      orientation: "portrait",
      margins: { left: 1.0, top: 1.2, right: 0.5, bottom: 0.5 },
    },
  ]);

  // シート名の非表示(B-9、Phase 22): シート名にわざと分かりやすい固有の文字列を
  // 付け、PDF側の抽出テキストにこのシート名が一切含まれない(Mr.Sattoが勝手に
  // ページ上部へシート名を追加しない)ことを検証する。
  write(fixtures.excelSheetNameXlsx, [
    {
      name: "SHEETNAME_MUST_NOT_APPEAR_IN_PDF",
      rows: [[cell("SHEETNAME_TEST_CELL_VALUE")]],
      paperSize: 9,
      orientation: "portrait",
    },
  ]);

  // ヘッダー/フッター(B-10、Phase 22): Excel側で実際に設定されている
  // ヘッダー/フッター(左/中央/右)がPDFへ反映される。&P/&Nのページ番号・
  // 総ページ数トークンも解決されることを、必ず2ページになるFit設定と
  // 組み合わせて検証する。
  write(fixtures.excelHeaderFooterXlsx, [
    {
      name: "Sheet1",
      rows: Array.from({ length: 4 }, (_, r) => [cell(`HF_ROW${r}`)]),
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 2,
      header: { left: "HF_HEADER_LEFT", center: "HF_HEADER_CENTER", right: "HF_HEADER_RIGHT" },
      footer: { left: "HF_FOOTER_PAGE_&P", center: "HF_FOOTER_CENTER", right: "HF_FOOTER_TOTAL_&N" },
    },
  ]);
}

/** 1x1の赤色透過なしPNG(テスト専用の合成データ、実在の画像は一切使用しない)。
 *  Phase 18.2 C節(word-to-pdf)の画像埋め込みテスト用。 */
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Phase 18.2 C節: word-to-pdf「Wordの印刷ページ=PDFのページ」テスト用フィクスチャ生成。
 *
 * mammoth(既存依存)はDOCXの内容(見出し・段落・書式・表・画像)はHTML化するが、
 * セクション区切り・用紙サイズ・余白・w:pageBreakBeforeによる改ページといった
 * 「ページ構造」の情報は読み捨てるため、これらを検証するにはword/document.xmlの
 * 中身を直接制御できるテスト用DOCXが必要になる。write-excel-file相当の既存DOCX
 * 生成ライブラリはこのプロジェクトに無いため、tests/fixtures/docx-writer.ts の
 * 手組みDOCXビルダー(fflateのみ使用、新規依存なし)で生成する。
 * 実在の企業・個人データは一切使用しない。
 */
function generateWordToPdfFixtures() {
  function write(path: string, spec: DocxDocumentSpec) {
    fs.writeFileSync(path, buildMinimalDocx(spec));
  }

  // 明示的な改ページ(w:br type="page"、C-9・C-14): 必ずその位置でページが分かれる
  write(fixtures.wordPageBreakDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "PAGEBREAK_TEST_PAGE1_TEXT" }] },
      { kind: "pagebreak" },
      { kind: "paragraph", runs: [{ text: "PAGEBREAK_TEST_PAGE2_TEXT" }] },
    ],
  });

  // 明示的な改ページ(w:pageBreakBefore、C-9): 段落プロパティによる改ページも同様に反映される
  write(fixtures.wordPageBreakBeforeDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "PBB_TEST_PAGE1_TEXT" }] },
      { kind: "paragraph", runs: [{ text: "PBB_TEST_PAGE2_TEXT" }], pageBreakBefore: true },
    ],
  });

  // 用紙サイズ・向き(C-3・C-4・C-14): A4横向き → PDFもA4横向きになる
  write(fixtures.wordLandscapeA4Docx, {
    blocks: [{ kind: "paragraph", runs: [{ text: "LANDSCAPE_TEST_TEXT" }] }],
    section: { orientation: "landscape" },
  });

  // 余白(C-8): 明示的な左余白がPDFの描画開始位置に反映される
  // (2.0inch = 2880twips。既定値56ptよりも明確に区別できる値にしている)
  write(fixtures.wordMarginsDocx, {
    blocks: [{ kind: "paragraph", runs: [{ text: "M" }] }],
    section: { marginsTwips: { left: 2880, top: 1417, right: 1417, bottom: 1417 } },
  });

  // 見出し・太字/斜体/下線・表・画像(C-6・C-7・C-10・C-12・C-13): 基本要素が保持される
  write(fixtures.wordRichContentDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "見出しRICH_HEADING_TEXT" }], heading: 1 },
      { kind: "paragraph", runs: [{ text: "RICH_BOLD_TEXT", bold: true }, { text: "RICH_ITALIC_TEXT", italic: true }, { text: "RICH_UNDERLINE_TEXT", underline: true }] },
      { kind: "table", rows: [["RICH_CELL_A1", "RICH_CELL_B1"], ["RICH_CELL_A2", "RICH_CELL_B2"]] },
      { kind: "image", pngBase64: TINY_PNG_BASE64, widthPt: 80, heightPt: 40 },
    ],
  });

  // 複数セクション(C-11): 現在の実装範囲(最初のセクションの用紙設定を全体に適用)を
  // 明示的に警告として伝える。1つ目のセクションはA4縦、2つ目はLegal横と、
  // 明確に異なる用紙設定にしている。
  write(fixtures.wordMultiSectionDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "SECTION1_TEXT" }] },
      {
        kind: "paragraph",
        runs: [{ text: "SECTION_BREAK_MARKER" }],
        sectionEnd: { pageWidthTwips: 11906, pageHeightTwips: 16838 }, // A4縦(セクション1の設定)
      },
      { kind: "paragraph", runs: [{ text: "SECTION2_TEXT" }] },
    ],
    section: { pageWidthTwips: 12240, pageHeightTwips: 15840, orientation: "landscape" }, // Legal横(セクション2=文書末尾の設定)
  });

  // 空白行・連続空行(Phase 22 C-2〜C-4): P・Q・R・Sをそれぞれ1文字だけの段落にし、
  // P-Q間は空行なし、Q-R間は空行1つ、R-S間は空行2つ、というように空行の数を
  // 変えて並べる(1文字にするのは、既存の余白テストと同じく
  // pdf.pages[0].items.find(it => it.str === "P") で個々の文字の実座標を
  // そのまま取得するため)。空行なし・空行1つ・空行2つの段落間隔が、
  // word-to-pdf.tsのresolveLineHeight()/resolveParagraphGap()が計算する
  // 1段落ぶんの間隔のちょうど1倍・2倍・3倍になるはずで(具体的な値は
  // tests/tools/word-to-pdf-phase22.spec.ts側のコメント参照)、これによって
  // 「空行が実際に1行分として積み増しされているか」をピクセル単位で検証できる。
  write(fixtures.wordBlankLinesDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "P" }] },
      { kind: "paragraph", runs: [{ text: "Q" }] },
      { kind: "paragraph", runs: [] },
      { kind: "paragraph", runs: [{ text: "R" }] },
      { kind: "paragraph", runs: [] },
      { kind: "paragraph", runs: [] },
      { kind: "paragraph", runs: [{ text: "S" }] },
    ],
  });

  // 外出先PC修正指示書§32-35: word-to-pdfのページ溢れ根本原因修正の回帰テスト。
  //
  // 修正前は行間(LINE_HEIGHT=15固定)・段落間隔(PARAGRAPH_GAP=6固定)が
  // Wordの実際の既定値(1行=フォントサイズの約1.15倍)より大きすぎたため、
  // 本来1ページに収まるはずの文書が2ページのPDFになってしまっていた。
  // 指示書が明示的に要求する5パターン(1ページ・文章のみ/1ページ+表/
  // 1ページ+画像/本当に2ページ/A4標準余白)を、いずれも明示的な改ページ
  // (w:br type="page"・w:pageBreakBefore)を使わずに用意する。段落数だけで
  // 自然にページが溢れるかどうかを見るのが目的のため。
  //
  // 段落数の計算根拠: このdocx-writer.tsはword/styles.xmlを一切出力しないため、
  // word-to-pdf.ts側はdefaultSpacingが取得できず、フォールバック値
  // (SINGLE_LINE_SPACING_FACTOR=1.15・PARAGRAPH_GAP=6)を使う。本文サイズ
  // BODY_SIZE=10.5ptなので、1段落(1行)あたりの専有高さは
  // 10.5*1.15+6=18.075pt(tests/tools/word-to-pdf-phase22.spec.tsの
  // PARAGRAPH_PITCH定数と同じ値)。A4縦(841.89pt)から既定余白(sectPrXmlの
  // 既定値1417twips=約70.85pt)を上下に引いた本文高さは
  // 841.89-70.85*2=700.19pt、700.19/18.075≈38.7段落で1ページ分となる。
  // 「明確に1ページに収まる」には少数(5段落)、「明確に2ページに溢れる」には
  // 余裕を持って50段落を使う。
  const shortTextParagraphs = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i): DocxParagraphSpec => ({ kind: "paragraph", runs: [{ text: `${prefix}_LINE_${i + 1}` }] }));

  // 1ページ(文章のみ、表・画像なし): 5段落だけの短い文書。標準A4縦・既定余白のまま
  // (§32-35が要求する「A4標準余白」の確認も、この最も単純なフィクスチャで兼ねる)。
  // word-to-pdf.tsは1文字ずつdrawTextを呼び出す実装のため(683行目付近のコメント
  // 参照)、pdfjs側のテキスト項目(items)も1文字単位になる。既存のword-margins
  // フィクスチャと同じく、余白位置を座標で確認したい先頭段落だけは単一文字"M"にする。
  write(fixtures.wordOnePageTextDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "M" }] },
      { kind: "paragraph", runs: [{ text: "OVERFLOW_ONEPAGE_TEXT_FIRST" }] },
      ...shortTextParagraphs(3, "OVERFLOW_ONEPAGE_TEXT"),
      { kind: "paragraph", runs: [{ text: "OVERFLOW_ONEPAGE_TEXT_LAST" }] },
    ],
  });

  // 1ページ+表: 短い文章のあとに小さな表(2行×2列)を1つ置いただけの文書。
  write(fixtures.wordOnePageWithTableDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "OVERFLOW_TABLE_INTRO_TEXT" }] },
      { kind: "table", rows: [["OVERFLOW_TABLE_A1", "OVERFLOW_TABLE_B1"], ["OVERFLOW_TABLE_A2", "OVERFLOW_TABLE_B2"]] },
      { kind: "paragraph", runs: [{ text: "OVERFLOW_TABLE_OUTRO_TEXT" }] },
    ],
  });

  // 1ページ+画像: 短い文章のあとに小さな画像を1つ置いただけの文書。
  write(fixtures.wordOnePageWithImageDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "OVERFLOW_IMAGE_INTRO_TEXT" }] },
      { kind: "image", pngBase64: TINY_PNG_BASE64, widthPt: 80, heightPt: 40 },
      { kind: "paragraph", runs: [{ text: "OVERFLOW_IMAGE_OUTRO_TEXT" }] },
    ],
  });

  // 本当に2ページの文書: 明示的な改ページを一切使わず、段落数だけで自然に
  // 2ページ目へ溢れることを確認する(50段落。上記コメントの計算根拠を参照)。
  write(fixtures.wordGenuineTwoPageDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "OVERFLOW_GENUINE_FIRST_TEXT" }] },
      ...shortTextParagraphs(48, "OVERFLOW_GENUINE"),
      { kind: "paragraph", runs: [{ text: "OVERFLOW_GENUINE_LAST_TEXT" }] },
    ],
  });
}

/**
 * 外出先PC修正指示書§21-26: pdf-to-excelの罫線検出テスト用フィクスチャ生成。
 *
 * 2列×3行(見出し+データ2行)の単純な表を、実際に線分(page.drawLine)で
 * 罫線を描画したPDFと、全く同じテキスト配置で罫線だけを描画していないPDFの
 * 2種類、対で生成する。罫線の位置は、pdf-to-excel.tsが実際に使う
 * table-reconstruction.ts の rowBoundariesY/colBoundariesX の計算式
 * (行境界=行間の中点、列境界=検出された列区切りの中点)に正確に合わせて
 * 計算する(フォントの実測幅を使い、目分量にしない)ことで、
 * 「本当に境界線の位置に線があるかどうか」を検出する実装を確実に検証できる
 * ようにしている。
 */
async function generatePdfToExcelFixtures() {
  const rows: [string, string][] = [
    ["Name", "Score"],
    ["Alice", "10"],
    ["Bob", "20"],
  ];
  const col1X = 50;
  const col2X = 180;
  const rowYs = [240, 190, 140];
  const fontSize = 11;

  async function build(withBorders: boolean, outputPath: string) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 300]);

    rows.forEach(([col1Text, col2Text], i) => {
      page.drawText(col1Text, { x: col1X, y: rowYs[i], size: fontSize, font, color: rgb(0, 0, 0) });
      page.drawText(col2Text, { x: col2X, y: rowYs[i], size: fontSize, font, color: rgb(0, 0, 0) });
    });

    if (withBorders) {
      // table-reconstruction.tsのrowBoundariesYと同じ式(行の中点。先頭行の上端・
      // 末尾行の下端はフォント高さの0.6倍ぶん外側)で、線を引く位置を計算する。
      const halfFont = fontSize * 0.6;
      const rowBoundaries = [
        rowYs[0] + halfFont,
        (rowYs[0] + rowYs[1]) / 2,
        (rowYs[1] + rowYs[2]) / 2,
        rowYs[2] - halfFont,
      ];
      // colBoundariesXと同じ式(列区切りは列間の空白の中点)で、実測した文字幅から
      // 列区切りの位置を計算する。
      const col1MaxRight = Math.max(...rows.map(([c1]) => col1X + font.widthOfTextAtSize(c1, fontSize)));
      const col2MinLeft = col2X;
      const colBreakX = (col1MaxRight + col2MinLeft) / 2;
      const leftX = col1X - 6;
      const rightX = col2X + Math.max(...rows.map(([, c2]) => font.widthOfTextAtSize(c2, fontSize))) + 6;

      for (const y of rowBoundaries) {
        page.drawLine({ start: { x: leftX, y }, end: { x: rightX, y }, thickness: 1, color: rgb(0, 0, 0) });
      }
      page.drawLine({
        start: { x: colBreakX, y: rowBoundaries[rowBoundaries.length - 1] },
        end: { x: colBreakX, y: rowBoundaries[0] },
        thickness: 1,
        color: rgb(0, 0, 0),
      });
    }

    fs.writeFileSync(outputPath, await doc.save());
  }

  await build(true, fixtures.pdfToExcelBorderedTablePdf);
  await build(false, fixtures.pdfToExcelBorderlessTablePdf);
}

/**
 * 外出先PC修正指示書§27-28: pdf-to-wordのスキャンPDF(OCR)対応テスト用フィクスチャ生成。
 *
 * 文字レイヤーを持たない、画像だけのPDF(Chromiumでcanvasに文字を描画→PNG化→
 * PDFへ画像として埋め込む)。認識精度を安定させるため、内容は大きく明瞭な
 * 英数字のみにしている(日本語OCRの精度検証自体が目的ではなく、あくまで
 * 「テキストレイヤーが無いページでOCR経路が正しく動くこと」の検証が目的のため。
 * templateFilledScannedPdf等と同じ方針)。
 */
async function generatePdfToWordScannedFixture() {
  const w = 900;
  const h = 400;
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(
      `<html><body style="margin:0"><canvas id="c" width="${w}" height="${h}"></canvas>
       <script>
         const ctx = document.getElementById('c').getContext('2d');
         ctx.fillStyle = '#ffffff';
         ctx.fillRect(0, 0, ${w}, ${h});
         ctx.fillStyle = '#000000';
         ctx.font = 'bold 48px sans-serif';
         ctx.textBaseline = 'alphabetic';
         ctx.fillText('MRSATTO OCR SCAN TEST', 40, 150);
         ctx.fillText('HELLO WORLD', 40, 260);
       </script></body></html>`
    );
    const dataUrl = await page.$eval("#c", (el) => (el as HTMLCanvasElement).toDataURL("image/png"));
    const pngBytes = Buffer.from(dataUrl.split(",")[1], "base64");

    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([w, h]);
    const embedded = await doc.embedPng(pngBytes);
    pdfPage.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    fs.writeFileSync(fixtures.pdfToWordScannedPdf, await doc.save());
  } finally {
    await browser.close();
  }
}

/**
 * pdf-to-excelのスキャンPDF(OCR)対応テスト用フィクスチャ生成。
 *
 * 文字レイヤーを持たない画像だけのPDFに、列の間隔を十分に空けた3行×2列の表
 * (Name/Score, Alice 10, Bob 20)を大きく明瞭な英数字で描画する。OCRの認識精度自体
 * ではなく「文字情報の無いページでOCR経路が動き、座標から行・列が組み立てられる」
 * ことの検証が目的(pdfToWordScannedPdfと同じ方針)。
 * あわせて、1ページ目がテキストレイヤー(既存の罫線ありフィクスチャ)・2ページ目が
 * スキャン画像という「混在PDF」も作る(ページごとに処理方法が切り替わることの検証用)。
 */
async function generatePdfToExcelScannedFixtures() {
  const w = 900;
  const h = 500;
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(
      `<html><body style="margin:0"><canvas id="c" width="${w}" height="${h}"></canvas>
       <script>
         const ctx = document.getElementById('c').getContext('2d');
         ctx.fillStyle = '#ffffff';
         ctx.fillRect(0, 0, ${w}, ${h});
         ctx.fillStyle = '#000000';
         ctx.font = 'bold 52px sans-serif';
         ctx.textBaseline = 'alphabetic';
         const rows = [['Name', 'Score'], ['Alice', '10'], ['Bob', '20']];
         rows.forEach((r, i) => {
           const y = 130 + i * 110;
           ctx.fillText(r[0], 80, y);
           ctx.fillText(r[1], 560, y);
         });
       </script></body></html>`
    );
    const dataUrl = await page.$eval("#c", (el) => (el as HTMLCanvasElement).toDataURL("image/png"));
    const pngBytes = Buffer.from(dataUrl.split(",")[1], "base64");

    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([w, h]);
    const embedded = await doc.embedPng(pngBytes);
    pdfPage.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
    const scannedBytes = await doc.save();
    fs.writeFileSync(fixtures.pdfToExcelScannedTablePdf, scannedBytes);

    // 混在PDF: 1ページ目=テキストレイヤーの表、2ページ目=スキャン画像
    const mixed = await PDFDocument.create();
    const textDoc = await PDFDocument.load(fs.readFileSync(fixtures.pdfToExcelBorderedTablePdf));
    const scannedDoc = await PDFDocument.load(scannedBytes);
    const [textPage] = await mixed.copyPages(textDoc, [0]);
    const [scanPage] = await mixed.copyPages(scannedDoc, [0]);
    mixed.addPage(textPage);
    mixed.addPage(scanPage);
    fs.writeFileSync(fixtures.pdfToExcelMixedScannedPdf, await mixed.save());
  } finally {
    await browser.close();
  }
}

/**
 * 次工程・軽量便利ツール一括追加: Excel系5ツール(Tool 4〜8)・Word系2ツール
 * (Tool 9・10)のテスト用フィクスチャ生成。
 *
 * Excel側は、write-excel-file/node（既存依存。テストのNode実行環境専用の
 * エントリポイントで、アプリ本体は/universalしか使わない）を使い、
 * 実際のDate型セル・複数シート・完全に空白な行/列を持つXLSXを生成する。
 * write-excel-file/nodeでは日付は素のDateオブジェクトをそのまま渡せば
 * type: Dateとして書き出される（READMEどおり）。
 *
 * Word側は既存のdocx-writer.ts（fflateのみで組み立てる最小限のDOCX）を再利用する。
 * 実在の企業・個人データは一切使用しない。
 */
async function generateLightweightToolsFixtures() {
  // Excel空白行・空白列削除(Tool 5)用: 完全に空白な行(2行目)・列(C列、全行nullでなければ
  // ならないため見出し行も含めてC列は一切値を入れない)を含む
  await writeExcelFile([
    ["A1", "B1", null, "D1"],
    [null, null, null, null], // 完全に空白な行
    ["A3", "B3", null, "D3"],
    ["A4", "B4", null, "D4"],
  ]).toFile(fixtures.xlsxBlankRowsCols);

  // 複数シート(Tool 4/5/6/7/8の複数シート挙動確認用): 内容の異なる2シート
  await writeExcelFile([
    { sheet: "Sheet1", data: [["S1_A1", "S1_B1"], ["S1_A2", "S1_B2"]] },
    { sheet: "Sheet2", data: [["S2_A1", "S2_B1"], ["S2_A2", "S2_B2"]] },
  ]).toFile(fixtures.xlsxMultiSheet);

  // 日付一括変更(Tool 8)用: Excelの日付型セル・文字列形式の日付・日付以外の
  // 文字列セル・数値セルを混在させ、「日付として認識できるセルだけ」が
  // 変更されることを検証できるようにする。
  await writeExcelFile(
    [
      ["date_cell", "string_date", "plain_text", "number"],
      [new Date(2026, 9, 1), "2026/10/01", "not a date", 12345],
    ],
    { dateFormat: "yyyy-mm-dd" }
  ).toFile(fixtures.xlsxDates);

  // Word段落整理(Tool 9)・Word番号振り直し(Tool 10)用フィクスチャ
  function writeDocx(path: string, spec: DocxDocumentSpec) {
    fs.writeFileSync(path, buildMinimalDocx(spec));
  }

  // 通常のテキスト(単一段落)
  writeDocx(fixtures.wordNormalDocx, {
    blocks: [{ kind: "paragraph", runs: [{ text: "これは通常のテスト用文章です。" }] }],
  });

  // 複数段落
  writeDocx(fixtures.wordMultiParagraphDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "1つ目の段落です。" }] },
      { kind: "paragraph", runs: [{ text: "2つ目の段落です。" }] },
      { kind: "paragraph", runs: [{ text: "3つ目の段落です。" }] },
    ],
  });

  // 番号振り直し(Tool 10)用: 先頭に "1." "2." "3." の番号が付いた段落と、
  // 番号を持たない本文段落を混在させる(本文段落は変換対象外であることの確認用)。
  writeDocx(fixtures.wordNumberedDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "見出し（番号なし本文）" }] },
      { kind: "paragraph", runs: [{ text: "1. りんご" }] },
      { kind: "paragraph", runs: [{ text: "2. みかん" }] },
      { kind: "paragraph", runs: [{ text: "3. ぶどう" }] },
      { kind: "paragraph", runs: [{ text: "補足の本文段落です。" }] },
    ],
  });

  // 日本語テキスト・全角/半角スペース混在(Tool 9)用
  writeDocx(fixtures.wordJapaneseDocx, {
    blocks: [
      { kind: "paragraph", runs: [{ text: "全角スペース　を含む日本語の文章です。" }] },
      { kind: "paragraph", runs: [{ text: "半角スペース  が連続する場合の文章です。" }] },
    ],
  });
}
