import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Excel→PDF: 背景色つきの結合セル・縮小して全体を表示・均等割り付け・数値の表示書式。
 * 以前は、結合セルの文字(右隣・下隣のセルへまたがる部分)を後から塗る隣のセルの背景色が隠したり、
 * 幅の狭いセルの文字が欠けたり、金額が「850000」のまま桁区切りされなかった。
 * 固定のダミーデータ(tests/fixtures/static/excel-merge-fill-shrink.xlsx)を使う。
 */
const XLSX = path.join(fixtures.dir.static, "excel-merge-fill-shrink.xlsx");

/** PDFの1ページ目を72dpiのグレースケールにして、指定範囲(pt)の暗い画素の数を数える */
function darkPixels(pdf: string, x0: number, y0: number, x1: number, y1: number): number {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xl-")), "p");
  execFileSync("pdftoppm", ["-gray", "-r", "72", "-f", "1", "-l", "1", pdf, out]);
  const file = fs.readdirSync(path.dirname(out)).find((f) => f.endsWith(".pgm"))!;
  const buf = fs.readFileSync(path.join(path.dirname(out), file));
  // PGM(P5): "P5\nW H\n255\n" + 生データ
  const header = buf.toString("latin1", 0, 30).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/)!;
  const w = Number(header[1]);
  const data = buf.subarray(header[0].length);
  let n = 0;
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) if (data[y * w + x] < 110) n++;
  }
  return n;
}

test("背景色つきの結合セルの文字・金額の桁区切り・縮小・均等割り付けがPDFに反映される", async ({ page }) => {
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, XLSX);
  const ok = await page
    .getByRole("button", { name: "PDFに変換する" })
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    await page.reload();
    await uploadFixture(page, XLSX);
  }
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlpdf-"));
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);

  const txt = execFileSync("pdftotext", ["-layout", pdf, "-"]).toString();
  expect(txt).toContain("850,000");
  expect(txt).not.toContain("850000");
  expect(txt).toContain("12345");

  // 結合セルB2:H2(背景色つき)の文字が、右隣のセルの背景色で隠れていない。
  // B列の幅(右端は約x=104pt)を超えた右側(x=125〜220pt)の2行目(y=86〜104pt)にも、文字が描かれている。
  expect(darkPixels(pdf, 125, 86, 220, 104), "結合セルの文字が右隣の背景色で隠れています").toBeGreaterThan(40);
  // 金額(結合セルB4:H5・18pt・中央揃え)の文字が、下の行の背景色で隠れていない(y=118〜142pt)
  expect(darkPixels(pdf, 110, 118, 190, 142), "結合セルの金額が隠れています").toBeGreaterThan(80);
});
