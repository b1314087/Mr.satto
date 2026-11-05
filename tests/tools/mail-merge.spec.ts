import fs from "node:fs";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { buildMinimalXlsx } from "../fixtures/xlsx-writer";
import { assertDownloadedFile, clickAndDownload, closeResultPopup } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import {
  ASCENT,
  autoMap,
  blankPageSizePt,
  DEFAULT_PAPER,
  fieldText,
  layoutField,
  mmToPt,
  newField,
  tableToData,
  wrapLine,
  type MeasureFn,
} from "@/lib/mail-merge/layout";
import { layoutToJson, parseLayoutJson, LayoutJsonError } from "@/lib/mail-merge/storage";

/**
 * 差し込み印刷・レイアウト作成（mail-merge）のテスト。
 * 1. 配置の計算・データの読み取り・自動の紐付け・JSONの確認（純粋な関数）
 * 2. 画面：白紙／PDFの背景 → 項目の追加・移動・数値の調整 → CSV・Excel → 紐付け → 1件ずつの確認 → PDF
 * 3. レイアウトの保存（IndexedDB）・JSONの書き出しと読み込み、外部へ送信しないこと
 */

// 文字の幅を、1文字＝文字サイズ（全角）・半角は半分、として測る（計算の確認用）
const fakeMeasure: MeasureFn = (text, _font, size) => Array.from(text).reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? size / 2 : size), 0);
const A4 = blankPageSizePt(DEFAULT_PAPER);

// ---------------------------------------------------------------------------
// 1. 規則
// ---------------------------------------------------------------------------

plainTest("用紙：既定の大きさと向き、自由なサイズ（mm）を pt にする", () => {
  plainExpect(A4.width).toBeCloseTo(595.28, 1);
  plainExpect(A4.height).toBeCloseTo(841.89, 1);
  const land = blankPageSizePt({ ...DEFAULT_PAPER, presetId: "A3", orientation: "landscape" });
  plainExpect(land.width).toBeCloseTo(mmToPt(420), 1);
  plainExpect(land.height).toBeCloseTo(mmToPt(297), 1);
  const custom = blankPageSizePt({ ...DEFAULT_PAPER, presetId: "custom", widthMm: 100, heightMm: 50 });
  plainExpect(custom.width).toBeCloseTo(mmToPt(100), 1);
  plainExpect(custom.height).toBeCloseTo(mmToPt(50), 1);
  // 範囲外は収める
  const tiny = blankPageSizePt({ ...DEFAULT_PAPER, presetId: "custom", widthMm: 1, heightMm: 99999 });
  plainExpect(tiny.width).toBeCloseTo(mmToPt(20), 1);
  plainExpect(tiny.height).toBeCloseTo(mmToPt(1200), 1);
});

plainTest("配置：左上（mm）からベースラインを計算し、揃え・折り返し・縦位置が効く。文字サイズは自動で変えない", () => {
  const f = { ...newField("a", "氏名", 20, 30), sizePt: 10 };
  const l = layoutField(f, "山田太郎", A4, fakeMeasure);
  plainExpect(l.runs).toHaveLength(1);
  plainExpect(l.runs[0].x).toBeCloseTo(mmToPt(20), 3);
  plainExpect(l.runs[0].baseline).toBeCloseTo(mmToPt(30) + 10 * ASCENT, 3);
  plainExpect(l.usedSizePt).toBe(10);

  // 最大幅の中で右揃え・中央
  const right = layoutField({ ...f, maxWidthMm: 50, align: "right" }, "山田", A4, fakeMeasure);
  plainExpect(right.runs[0].x + 20).toBeCloseTo(mmToPt(20) + mmToPt(50), 3);
  const center = layoutField({ ...f, maxWidthMm: 50, align: "center" }, "山田", A4, fakeMeasure);
  plainExpect(center.runs[0].x).toBeCloseTo(mmToPt(20) + (mmToPt(50) - 20) / 2, 3);

  // 折り返し：最大幅を超えると次の行へ。最大高さに入らなければ、はみ出しとして知らせる（文字サイズはそのまま）
  plainExpect(wrapLine("あいうえおかきくけこ", "gothic", 10, 35, fakeMeasure)).toEqual(["あいう", "えおか", "きくけ", "こ"]);
  const over = layoutField({ ...f, maxWidthMm: ptToMmLocal(35), maxHeightMm: 5 }, "あいうえおかきくけこ", A4, fakeMeasure);
  plainExpect(over.runs.length).toBe(4);
  plainExpect(over.overflowBox).toBe(true);
  plainExpect(over.usedSizePt).toBe(10);

  // 「小さくして収める」をオンにしたときだけ、小さくする
  const shrink = layoutField({ ...f, maxWidthMm: 20, maxHeightMm: 5, shrinkToFit: true }, "あいうえおかきくけこ", A4, fakeMeasure);
  plainExpect(shrink.usedSizePt).toBeLessThan(10);
  plainExpect(shrink.overflowBox).toBe(false);

  // 縦位置（最大高さの中で下）
  const bottom = layoutField({ ...f, maxHeightMm: 30, vAlign: "bottom" }, "山田", A4, fakeMeasure);
  plainExpect(bottom.runs[0].baseline).toBeCloseTo(mmToPt(30) + mmToPt(30) - 10 + 10 * ASCENT, 3);

  // 用紙からはみ出す
  plainExpect(layoutField({ ...f, xMm: 200 }, "山田太郎花子", A4, fakeMeasure).overflowPage).toBe(true);
});

plainTest("配置：縦書きは1文字ずつ縦に並べ、列は右から左。半角数字は全角、横棒は縦棒にする", () => {
  const f = { ...newField("v", "住所", 50, 20), sizePt: 10, direction: "vertical" as const, maxHeightMm: ptToMmLocal(10 * 1.08 * 3) + 0.01 };
  const l = layoutField(f, "東京都1丁目", A4, fakeMeasure);
  plainExpect(l.runs.map((r) => r.text).join("")).toBe("東京都１丁目");
  plainExpect(layoutField(f, "1-2ー3", A4, fakeMeasure).runs.map((r) => r.text).join("")).toBe("１｜２｜３");
  // 3文字ずつ2列。2列目は1列目より左
  plainExpect(l.runs[3].x).toBeLessThan(l.runs[0].x);
  plainExpect(l.runs[1].baseline).toBeGreaterThan(l.runs[0].baseline);
  plainExpect(l.runs[0].x).toBeCloseTo(l.runs[1].x, 3);
});

plainTest("データ：見出しの行を変えられ、空の行を除き、空欄を数える。同じ列名は区別する", () => {
  const rows = [["名簿"], ["氏名", "住所", "氏名", ""], ["山田", "", "A", "x"], [null, null, null, null], ["佐藤", "大阪", "", ""]];
  const d = tableToData(rows, 2);
  plainExpect(d.columns).toEqual(["氏名", "住所", "氏名(2)", "列4"]);
  plainExpect(d.records).toEqual([
    ["山田", "", "A", "x"],
    ["佐藤", "大阪", "", ""],
  ]);
  plainExpect(d.blanks).toEqual([0, 1, 1, 1]);
  plainExpect(tableToData([[new Date(2026, 0, 5), 12, true]], 0).columns).toEqual(["2026/01/05", "12", "TRUE"]);
});

plainTest("紐付け：同じ名前・同じ意味の列だけを自動で紐付け、迷うときは紐付けない。値が空なら前後の文字も付けない", () => {
  plainExpect(autoMap("氏名", ["ＩＤ", "氏 名", "住所"])).toBe("氏 名");
  plainExpect(autoMap("お名前", ["ID", "氏名"])).toBe("氏名");
  plainExpect(autoMap("郵便番号", ["〒", "住所"])).toBe("〒");
  plainExpect(autoMap("住所", ["住所1", "住所2"])).toBeNull();
  plainExpect(autoMap("項目1", ["氏名"])).toBeNull();
  const data = { columns: ["氏名"], records: [["山田"], [""]], blanks: [1] };
  const f = { ...newField("a", "氏名", 0, 0), suffix: " 様" };
  plainExpect(fieldText(f, { kind: "column", column: "氏名" }, data, 0)).toBe("山田 様");
  plainExpect(fieldText(f, { kind: "column", column: "氏名" }, data, 1)).toBe("");
  plainExpect(fieldText(f, { kind: "fixed", text: "御中" }, data, 1)).toBe("御中 様");
});

plainTest("JSON：書き出したものは読み込め、おかしなJSONは受け付けない", () => {
  const body = {
    paper: DEFAULT_PAPER,
    fields: [newField("a", "氏名", 10, 20)],
    sources: { a: { kind: "column" as const, column: "氏名" } },
    templateName: null,
    templatePage: 1,
  };
  const back = parseLayoutJson(layoutToJson("案内状", body));
  plainExpect(back.name).toBe("案内状");
  plainExpect(back.body).toEqual(body);
  const bads = [
    "{",
    "[]",
    JSON.stringify({ kind: "other", version: 1 }),
    JSON.stringify({ ...JSON.parse(layoutToJson("x", body)), version: 2 }),
    JSON.stringify({ ...JSON.parse(layoutToJson("x", body)), fields: [{ ...body.fields[0], sizePt: 9999 }] }),
    JSON.stringify({ ...JSON.parse(layoutToJson("x", body)), fields: [{ ...body.fields[0], color: "red" }] }),
    JSON.stringify({ ...JSON.parse(layoutToJson("x", body)), paper: { ...DEFAULT_PAPER, presetId: "Z9" } }),
    JSON.stringify({ ...JSON.parse(layoutToJson("x", body)), fields: [body.fields[0], body.fields[0]] }),
  ];
  for (const b of bads) plainExpect(() => parseLayoutJson(b), b).toThrow(LayoutJsonError);
});

function ptToMmLocal(pt: number) {
  return (pt * 25.4) / 72;
}

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------

const MARKER = "差込秘密太郎";
const CSV = `氏名,郵便番号,住所,会社名\n${MARKER},100-0001,東京都千代田区千代田1-1,株式会社テスト\n佐藤花子,530-0001,,大阪商事\n鈴木一郎,060-0001,北海道札幌市中央区北1条西2丁目とても長い住所の建物名ビル10階,\n`;

async function openTool(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tools/mail-merge");
  await expect(page.getByTestId("mail-merge-mode-blank")).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="mail-merge-mode-blank"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
}

async function uploadData(page: Page, name: string, buffer: Buffer | Uint8Array, mimeType: string) {
  await page.getByTestId("mail-merge-step-data").locator('input[type="file"]').setInputFiles({ name, mimeType, buffer: Buffer.from(buffer) });
}

async function uploadTemplate(page: Page, buffer: Uint8Array, name = "背景.pdf") {
  await page.getByTestId("mail-merge-mode-pdf").click();
  await page.getByTestId("mail-merge-step-template").locator('input[type="file"]').setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from(buffer) });
}

/** プレビューの、左上から (xMm, yMm) の位置をクリックする */
async function clickStageAt(page: Page, xMm: number, yMm: number) {
  const stage = page.getByTestId("mail-merge-stage");
  const box = (await stage.boundingBox())!;
  const wMm = Number(await stage.getAttribute("data-page-w-mm"));
  const hMm = Number(await stage.getAttribute("data-page-h-mm"));
  await page.mouse.click(box.x + (xMm / wMm) * box.width, box.y + (yMm / hMm) * box.height);
}

async function setField(page: Page, x: number, y: number, size?: number) {
  await page.getByTestId("mail-merge-field-x").fill(String(x));
  await page.getByTestId("mail-merge-field-y").fill(String(y));
  if (size) await page.getByTestId("mail-merge-field-size").fill(String(size));
}

async function generate(page: Page) {
  await page.getByTestId("mail-merge-summary-open").click();
  await expect(page.getByTestId("mail-merge-summary")).toBeVisible();
  await page.getByTestId("mail-merge-run").click();
  await expect(page.getByTestId("mail-merge-result")).toBeVisible({ timeout: 90_000 });
  const dl = await clickAndDownload(page, "PDFをダウンロード");
  const file = await assertDownloadedFile(dl, { format: "pdf" });
  plainExpect(isValidPdfFile(file.path)).toBe(true);
  return { content: await extractPdfContent(file.path), name: dl.suggestedFilename(), path: file.path };
}

test("mail-merge: 白紙に項目をクリックで置き、ドラッグと数値で動かし、CSVを読み込むと自動で紐付き、1件1ページのPDFが正しい位置にできる。外部に送信しない", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  await page.getByTestId("mail-merge-mode-blank").click();
  await expect(page.getByTestId("mail-merge-stage")).toHaveAttribute("data-page-w-mm", "210");

  // 項目の追加（クリック）→ 名前を「氏名」にする
  await clickStageAt(page, 30, 40);
  await expect(page.getByTestId("mail-merge-box")).toHaveCount(1);
  const x0 = Number(await page.getByTestId("mail-merge-field-x").inputValue());
  plainExpect(Math.abs(x0 - 30)).toBeLessThan(1.5);
  await page.getByTestId("mail-merge-field-name").fill("氏名");

  // ドラッグで右下へ動かす
  const box = (await page.getByTestId("mail-merge-box").first().boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 3);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 5 });
  await page.mouse.up();
  const x1 = Number(await page.getByTestId("mail-merge-field-x").inputValue());
  const y1 = Number(await page.getByTestId("mail-merge-field-y").inputValue());
  plainExpect(x1).toBeGreaterThan(x0 + 5);
  plainExpect(y1).toBeGreaterThan(40 + 3);

  // 数値で決める
  await setField(page, 20, 30, 14);
  await page.getByTestId("mail-merge-field-suffix").fill(" 様");

  // 2つ目の項目（住所）は、最大幅を付けて折り返す
  await clickStageAt(page, 100, 100);
  await page.getByTestId("mail-merge-field-name").fill("住所");
  await setField(page, 20, 50, 10);
  await page.getByTestId("mail-merge-field-maxw").fill("60");

  // CSV を読み込む → 件数・列・空欄
  await uploadData(page, "名簿.csv", Buffer.from(CSV, "utf8"), "text/csv");
  await expect(page.getByTestId("mail-merge-record-count")).toHaveText("3");
  await expect(page.getByTestId("mail-merge-data-table")).toContainText("空欄1");
  // 自動の紐付け
  await expect(page.locator('[data-testid="mail-merge-map-row"][data-field-name="氏名"] select')).toHaveValue("col:氏名");
  await expect(page.locator('[data-testid="mail-merge-map-row"][data-field-name="住所"] select')).toHaveValue("col:住所");

  // 1件ずつ確認
  await expect(page.getByTestId("mail-merge-position")).toHaveText("1件目 / 全3件");
  await page.getByTestId("mail-merge-next").click();
  await expect(page.getByTestId("mail-merge-position")).toHaveText("2件目 / 全3件");
  await page.getByTestId("mail-merge-jump").fill("3");
  await page.getByTestId("mail-merge-jump-go").click();
  await expect(page.getByTestId("mail-merge-position")).toHaveText("3件目 / 全3件");
  await page.getByTestId("mail-merge-first").click();
  await expect(page.getByTestId("mail-merge-position")).toHaveText("1件目 / 全3件");

  const { content, name } = await generate(page);
  plainExpect(name).toBe("差し込み印刷_3件.pdf");
  plainExpect(content.pageCount).toBe(3);
  const p1 = content.pages[0];
  plainExpect(p1.width).toBeCloseTo(595.28, 0);
  plainExpect(p1.height).toBeCloseTo(841.89, 0);
  const nameItem = p1.items.find((i) => i.str.includes(MARKER))!;
  plainExpect(nameItem.str).toBe(`${MARKER} 様`);
  plainExpect(nameItem.x).toBeCloseTo(mmToPt(20), 0);
  plainExpect(nameItem.y).toBeCloseTo(p1.height - (mmToPt(30) + 14 * ASCENT), 0);
  plainExpect(p1.text).toContain("東京都千代田区");
  // 2件目：住所が空欄 → 住所は出ない。氏名だけ
  plainExpect(content.pages[1].text).toContain("佐藤花子 様");
  plainExpect(content.pages[1].text).not.toContain("東京都");
  // 3件目：長い住所は最大幅（60mm）で折り返して複数行
  const addrLines = content.pages[2].items.filter((i) => Math.abs(i.x - mmToPt(20)) < 1 && i.y < content.pages[2].height - mmToPt(50));
  plainExpect(addrLines.length).toBeGreaterThan(1);

  expect(findLeakedRequests(recorder, MARKER)).toEqual([]);
  expect(findLeakedRequests(recorder, encodeURIComponent(MARKER))).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

/** 背景用のPDF（2ページ。2ページ目は A5 で、文字が入っている） */
async function makeTemplatePdf(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("FIRST PAGE", { x: 50, y: 800, size: 12, font });
  const p2 = doc.addPage([419.53, 595.28]);
  p2.drawText("TEMPLATE BACKGROUND", { x: 40, y: 550, size: 14, font });
  if (rotate) p2.setRotation(degrees(rotate));
  return doc.save();
}

test("mail-merge: PDFを背景にし、ページを選べる。Excelのシート・見出しの行を変えられ、背景の上に差し込んだPDFができる（日本語・色）", async ({ page }) => {
  test.setTimeout(180_000);
  await openTool(page);
  await uploadTemplate(page, await makeTemplatePdf());
  await expect(page.getByTestId("mail-merge-template-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("mail-merge-template-page").selectOption("2");
  await expect(page.getByTestId("mail-merge-stage")).toHaveAttribute("data-page-w-mm", "148", { timeout: 30_000 });

  const xlsx = buildMinimalXlsx([
    { name: "メモ", rows: [[{ value: "使わないシート" }]] },
    {
      name: "名簿",
      rows: [
        [{ value: "2026年 修了者名簿" }],
        [{ value: "受講者名" }, { value: "コース" }],
        [{ value: "高橋 次郎" }, { value: "初級" }],
        [{ value: "渡辺 美咲" }, { value: "中級" }],
      ],
    },
  ]);
  await uploadData(page, "名簿.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await page.getByTestId("mail-merge-sheet").selectOption("1");
  await expect(page.getByTestId("mail-merge-record-count")).toHaveText("3");
  await page.getByTestId("mail-merge-header-row").fill("2");
  await expect(page.getByTestId("mail-merge-record-count")).toHaveText("2");

  // 列から項目をまとめて作る（列名がそのまま項目名になり、紐付く）
  await page.getByTestId("mail-merge-add-from-columns").click();
  await expect(page.getByTestId("mail-merge-box")).toHaveCount(2);
  await expect(page.locator('[data-testid="mail-merge-map-row"][data-field-name="受講者名"] select')).toHaveValue("col:受講者名");
  await page.getByTestId("mail-merge-field-chip").first().click();
  await setField(page, 30, 60, 20);
  await page.getByTestId("mail-merge-field-align").selectOption("center");
  await page.getByTestId("mail-merge-field-maxw").fill("88");
  await page.getByTestId("mail-merge-field-color").fill("#c00000");
  // 2つ目は固定の文字に変える
  await page.locator('[data-testid="mail-merge-map-row"][data-field-name="コース"] select').selectOption("__fixed__");
  await page.getByTestId("mail-merge-map-fixed").fill("修了証");

  const { content } = await generate(page);
  plainExpect(content.pageCount).toBe(2);
  for (const p of content.pages) {
    plainExpect(p.width).toBeCloseTo(419.53, 0);
    plainExpect(p.height).toBeCloseTo(595.28, 0);
    plainExpect(p.text).toContain("TEMPLATE BACKGROUND");
    plainExpect(p.text).not.toContain("FIRST PAGE");
    plainExpect(p.text).toContain("修了証");
  }
  plainExpect(content.pages[0].text).toContain("高橋 次郎");
  plainExpect(content.pages[1].text).toContain("渡辺 美咲");
  // 中央揃え：文字の左端は、枠（30mm〜118mm）の中央より左、枠の左端より右
  const item = content.pages[0].items.find((i) => i.str === "高橋 次郎")!;
  plainExpect(item.x).toBeGreaterThan(mmToPt(30));
  plainExpect(item.x).toBeLessThan(mmToPt(74));
});

test("mail-merge: 回転したPDFを背景にしても、プレビューと同じ向き・大きさで出力される", async ({ page }) => {
  test.setTimeout(120_000);
  await openTool(page);
  await uploadTemplate(page, await makeTemplatePdf(90));
  await page.getByTestId("mail-merge-template-page").selectOption("2");
  // 90度回転なので、横長（210×148mm）
  await expect(page.getByTestId("mail-merge-stage")).toHaveAttribute("data-page-w-mm", "210", { timeout: 30_000 });
  await clickStageAt(page, 20, 20);
  await page.getByTestId("mail-merge-field-name").fill("氏名");
  await setField(page, 10, 10, 12);
  await uploadData(page, "a.csv", Buffer.from("氏名\n回転テスト\n", "utf8"), "text/csv");
  const { content } = await generate(page);
  const p = content.pages[0];
  plainExpect(p.width).toBeCloseTo(595.28, 0);
  plainExpect(p.height).toBeCloseTo(419.53, 0);
  const t = p.items.find((i) => i.str === "回転テスト")!;
  plainExpect(t.x).toBeCloseTo(mmToPt(10), 0);
  plainExpect(t.y).toBeCloseTo(p.height - (mmToPt(10) + 12 * ASCENT), 0);
  plainExpect(p.text).toContain("TEMPLATE BACKGROUND");
});

test("mail-merge: 長い文字は赤くはみ出しを知らせ、文字サイズは変えない。全件のはみ出しを確かめられ、300件もまとめて作れる", async ({ page }) => {
  test.setTimeout(240_000);
  await openTool(page);
  await page.getByTestId("mail-merge-mode-blank").click();
  await clickStageAt(page, 20, 20);
  await page.getByTestId("mail-merge-field-name").fill("氏名");
  await setField(page, 20, 20, 12);
  await page.getByTestId("mail-merge-field-maxw").fill("30");
  await page.getByTestId("mail-merge-field-maxh").fill("6");
  // 7件目は氏名が空欄（番号の列だけある）
  const lines = ["氏名,番号"];
  for (let i = 1; i <= 300; i++) lines.push(`${i % 100 === 0 ? `とても長い名前の人${i}番目のデータです` : i === 7 ? "" : `名${i}`},${i}`);
  await uploadData(page, "多い.csv", Buffer.from(lines.join("\n") + "\n", "utf8"), "text/csv");
  await expect(page.getByTestId("mail-merge-record-count")).toHaveText("300");
  // 100件目へ
  await page.getByTestId("mail-merge-jump").fill("100");
  await page.getByTestId("mail-merge-jump-go").click();
  await expect(page.getByTestId("mail-merge-overflow-current")).toBeVisible();
  await expect(page.getByTestId("mail-merge-box").first()).toHaveAttribute("data-overflow", "true");
  await expect(page.getByTestId("mail-merge-field-size")).toHaveValue("12");
  await page.getByTestId("mail-merge-scan").click();
  await expect(page.getByTestId("mail-merge-scan-result")).toContainText("3件ではみ出しています");

  await page.getByTestId("mail-merge-summary-open").click();
  await expect(page.getByTestId("mail-merge-summary-records")).toHaveText("300件");
  await expect(page.getByTestId("mail-merge-summary-pages")).toContainText("300ページ");
  await expect(page.getByTestId("mail-merge-summary")).toContainText("3件ではみ出し");
  await page.getByTestId("mail-merge-run").click();
  await expect(page.getByTestId("mail-merge-result")).toBeVisible({ timeout: 120_000 });
  const dl = await clickAndDownload(page, "PDFをダウンロード");
  const content = await extractPdfContent((await assertDownloadedFile(dl, { format: "pdf" })).path);
  plainExpect(content.pageCount).toBe(300);
  plainExpect(content.pages[0].text).toContain("名1");
  plainExpect(content.pages[6].text).toBe(""); // 空欄の行は、何も差し込まない
  plainExpect(content.pages[299].text).toContain("とても長い名前の人300番目");
});

// ---------------------------------------------------------------------------
// 3. 保存・JSON
// ---------------------------------------------------------------------------

async function savedNames(page: Page) {
  return page.getByTestId("mail-merge-saved-item").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.layoutName ?? ""));
}

test("mail-merge: レイアウトをIndexedDBに保存し、読み込み直し・名前変更・上書き・複製・削除ができる（ページを開き直しても残る）", async ({ page }) => {
  test.setTimeout(180_000);
  await openTool(page);
  await uploadTemplate(page, await makeTemplatePdf());
  await expect(page.getByTestId("mail-merge-stage")).toBeVisible({ timeout: 30_000 });
  await clickStageAt(page, 30, 30);
  await page.getByTestId("mail-merge-field-name").fill("宛名");
  await setField(page, 25, 35, 16);
  await page.getByTestId("mail-merge-layout-name").fill("案内状");
  await page.getByTestId("mail-merge-save-template").check();
  await page.getByTestId("mail-merge-save-new").click();
  await expect(page.getByTestId("mail-merge-storage-msg")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("mail-merge-storage-msg")).toContainText("背景のPDFも保存");
  plainExpect(await savedNames(page)).toEqual(["案内状"]);

  // ページを開き直す → 一覧に残っていて、読み込むと項目と背景のPDFが戻る
  await openTool(page);
  await expect(page.getByTestId("mail-merge-saved-item")).toHaveCount(1);
  await page.getByTestId("mail-merge-saved-load").click();
  await expect(page.getByTestId("mail-merge-storage-msg")).toContainText("背景のPDFも読み込みました");
  await expect(page.getByTestId("mail-merge-box")).toHaveCount(1);
  await expect(page.getByTestId("mail-merge-template-name")).toContainText("背景.pdf");
  await page.getByTestId("mail-merge-field-chip").first().click();
  await expect(page.getByTestId("mail-merge-field-x")).toHaveValue("25");
  await expect(page.getByTestId("mail-merge-field-size")).toHaveValue("16");

  // 上書き：文字サイズを変えて上書き → 読み込み直すと変わっている
  await page.getByTestId("mail-merge-field-size").fill("22");
  await page.getByTestId("mail-merge-saved-overwrite").click();
  await expect(page.getByTestId("mail-merge-storage-msg")).toContainText("上書き保存しました");
  await page.getByTestId("mail-merge-field-size").fill("9");
  await page.getByTestId("mail-merge-saved-load").click();
  await expect(page.getByTestId("mail-merge-storage-msg")).toContainText("読み込みました");
  await page.getByTestId("mail-merge-field-chip").first().click();
  await expect(page.getByTestId("mail-merge-field-size")).toHaveValue("22");

  // 複製・名前変更・削除
  await page.getByTestId("mail-merge-saved-duplicate").first().click();
  await expect(page.getByTestId("mail-merge-saved-item")).toHaveCount(2);
  plainExpect((await savedNames(page)).sort()).toEqual(["案内状", "案内状のコピー"].sort());
  const copy = page.locator('[data-testid="mail-merge-saved-item"][data-layout-name="案内状のコピー"]');
  await copy.getByTestId("mail-merge-saved-rename").click();
  await page.getByTestId("mail-merge-rename-input").fill("修了証");
  await page.getByTestId("mail-merge-rename-ok").click();
  await expect(page.locator('[data-testid="mail-merge-saved-item"][data-layout-name="修了証"]')).toBeVisible();
  const target = page.locator('[data-testid="mail-merge-saved-item"][data-layout-name="修了証"]');
  await target.getByTestId("mail-merge-saved-delete").click();
  await target.getByTestId("mail-merge-saved-delete-confirm").click();
  await expect(page.getByTestId("mail-merge-saved-item")).toHaveCount(1);
  plainExpect(await savedNames(page)).toEqual(["案内状"]);

  // 開き直しても、削除・名前変更の結果のまま
  await openTool(page);
  await expect(page.getByTestId("mail-merge-saved-item")).toHaveCount(1);
  plainExpect(await savedNames(page)).toEqual(["案内状"]);
});

test("mail-merge: 保存できないとき（容量の上限）は、失敗を知らせて、成功とは表示しない", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if ((window as unknown as { __quota?: boolean }).__quota) throw new DOMException("quota", "QuotaExceededError");
      return orig.apply(this, args);
    };
  });
  await openTool(page);
  await page.getByTestId("mail-merge-mode-blank").click();
  await clickStageAt(page, 30, 30);
  await page.evaluate(() => ((window as unknown as { __quota?: boolean }).__quota = true));
  await page.getByTestId("mail-merge-layout-name").fill("失敗する");
  await page.getByTestId("mail-merge-save-new").click();
  await expect(page.getByTestId("mail-merge-storage-msg")).toHaveAttribute("data-kind", "error");
  await expect(page.getByTestId("mail-merge-storage-msg")).toContainText("保存容量が足りません");
  await expect(page.getByTestId("mail-merge-saved-empty")).toBeVisible();
});

test("mail-merge: JSONに書き出して読み込める（PDF本体は含まない）。おかしなJSONは読み込まない", async ({ page }) => {
  test.setTimeout(120_000);
  await openTool(page);
  await page.getByTestId("mail-merge-mode-blank").click();
  await page.getByTestId("mail-merge-preset").selectOption("custom");
  await page.getByTestId("mail-merge-paper-w").fill("100");
  await page.getByTestId("mail-merge-paper-h").fill("148");
  await page.getByTestId("mail-merge-orientation").selectOption("landscape");
  await clickStageAt(page, 20, 20);
  await page.getByTestId("mail-merge-field-name").fill("会社名");
  await setField(page, 12.5, 18, 11);
  await page.getByTestId("mail-merge-field-direction").selectOption("vertical");
  await page.getByTestId("mail-merge-layout-name").fill("はがき");

  const dlPromise = page.waitForEvent("download");
  await page.getByTestId("mail-merge-export-json").click();
  const dl = await dlPromise;
  plainExpect(dl.suggestedFilename()).toBe("はがき.json");
  const json = fs.readFileSync((await dl.path())!, "utf8");
  const parsed = JSON.parse(json);
  plainExpect(parsed.kind).toBe("mr-satto-mail-merge-layout");
  plainExpect(parsed.paper).toMatchObject({ presetId: "custom", widthMm: 100, heightMm: 148, orientation: "landscape" });
  plainExpect(parsed.fields[0]).toMatchObject({ name: "会社名", xMm: 12.5, yMm: 18, sizePt: 11, direction: "vertical" });
  plainExpect(json).not.toContain("%PDF");

  // 別のページで読み込む
  await openTool(page);
  await page.getByTestId("mail-merge-import-input").setInputFiles({ name: "壊れ.json", mimeType: "application/json", buffer: Buffer.from("{ not json") });
  await expect(page.getByTestId("mail-merge-storage-msg")).toHaveAttribute("data-kind", "error");
  await expect(page.getByTestId("mail-merge-box")).toHaveCount(0);
  await page.getByTestId("mail-merge-import-input").setInputFiles({ name: "他.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ kind: "x", version: 1 })) });
  await expect(page.getByTestId("mail-merge-storage-msg")).toContainText("このツールのレイアウトではありません");

  await page.getByTestId("mail-merge-import-input").setInputFiles({ name: "はがき.json", mimeType: "application/json", buffer: Buffer.from(json) });
  await expect(page.getByTestId("mail-merge-storage-msg")).toHaveAttribute("data-kind", "ok");
  await expect(page.getByTestId("mail-merge-box")).toHaveCount(1);
  await expect(page.getByTestId("mail-merge-stage")).toHaveAttribute("data-page-w-mm", "148");
  await expect(page.getByTestId("mail-merge-layout-name")).toHaveValue("はがき");
  await page.getByTestId("mail-merge-field-chip").first().click();
  await expect(page.getByTestId("mail-merge-field-x")).toHaveValue("12.5");
  await expect(page.getByTestId("mail-merge-field-direction")).toHaveValue("vertical");
  await closeResultPopup(page);
});
