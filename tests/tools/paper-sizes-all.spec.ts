import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { PAPER_SIZE_IDS, PAPER_SIZES_PT, PAPER_SIZE_LABELS, mmToPt } from "@/lib/print/paper-sizes";
import { PAPER_SIZES as SEATING_PAPERS } from "@/lib/processors/browser/seating-export";
import { computeImagePageLayout } from "@/lib/processors/browser/image-to-pdf-layout";

/**
 * 書き出しの用紙サイズを、主な用紙すべてに対応（2026-11）。
 * - 共通の用紙サイズ（チケット・画像レイアウト・証明写真・画像→PDFが使う）と、座席表の用紙に、A0〜A6・B0〜B6・レター・リーガル・タブロイド・エグゼクティブ・はがきがある
 * - 画像→PDF：A4だけでなく、選んだ用紙・向きに収めたPDFを作れる
 */

const ALL = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "B0", "B1", "B2", "B3", "B4", "B5", "B6", "Letter", "Legal", "Ledger", "Executive", "Postcard"];

plainTest("共通の用紙サイズ・座席表の用紙に、主な用紙がすべてある。寸法はJIS・国際規格どおり", () => {
  plainExpect(PAPER_SIZE_IDS).toEqual(ALL);
  plainExpect(SEATING_PAPERS.map((p) => p.value)).toEqual(ALL);
  for (const id of PAPER_SIZE_IDS) plainExpect(PAPER_SIZE_LABELS[id], id).toBeTruthy();
  const near = (pt: number, mm: number) => plainExpect(Math.abs(pt - mmToPt(mm))).toBeLessThan(0.6);
  near(PAPER_SIZES_PT.A6.width, 105);
  near(PAPER_SIZES_PT.A6.height, 148);
  near(PAPER_SIZES_PT.B6.width, 128);
  near(PAPER_SIZES_PT.B6.height, 182);
  plainExpect(PAPER_SIZES_PT.Ledger).toEqual({ width: 792, height: 1224 });
  plainExpect(PAPER_SIZES_PT.Executive).toEqual({ width: 522, height: 756 });
});

plainTest("画像→PDFの配置：選んだ用紙・向きのページに、縦横比を保って中央に収める。「画像に合わせる」は横長の画像を横向きにする", () => {
  const b5l = computeImagePageLayout(2000, 1000, "paper", { id: "B5", orientation: "landscape" });
  plainExpect(b5l.pageWidth).toBeCloseTo(728.5, 1);
  plainExpect(b5l.pageHeight).toBeCloseTo(515.91, 1);
  plainExpect(b5l.width / b5l.height).toBeCloseTo(2, 3);
  plainExpect(b5l.x).toBeCloseTo((b5l.pageWidth - b5l.width) / 2, 3);
  const auto = computeImagePageLayout(2000, 1000, "paper", { id: "A3", orientation: "auto" });
  plainExpect(auto.pageWidth).toBeGreaterThan(auto.pageHeight);
  // 従来の "a4" は、これまでどおりA4縦
  const a4 = computeImagePageLayout(100, 50, "a4");
  plainExpect([a4.pageWidth, a4.pageHeight]).toEqual([595.28, 841.89]);
  plainExpect(a4.width).toBe(100); // 小さい画像は拡大しない
});

test("画像→PDF：用紙サイズ（B5）と向き（横）を選ぶと、そのサイズのPDFになる", async ({ page }) => {
  test.setTimeout(120_000);
  const src = test.info().outputPath("wide.png");
  execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB',(1600,800),(30,120,200)).save(sys.argv[1])", src]);
  await page.goto("/tools/image-to-pdf");
  await uploadFixture(page, src);
  await page.getByRole("button", { name: "A4に収める" }).click();
  const paper = page.getByTestId("image-to-pdf-paper");
  await paper.getByLabel("用紙サイズ").selectOption("B5");
  await paper.getByLabel("用紙の向き").selectOption("landscape");
  await expect(page.getByRole("button", { name: "B5に収める" })).toBeVisible();
  await page.getByRole("button", { name: "1件の画像をPDF化する" }).click();
  const out = test.info().outputPath("b5.pdf");
  await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
  const size = execFileSync("python3", ["-c", "import sys\nfrom pypdf import PdfReader\np=PdfReader(sys.argv[1]).pages[0]\nprint(round(float(p.mediabox.width),1), round(float(p.mediabox.height),1))", out]).toString().trim();
  expect(size).toBe("728.5 515.9");
});
