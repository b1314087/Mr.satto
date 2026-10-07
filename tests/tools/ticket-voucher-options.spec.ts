import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 整理券・金券・引換券: 開始/終了番号、コードの大きさ・場所・内容、Excel一括、複数の券の種類 */

async function makePdf(page: import("@playwright/test").Page): Promise<string> {
  await page.getByRole("button", { name: "PDFを作成" }).click();
  await expect(page.getByText("PDFを作成しました")).toBeVisible({ timeout: 20_000 });
  const download = await clickAndDownload(page, /PDFをダウンロード/);
  const pdf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tk-")), "out.pdf");
  await download.saveAs(pdf);
  return pdf;
}

function pdfText(pdf: string): string {
  return execFileSync("pdftotext", ["-layout", pdf, "-"]).toString();
}

async function gotoTool(page: import("@playwright/test").Page) {
  await page.goto("/tools/ticket-voucher");
  await expect(page.getByLabel("開始番号").first()).toBeVisible();
}

test("開始番号と終了番号を指定すると、その範囲の連番の券ができる", async ({ page }) => {
  await gotoTool(page);
  await page.getByLabel("タイトル").first().fill("整理券");
  await page.getByLabel("開始番号").first().fill("5");
  await page.getByLabel("終了番号").first().fill("9");
  await expect(page.getByText("（5枚）")).toBeVisible();
  const pdf = await makePdf(page);
  const txt = pdfText(pdf);
  for (const n of ["0005", "0006", "0007", "0008", "0009"]) expect(txt).toContain(n);
  expect(txt).not.toContain("0004");
  expect(txt).not.toContain("0010");
});

test("終了番号が開始番号より小さいとエラーになり作成できない", async ({ page }) => {
  await gotoTool(page);
  await page.getByLabel("開始番号").first().fill("10");
  await page.getByLabel("終了番号").first().fill("3");
  await expect(page.getByRole("button", { name: "PDFを作成" })).toBeDisabled();
});

test("別のタイトル・金額の券を追加して1つのPDFにできる", async ({ page }) => {
  await gotoTool(page);
  await page.getByLabel("タイトル").first().fill("金券");
  await page.getByLabel("金額").first().fill("500円");
  await page.getByLabel("開始番号").first().fill("1");
  await page.getByLabel("終了番号").first().fill("2");
  await page.getByRole("button", { name: /別のタイトル・金額の券を追加/ }).click();
  await page.getByLabel("タイトル").nth(1).fill("引換券");
  await page.getByLabel("金額").nth(1).fill("1,000円");
  await page.getByLabel("開始番号").nth(1).fill("1");
  await page.getByLabel("終了番号").nth(1).fill("2");
  const txt = pdfText(await makePdf(page));
  expect(txt).toContain("金券");
  expect(txt).toContain("500円");
  expect(txt).toContain("引換券");
  expect(txt).toContain("1,000円");
});

test("二次元コード・バーコードの内容・場所・大きさを指定でき、プレビューにも反映される", async ({ page }) => {
  await gotoTool(page);
  await page.getByText("二次元コードを表示する").click();
  await page.getByLabel("読み取ったときに表示される内容").first().fill("整理券 {n}番");
  await page.getByLabel("二次元コードの場所").selectOption("topRight");
  await page.getByLabel("大きさ（一辺・mm）").fill("20");
  await page.getByText("バーコードを表示する（CODE128）").click();
  await page.getByLabel("バーコードの場所").selectOption("bottomCenter");
  await page.getByLabel("幅（mm）").fill("50");
  await page.getByLabel("高さ（mm）").fill("10");
  const preview = page.getByTestId("tool-preview");
  await expect(preview.locator("svg image").first()).toBeVisible();
  await makePdf(page);
});

test("バーコードに全角文字を入れるとエラーになる（二次元コードを案内）", async ({ page }) => {
  await gotoTool(page);
  await page.getByText("バーコードを表示する（CODE128）").click();
  await page.getByLabel("読み取ったときに表示される内容（半角の英数字・記号のみ）").fill("整理券");
  await expect(page.getByText("二次元コード", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "PDFを作成" })).toBeDisabled();
});

test("Excelを読み込み、1行=1枚で券ごとに違うタイトル・金額・内容にできる", async ({ page }) => {
  const xlsx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tkx-")), "tickets.xlsx");
  execFileSync("python3", [
    "-I",
    "-c",
    `import openpyxl,sys
wb=openpyxl.Workbook();ws=wb.active
ws.append(["券名","金額","氏名","番号"])
ws.append(["金券",500,"山田","A001"])
ws.append(["引換券",1000,"佐藤","A002"])
ws.append(["整理券",None,"鈴木","A003"])
wb.save(sys.argv[1])`,
    xlsx,
  ]);
  await gotoTool(page);
  await page.locator('input[type="file"]').first().setInputFiles(xlsx);
  await page.getByLabel("タイトルの列").selectOption("券名");
  await page.getByLabel("金額の列").selectOption("金額");
  await page.getByLabel("連番（番号）の列").selectOption("番号");
  await page.getByLabel("二次元コードの内容の列").selectOption("氏名");
  await page.getByRole("button", { name: /読み込んだ3件を券にする/ }).click();
  await expect(page.getByText("Excel/CSVから読み込んだ3件")).toBeVisible();
  await expect(page.getByTestId("tool-preview")).toContainText("全3枚");
  const txt = pdfText(await makePdf(page));
  for (const s of ["金券", "引換券", "整理券", "500円", "1,000円", "A001", "A002", "A003"]) expect(txt).toContain(s);
});
