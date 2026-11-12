import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { test as baseTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { honorificLineFromHeader, looksLikeHeader, restorePostalZeros, rowsToLabelListText } from "@/lib/label/import-file";
import { applyHonorific, applyPostalCode, labelTextOffset, planLabelPages, DEFAULT_CONTENT, DEFAULT_GEOMETRY, DEFAULT_STYLE } from "@/lib/label/layout";
import { LabelWordProcessor } from "@/lib/processors/browser/label-word";

/**
 * ラベル作成の修正（緊急対応）のテスト。
 * - プレビュー：「ラベルごとに違う内容」で文字がまだ空でも、ラベルの並びを表示する（以前は何も表示されなかった）
 * - Excel・CSVのファイルをドラッグ&ドロップ（または選択）すると、ラベルごとの文字として読み込む
 */

const tmpFile = (name: string, data: Buffer | string) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "label-import-")), name);
  fs.writeFileSync(p, data);
  return p;
};

async function makeXlsx(rows: unknown[][]): Promise<Buffer> {
  const blob = await writeXlsxSheets([{ name: "宛名", rows }]);
  return Buffer.from(await blob.arrayBuffer());
}

async function openTool(page: Page) {
  await page.goto("/tools/excel-label");
  await page.waitForFunction(() => {
    const el = Array.from(document.querySelectorAll("button")).find((b) => /Wordを作成/.test(b.textContent ?? ""));
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
  });
}

/** ページの見出し（ファイル選択欄の外）に、ファイルをドロップする（ブラウザの実際のドロップと同じイベント） */
async function dropOnPage(page: Page, file: { name: string; mime: string; data: Buffer }) {
  await page.evaluate(
    ({ name, mime, base64 }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type: mime }));
      const el = document.querySelector("h1")!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
      }
    },
    { name: file.name, mime: file.mime, base64: file.data.toString("base64") }
  );
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

baseTest.describe("読み込みの仕組み（ブラウザを使わない確認）", () => {
  baseTest("1行が1枚のラベルになり、横のセルはラベルの中で改行される。空のセル・空の行は飛ばす", () => {
    const rows = [
      ["氏名", "住所"],
      ["山田 太郎", "東京都千代田区1-1"],
      ["", ""],
      ["佐藤 花子", ""],
      ["鈴木 一郎", "大阪府\n大阪市北区1-1"],
    ];
    expect(looksLikeHeader(rows[0])).toBe(true);
    expect(looksLikeHeader(rows[1])).toBe(false);
    const { text, count } = rowsToLabelListText(rows, true);
    expect(count).toBe(3);
    expect(text).toBe("山田 太郎\t東京都千代田区1-1\n佐藤 花子\n鈴木 一郎\t大阪府\t大阪市北区1-1");
    expect(rowsToLabelListText(rows, false).count).toBe(4);
  });
});

baseTest.describe("敬称（ブラウザを使わない確認）", () => {
  baseTest("様・御中を、選んだ行（最後の行／1行目）に付ける。なしなら付けない。空のラベル・すでに付いている行には付けない", () => {
    const addr = "〒100-0001\n東京都千代田区1-1\n山田 太郎";
    expect(applyHonorific(addr, "sama", "last")).toBe("〒100-0001\n東京都千代田区1-1\n山田 太郎 様");
    expect(applyHonorific("株式会社見本\n東京都千代田区1-1", "onchu", "first")).toBe("株式会社見本 御中\n東京都千代田区1-1");
    expect(applyHonorific(addr, "none", "last")).toBe(addr);
    expect(applyHonorific("", "sama", "last")).toBe("");
    expect(applyHonorific("山田 太郎 様", "sama", "last")).toBe("山田 太郎 様");
    expect(applyHonorific("総務部 御中", "sama", "last")).toBe("総務部 御中");
    // 最後の行が空行のときは、文字のある最後の行に付ける
    expect(applyHonorific("山田 太郎\n", "sama", "last")).toBe("山田 太郎 様\n");
  });

  baseTest("見出しの「氏名」の列の位置から、敬称を付ける行を決める", () => {
    expect(honorificLineFromHeader(["氏名", "住所"])).toBe("first");
    expect(honorificLineFromHeader(["郵便番号", "住所", "氏名"])).toBe("last");
    expect(honorificLineFromHeader(["郵便番号", "氏名", "住所"])).toBeNull();
    expect(honorificLineFromHeader(["住所"])).toBeNull();
  });
});

baseTest.describe("郵便番号（ブラウザを使わない確認）", () => {
  const addr = "1000001\n東京都千代田区1-1\n山田 太郎";
  baseTest("〒マークを付ける：郵便番号の行を「〒123-4567」にそろえる（全角・ハイフンなし・〒付きにも対応）", () => {
    expect(applyPostalCode(addr, "mark")).toBe("〒100-0001\n東京都千代田区1-1\n山田 太郎");
    expect(applyPostalCode("〒１００－０００１\n住所", "mark")).toBe("〒100-0001\n住所");
    expect(applyPostalCode("100-0001", "mark")).toBe("〒100-0001");
    expect(applyPostalCode("〒1000001 東京都千代田区1-1", "mark")).toBe("〒100-0001 東京都千代田区1-1");
  });

  baseTest("入れない：郵便番号の行を除く。住所と同じ行にあるときは郵便番号の部分だけ除く。入力のままなら変えない", () => {
    expect(applyPostalCode(addr, "remove")).toBe("東京都千代田区1-1\n山田 太郎");
    expect(applyPostalCode("〒100-0001 東京都千代田区1-1\n山田 太郎", "remove")).toBe("東京都千代田区1-1\n山田 太郎");
    expect(applyPostalCode(addr, "keep")).toBe(addr);
    // 住所の中の番地（1-1）や、郵便番号でない数字の行は変えない
    expect(applyPostalCode("東京都千代田区1-1\n電話 03-1234-5678", "remove")).toBe("東京都千代田区1-1\n電話 03-1234-5678");
  });

  baseTest("郵便番号を除いたあとの最後の行に敬称が付く", () => {
    const plan = planLabelPages(DEFAULT_GEOMETRY, {
      ...DEFAULT_CONTENT,
      mode: "different",
      splitMode: "line",
      listText: "山田 太郎\t東京都千代田区1-1\t1000001",
      postalCode: "remove",
      honorific: "sama",
      honorificLine: "last",
    });
    expect(plan.pages[0][0]).toBe("山田 太郎\n東京都千代田区1-1 様");
  });

  baseTest("Excelで先頭の0が消えた郵便番号（数値）を、見出しが「郵便番号」の列なら7けたに戻す", () => {
    const rows = [["郵便番号", "住所"], ["600001", "北海道札幌市"], ["1000001", "東京都"], ["", "不明"]];
    restorePostalZeros(rows);
    expect(rows.map((r) => r[0])).toEqual(["郵便番号", "0600001", "1000001", ""]);
  });
});

/** Wordを作って、本文とヘッダー・フッターのXMLを返す */
async function wordXml(geometry: typeof DEFAULT_GEOMETRY, style = DEFAULT_STYLE) {
  const out = await new LabelWordProcessor().process({ geometry, style, content: DEFAULT_CONTENT });
  const files = unzipSync(new Uint8Array(await out.blob.arrayBuffer()));
  const text = (name: string) => strFromU8(files[name]);
  const headers = Object.keys(files).filter((n) => /^word\/(header|footer)\d+\.xml$/.test(n)).map(text);
  return { doc: text("word/document.xml"), headers };
}

baseTest.describe("Wordの1ページの行数とずれ（ブラウザを使わない確認）", () => {

  baseTest("ヘッダー・フッターは1ptの空の段落だけ（Wordが空のヘッダー・フッターに約5mmを確保して、行が次のページへ送られたり、開始位置がずれたりしないように）", async () => {
    const { doc, headers } = await wordXml(DEFAULT_GEOMETRY);
    expect(doc).toContain("<w:headerReference");
    expect(doc).toContain("<w:footerReference");
    expect(headers.length).toBeGreaterThanOrEqual(2);
    for (const xml of headers) {
      expect(xml).toMatch(/w:line="20"/);
      expect(xml).toMatch(/w:lineRule="exact"/);
      expect(xml).not.toContain("<w:t");
    }
    // 1ページに6行（行の高さは固定）
    expect(doc.match(/<w:trHeight w:val="2398" w:hRule="exact"\/>/g)?.length).toBe(6);
  });

  baseTest("下にほとんど余りがない用紙でも、6行目が次のページへ送られないよう、最後の行だけをわずかに詰める", async () => {
    // A4縦 297mm に、上の余白 6.1mm ＋ 48.4mm×6行 = 296.5mm（余り 0.5mm）
    const { doc } = await wordXml({ ...DEFAULT_GEOMETRY, marginTopMm: 6.1, labelHeightMm: 48.4 });
    const heights = [...doc.matchAll(/<w:trHeight w:val="(\d+)" w:hRule="exact"\/>/g)].map((m) => Number(m[1]));
    expect(heights).toHaveLength(6);
    const top = Math.round((6.1 / 25.4) * 1440);
    expect(16838 - top - heights.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60);
    expect(heights[5]).toBeLessThan(heights[0]);
    expect(heights[0] - heights[5]).toBeLessThan(60);
  });
});

baseTest.describe("文字の位置の調整（ブラウザを使わない確認）", () => {
  baseTest("揃え方ごとに動かせる方向が決まり、中央揃えはインデント・間隔を2倍にして中央のまま動かす", () => {
    const base = { hAlign: "center", vAlign: "middle", offsetXMm: 5, offsetYMm: -3 } as const;
    expect(labelTextOffset(base)).toEqual({ dxMm: 5, dyMm: -3, indentLeftMm: 10, indentRightMm: 0, spaceBeforeMm: 0, spaceAfterMm: 6 });
    // 左揃えは右へだけ・上揃えは下へだけ
    expect(labelTextOffset({ ...base, hAlign: "left", vAlign: "top", offsetXMm: -4, offsetYMm: 2 })).toMatchObject({ dxMm: 0, dyMm: 2, indentLeftMm: 0, spaceBeforeMm: 2 });
    // 右揃えは左へだけ・下揃えは上へだけ
    expect(labelTextOffset({ ...base, hAlign: "right", vAlign: "bottom", offsetXMm: -4, offsetYMm: 2 })).toMatchObject({ dxMm: -4, dyMm: 0, indentRightMm: 4, spaceAfterMm: 0 });
  });

  baseTest("Wordでは、セルの余白を使わず（行の高さが変わらない）、段落のインデント・間隔で文字を動かす", async () => {
    const { doc } = await wordXml(DEFAULT_GEOMETRY, { ...DEFAULT_STYLE, offsetXMm: 5, offsetYMm: 3 });
    // セルの余白はすべて0
    for (const m of doc.matchAll(/<w:tcMar>(.*?)<\/w:tcMar>/g)) expect(m[1]).not.toMatch(/w:w="[1-9]/);
    // 中央揃え：右へ5mm → 左インデント10mm（567twips）、下へ3mm → 最初の段落の前に6mm（340twips）
    expect(doc).toMatch(/<w:ind w:left="567" w:right="0"\/>/);
    expect(doc).toMatch(/w:before="340"/);
    expect(doc.match(/<w:trHeight w:val="2398" w:hRule="exact"\/>/g)?.length).toBe(6);
  });
});

test.describe("プレビュー", () => {
  test("「ラベルごとに違う内容」で文字がまだ空でも、12枚のラベルの並びが表示され、何をすればよいか案内する", async ({ page }) => {
    await openTool(page);
    await page.getByRole("button", { name: "ラベルごとに違う内容" }).click();
    await expect(page.getByTestId("label-cell")).toHaveCount(12);
    await expect(page.getByTestId("label-preview-hint")).toContainText("Excel・CSVのファイルを読み込むと、ここに表示されます");
    await expect(page.getByText("設定が正しくないため、プレビューを表示できません。")).toHaveCount(0);
  });

  test("用紙に収まらない寸法のときは、原因をそのまま伝える", async ({ page }) => {
    await openTool(page);
    await page.getByRole("spinbutton", { name: "ラベル幅 (mm)" }).fill("200");
    await expect(page.getByTestId("label-cell")).toHaveCount(0);
    const hint = page.getByTestId("label-preview-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("直すとプレビューが表示されます");
    await expect(hint).not.toContainText("設定が正しくないため");
  });
});

test.describe("Excel・CSVの読み込み", () => {
  test("Excelのファイルをページにドラッグ&ドロップすると、ラベルごとの文字として読み込まれ、プレビューとWordに入る（見出しの行は除く）", async ({ page }) => {
    const data = await makeXlsx([
      ["氏名", "住所"],
      ["山田 太郎", "東京都千代田区千代田1-1"],
      ["佐藤 花子", "大阪府大阪市北区梅田1-1"],
      ["鈴木 一郎", "愛知県名古屋市中区1-1"],
    ]);
    await openTool(page);
    await dropOnPage(page, { name: "宛名リスト.xlsx", mime: XLSX_MIME, data });
    const info = page.getByTestId("label-import-info");
    await expect(info).toContainText("「宛名リスト.xlsx」（シート: 宛名）から3件を読み込みました");
    await expect(page.getByRole("button", { name: "ラベルごとに違う内容" })).toHaveAttribute("aria-pressed", "true");
    // 区切り方は、プルダウンからセグメントボタンに変わった（押している状態は aria-pressed）
    await expect(page.getByRole("button", { name: "1行を1枚にする", exact: true })).toHaveAttribute("aria-pressed", "true");
    const cells = page.getByTestId("label-cell");
    await expect(cells.nth(0)).toContainText("山田 太郎");
    await expect(cells.nth(0)).toContainText("東京都千代田区千代田1-1");
    await expect(cells.nth(2)).toContainText("鈴木 一郎");
    await expect(cells.nth(3)).toHaveText("");
    await expect(page.getByText("3件のラベルを読み取りました")).toBeVisible();

    // 見出しの行もラベルにしたいときは、チェックを外す
    await info.getByRole("checkbox").uncheck();
    await expect(cells.nth(0)).toContainText("氏名");
    await expect(page.getByText("4件のラベルを読み取りました")).toBeVisible();
    await info.getByRole("checkbox").check();

    await page.getByRole("button", { name: "Wordを作成" }).click();
    await expect(page.getByText("ラベルシートを作成しました")).toBeVisible({ timeout: 15_000 });
    const download = await clickAndDownload(page, /Wordファイルをダウンロード/);
    const doc = strFromU8(unzipSync(new Uint8Array(fs.readFileSync((await download.path())!)))["word/document.xml"]);
    for (const t of ["山田 太郎", "東京都千代田区千代田1-1", "佐藤 花子", "鈴木 一郎"]) expect(doc).toContain(t);
    expect(doc).not.toContain("氏名");
  });

  test("ファイル選択欄からCSVを選んでも読み込める（見出しがないときは、すべての行をラベルにする）", async ({ page }) => {
    await openTool(page);
    const csv = tmpFile("list.csv", "﻿山田 太郎,東京都千代田区1-1\n佐藤 花子,大阪府大阪市北区1-1\n");
    await page.locator('input[type="file"]').first().setInputFiles(csv);
    await expect(page.getByTestId("label-import-info")).toContainText("から2件を読み込みました");
    await expect(page.getByTestId("label-import-info").getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByTestId("label-cell").nth(1)).toContainText("佐藤 花子");
  });

  test("敬称：なし・様・御中を選べ、プレビューとWordに反映される（読み込んだ見出しから付ける行も選ばれる）", async ({ page }) => {
    const data = await makeXlsx([
      ["氏名", "住所"],
      ["山田 太郎", "東京都千代田区千代田1-1"],
      ["株式会社見本", "大阪府大阪市北区梅田1-1"],
    ]);
    await openTool(page);
    await dropOnPage(page, { name: "宛名.xlsx", mime: XLSX_MIME, data });
    const cells = page.getByTestId("label-cell");
    await expect(cells.nth(0)).toContainText("山田 太郎");
    await expect(page.getByRole("button", { name: "なし", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(cells.nth(0)).not.toContainText("様");

    await page.getByRole("button", { name: "様", exact: true }).click();
    // 見出しの「氏名」が最初の列なので、1行目（名前の行）に付く
    await expect(page.getByRole("button", { name: "1行目（名前・住所の順）" })).toHaveAttribute("aria-pressed", "true");
    await expect(cells.nth(0)).toContainText("山田 太郎 様");
    await expect(cells.nth(0)).not.toContainText("千代田1-1 様");

    await page.getByRole("button", { name: "御中", exact: true }).click();
    await expect(cells.nth(1)).toContainText("株式会社見本 御中");

    await page.getByRole("button", { name: "様", exact: true }).click();
    await page.getByRole("button", { name: "Wordを作成" }).click();
    await expect(page.getByText("ラベルシートを作成しました")).toBeVisible({ timeout: 15_000 });
    const download = await clickAndDownload(page, /Wordファイルをダウンロード/);
    const doc = strFromU8(unzipSync(new Uint8Array(fs.readFileSync((await download.path())!)))["word/document.xml"]);
    expect(doc).toContain("山田 太郎 様");
    expect(doc).toContain("株式会社見本 様");

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "なし", exact: true }).click();
    await expect(cells.nth(0)).not.toContainText("様");
  });

  test("郵便番号：〒マークを付ける・入れないを選べ、プレビューに反映される（先頭の0が消えた番号も直る）", async ({ page }) => {
    const data = await makeXlsx([
      ["郵便番号", "住所", "氏名"],
      [600001, "北海道札幌市中央区北1条西2丁目", "山田 太郎"],
      ["100-0001", "東京都千代田区千代田1-1", "佐藤 花子"],
    ]);
    await openTool(page);
    await dropOnPage(page, { name: "宛名.xlsx", mime: XLSX_MIME, data });
    const cells = page.getByTestId("label-cell");
    await expect(cells.nth(0)).toContainText("0600001");

    await page.getByRole("button", { name: "〒マークを付ける" }).click();
    await expect(cells.nth(0)).toContainText("〒060-0001");
    await expect(cells.nth(1)).toContainText("〒100-0001");

    await page.getByRole("button", { name: "入れない", exact: true }).click();
    await expect(cells.nth(0)).not.toContainText("060");
    await expect(cells.nth(0)).toContainText("北海道札幌市中央区北1条西2丁目");

    // 敬称は、郵便番号を除いたあとの最後の行（氏名）に付く
    await page.getByRole("button", { name: "様", exact: true }).click();
    await expect(page.getByRole("button", { name: "最後の行（〒・住所・名前の順）" })).toHaveAttribute("aria-pressed", "true");
    await expect(cells.nth(1)).toContainText("佐藤 花子 様");

    await page.getByRole("button", { name: "入力のまま" }).click();
    await expect(cells.nth(0)).toContainText("0600001");
  });

  test("「ラベル内の余白」はなく、文字の位置（横・縦）のバーで、プレビューの文字が動く", async ({ page }) => {
    await openTool(page);
    await expect(page.getByText("ラベル内の余白")).toHaveCount(0);
    const firstText = page.getByTestId("label-cell").first().locator("span");
    const before = await firstText.boundingBox();
    await page.getByRole("spinbutton", { name: "文字の位置（横）" }).fill("10");
    await page.getByRole("spinbutton", { name: "文字の位置（横）" }).blur();
    await page.getByRole("spinbutton", { name: "文字の位置（縦）" }).fill("-5");
    await page.getByRole("spinbutton", { name: "文字の位置（縦）" }).blur();
    await expect.poll(async () => (await firstText.boundingBox())!.x).toBeGreaterThan(before!.x + 2);
    expect((await firstText.boundingBox())!.y).toBeLessThan(before!.y - 1);
  });

  test("古いExcel（.xls）は、保存し直す方法を案内する", async ({ page }) => {
    await openTool(page);
    const xls = tmpFile("old.xls", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    await page.locator('input[type="file"]').first().setInputFiles(xls);
    await expect(page.getByText("古い形式（.xls）は読み込めません")).toBeVisible();
  });
});
