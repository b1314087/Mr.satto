import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 名簿テンプレート: スキャンしたPDFの罫線から、列幅・行の高さを再現した空欄のExcelを作る */
// roster-scan.pdf: 4列(25/55/40/30mm) × 9行(14mm + 12mm×8)の表を1度傾けてスキャンした画像
const FIXTURE = path.join(__dirname, "../fixtures/static/roster-scan.pdf");

/** ハイドレーション前のクリックは無視されるため、切り替わるまで繰り返す */
async function openScanMode(page: import("@playwright/test").Page) {
  const button = page.getByRole("button", { name: "スキャンしたPDFの枠を再現する" });
  await expect(async () => {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

test("スキャンPDFから罫線を読み取り、列幅・行の高さどおりのExcelを作れる", async ({ page }) => {
  await page.goto("/tools/roster-template");
  await openScanMode(page);
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE);
  const summary = page.getByTestId("scan-summary");
  await expect(summary).toContainText("4列 × 9行", { timeout: 60_000 });

  // 検出した列幅・行の高さが実寸(25/55/40/30, 14/12...)に近い
  const widths = [25, 55, 40, 30];
  for (let i = 0; i < 4; i++) {
    const v = Number(await page.getByLabel(`列${i + 1}の幅`).inputValue());
    expect(Math.abs(v - widths[i]), `列${i + 1}`).toBeLessThan(2);
  }
  expect(Math.abs(Number(await page.getByLabel("行1の高さ").inputValue()) - 14)).toBeLessThan(2);
  expect(Math.abs(Number(await page.getByLabel("行5の高さ").inputValue()) - 12)).toBeLessThan(2);

  await page.getByRole("button", { name: "枠のExcelを作成" }).click();
  await expect(page.getByText("作成しました")).toBeVisible({ timeout: 20_000 });
  const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
  const xlsx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-")), "out.xlsx");
  await download.saveAs(xlsx);

  const out = execFileSync("python3", [
    "-I",
    "-c",
    `import openpyxl,sys,json
ws=openpyxl.load_workbook(sys.argv[1]).active
cols=[ws.column_dimensions[c].width for c in "ABCD"]
rows=[ws.row_dimensions[r].height for r in range(1,10)]
cell=ws["B3"]
print(json.dumps({"cols":cols,"rows":rows,"maxc":ws.max_column,"maxr":ws.max_row,"border":cell.border.left.style,"val":cell.value}))`,
    xlsx,
  ]).toString();
  const r = JSON.parse(out);
  expect(r.maxc).toBe(4);
  expect(r.maxr).toBe(9);
  expect(r.border).toBe("thin");
  expect(r.val == null || r.val === "").toBeTruthy();
  const ptPerMm = 72 / 25.4;
  expect(Math.abs(r.rows[0] - 14 * ptPerMm)).toBeLessThan(5);
  expect(Math.abs(r.rows[4] - 12 * ptPerMm)).toBeLessThan(5);
  // Excelの列幅(文字数)をmmへ戻して、列2が列1の約2.2倍であること
  const toMm = (w: number) => ((w * 7 + 5) / 96) * 25.4;
  expect(toMm(r.cols[1]) / toMm(r.cols[0])).toBeGreaterThan(1.9);
  expect(toMm(r.cols[1]) / toMm(r.cols[0])).toBeLessThan(2.5);
});

test("罫線のないPDFでは、わかりやすいエラーが出る", async ({ page }) => {
  const blank = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rb-")), "blank.pdf");
  execFileSync("python3", ["-I", "-c", `from PIL import Image;import sys;Image.init();Image.new("L",(800,1100),255).save(sys.argv[1],resolution=100)`, blank]);
  await page.goto("/tools/roster-template");
  await openScanMode(page);
  await page.locator('input[type="file"]').first().setInputFiles(blank);
  await expect(page.getByText("罫線を検出できませんでした")).toBeVisible({ timeout: 30_000 });
});
