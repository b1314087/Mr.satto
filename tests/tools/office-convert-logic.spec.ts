import { test, expect } from "@playwright/test";
import {
  MIN_SHRINK,
  PAPER_SIZES,
  distributeTwips,
  excelPrintScale,
  fitColumns,
  fitImageBox,
  printableWidthTwips,
  scaledFontPt,
  type PageGeometry,
} from "@/lib/office-convert/excel-word-fit";
import { inferCellValue } from "@/lib/office-convert/word-to-excel";
import { safeSheetName, ptToColumnWidth, writeXlsx } from "@/lib/office-convert/xlsx-writer";
import { inspectDocx } from "@/lib/office-convert/docx-inspect";
import { strFromU8, unzipSync } from "fflate";

/** Excel→Word・Word→Excel の、画面を使わない計算のテスト（用紙に収める計算・数値の判定・シート名・ファイルの確認） */

const A4P: PageGeometry = { paper: PAPER_SIZES.A4, orientation: "portrait", margins: { top: 54, bottom: 54, left: 50.4, right: 50.4, header: 21.6, footer: 21.6 } };

test.describe("用紙に収める計算", () => {
  test("列の幅の合計は、印刷できる範囲の幅（twip）を超えない（四捨五入のずれも含めて）", () => {
    for (const n of [1, 3, 7, 13, 40, 120]) {
      const widths = Array.from({ length: n }, (_, i) => 30 + ((i * 37) % 90));
      const limit = printableWidthTwips(A4P);
      const tw = distributeTwips(widths, limit);
      expect(tw).toHaveLength(n);
      expect(tw.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(limit);
      expect(tw.every((w) => w > 0)).toBe(true);
    }
  });

  test("収まる表は縮めない・少しだけ大きい表は比率を保って縮める", () => {
    const fits = fitColumns({ columnWidthsPt: [100, 100, 100], geometry: A4P, allowAutoLandscape: true, mergeColSpans: [] });
    expect(fits.groups).toHaveLength(1);
    expect(fits.groups[0].shrink).toBe(1);
    expect(fits.groups[0].widthsTwips).toEqual([2000, 2000, 2000]);

    const slightly = fitColumns({ columnWidthsPt: [200, 200, 200], geometry: A4P, allowAutoLandscape: true, mergeColSpans: [] });
    expect(slightly.orientation).toBe("portrait");
    expect(slightly.groups).toHaveLength(1);
    const [a, b, c] = slightly.groups[0].widthsTwips;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - c)).toBeLessThanOrEqual(1);
  });

  test("縮め過ぎになる縦向きの表は、横向きなら収まるときだけ横向きにする（オフなら縦向きのまま分ける）", () => {
    const widths = Array.from({ length: 13 }, () => 60); // 780pt：縦向き(494pt)では65%未満、横向き(741pt)なら収まる
    const auto = fitColumns({ columnWidthsPt: widths, geometry: A4P, allowAutoLandscape: true, mergeColSpans: [] });
    expect(auto.orientation).toBe("landscape");
    expect(auto.rotated).toBe(true);
    expect(auto.groups).toHaveLength(1);
    const off = fitColumns({ columnWidthsPt: widths, geometry: A4P, allowAutoLandscape: false, mergeColSpans: [] });
    expect(off.orientation).toBe("portrait");
    expect(off.groups.length).toBeGreaterThan(1);
    for (const g of off.groups) {
      expect(g.widthsTwips.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(printableWidthTwips(A4P));
      expect(g.shrink).toBeGreaterThanOrEqual(MIN_SHRINK - 0.01);
    }
    // 列を消さない：すべての列が、どこかのページに1回ずつ入る
    expect(off.groups.flatMap((g) => g.cols).sort((x, y) => x - y)).toEqual(widths.map((_, i) => i));
  });

  test("列の途中で分けるときは、結合セルの途中を避ける", () => {
    const widths = Array.from({ length: 20 }, () => 50);
    const r = fitColumns({ columnWidthsPt: widths, geometry: A4P, allowAutoLandscape: false, mergeColSpans: [{ start: 12, end: 14 }] });
    for (const g of r.groups) {
      const has = (c: number) => g.cols.includes(c);
      expect(has(12) === has(14)).toBe(true);
    }
    expect(r.splitMerges).toBe(0);
  });

  test("Excelの手動の改ページ（列）の位置で分ける・印刷タイトルの列は各ページに繰り返す", () => {
    const widths = Array.from({ length: 10 }, () => 40);
    const r = fitColumns({ columnWidthsPt: widths, geometry: A4P, allowAutoLandscape: false, mergeColSpans: [], forcedBreaksAfter: [4], repeatCols: [0] });
    expect(r.groups[0].cols).toEqual([0, 1, 2, 3, 4]);
    expect(r.groups[1].cols[0]).toBe(0);
    expect(r.groups[1].cols).toContain(9);
  });

  test("Excelの印刷の倍率：ページに合わせる（横1ページ）・拡大縮小", () => {
    expect(excelPrintScale({ fitToPageEnabled: true, fitToWidth: 1, scalePercent: null, totalWidthPt: 1000, printableWidthPt: 500 })).toBeCloseTo(0.5);
    expect(excelPrintScale({ fitToPageEnabled: true, fitToWidth: 0, scalePercent: null, totalWidthPt: 1000, printableWidthPt: 500 })).toBe(1);
    expect(excelPrintScale({ fitToPageEnabled: false, fitToWidth: null, scalePercent: 80, totalWidthPt: 1000, printableWidthPt: 500 })).toBeCloseTo(0.8);
  });

  test("文字は縮小印刷でも7ptより小さくしない（元から小さい文字は元のまま）", () => {
    expect(scaledFontPt(11, 0.5)).toBe(7);
    expect(scaledFontPt(11, 0.8)).toBeCloseTo(8.8);
    expect(scaledFontPt(6, 0.5)).toBe(6);
  });

  test("画像は縦横比を保って、印刷できる範囲に収める", () => {
    const r = fitImageBox(1200, 300, 494, 700);
    expect(r.widthPt).toBeCloseTo(494);
    expect(r.heightPt).toBeCloseTo(123.5);
    expect(fitImageBox(100, 50, 494, 700)).toEqual({ widthPt: 100, heightPt: 50, scaled: false });
  });
});

test.describe("Word→Excel の数値・日付の判定（表示を変えない）", () => {
  test("数値・日付にするもの", () => {
    expect(inferCellValue("1,200")).toEqual({ value: 1200, numFmt: "#,##0" });
    expect(inferCellValue("3.14")).toEqual({ value: 3.14, numFmt: "0.00" });
    expect(inferCellValue("-42")).toEqual({ value: -42, numFmt: null });
    expect(inferCellValue("12.5%")).toEqual({ value: 0.125, numFmt: "0.0%" });
    expect(inferCellValue("¥1,500")).toEqual({ value: 1500, numFmt: "¥#,##0" });
    expect(inferCellValue("1500円")).toEqual({ value: 1500, numFmt: '0"円"' });
    const d = inferCellValue("2026/11/14");
    expect(d.value).toEqual(new Date(Date.UTC(2026, 10, 14)));
    expect(d.numFmt).toBe("yyyy/mm/dd");
    expect(inferCellValue("2026年1月5日").numFmt).toBe('yyyy"年"m"月"d"日"');
  });

  test("文字のままにするもの（先頭のゼロ・電話番号・ありえない日付・長い桁・前後の空白）", () => {
    for (const t of ["00123", "03-1234-5678", "2026/02/30", "R8.1.1", "1/2", "12345678901234567", " 12", "12 ", "1,23", "abc", "1\n2"]) {
      expect(typeof inferCellValue(t).value, t).toBe("string");
    }
  });
});

test.describe("Excelファイルの書き出し", () => {
  test("シート名：31文字まで・使えない文字・重複", () => {
    const used = new Set<string>();
    expect(safeSheetName("売上/仕入[2026]:集計?", used, "表1")).toBe("売上 仕入 2026 集計");
    expect(safeSheetName("売上/仕入[2026]:集計?", used, "表2")).toBe("売上 仕入 2026 集計（2）");
    expect(Array.from(safeSheetName("あ".repeat(50), used, "表3"))).toHaveLength(31);
    expect(safeSheetName("", used, "表4")).toBe("表4");
    expect(safeSheetName("History", used, "表5")).toBe("表5");
    expect(safeSheetName("'引用'", used, "表6")).toBe("引用");
  });

  test("書式・結合・リッチテキスト・画像を書き出せる", () => {
    const bytes = writeXlsx([
      {
        name: "表1",
        rows: [
          [{ v: "見出し", style: { font: { bold: true, color: "C00000" }, fill: "FFC000", border: { top: { style: "thin" } } } }, null],
          [{ v: 1200, style: { numFmt: "#,##0" } }, { v: "一部太字", rich: [{ text: "一部", font: { bold: true } }, { text: "太字", font: {} }] }],
        ],
        merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }],
        colWidths: [ptToColumnWidth(80), null],
        rowHeights: new Map([[1, { pt: 30, custom: false }]]),
        images: [{ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png", row: 3, col: 0, widthPx: 10, heightPx: 10 }],
      },
    ]);
    const files = unzipSync(bytes);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('<mergeCell ref="A1:B1"/>');
    expect(sheet).toContain("<v>1200</v>");
    expect(sheet).toContain('<drawing r:id="rId1"/>');
    expect(strFromU8(files["xl/sharedStrings.xml"])).toContain("<r><rPr><b/>");
    expect(strFromU8(files["xl/styles.xml"])).toContain('formatCode="#,##0"');
    expect(files["xl/media/image1.png"]).toBeTruthy();
  });
});

test.describe("できあがったWord文書の確認（docx-inspect）", () => {
  test("ページの大きさ・余白・表の幅・はみ出しを、ファイルの中身から読む", async () => {
    const docx = await import("docx");
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, WidthType, TableLayoutType, PageOrientation } = docx;
    const table = (widths: number[]) =>
      new Table({
        layout: TableLayoutType.FIXED,
        width: { size: widths.reduce((s, w) => s + w, 0), type: WidthType.DXA },
        columnWidths: widths,
        rows: [new TableRow({ children: widths.map((w) => new TableCell({ width: { size: w, type: WidthType.DXA }, children: [new Paragraph("x")] })) })],
      });
    const doc = new Document({
      sections: [
        { properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT }, margin: { left: 1000, right: 1000, top: 1000, bottom: 1000 } } }, children: [table([3000, 3000]), new Paragraph("")] },
        { properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: { left: 1000, right: 1000, top: 1000, bottom: 1000 } } }, children: [table([10000, 6000]), new Paragraph("")] },
      ],
    });
    const bytes = new Uint8Array(await (await Packer.toBlob(doc)).arrayBuffer());
    const ins = inspectDocx(bytes);
    expect(ins.sections).toHaveLength(2);
    expect(ins.sections[0].printableWidthTw).toBe(9906);
    expect(ins.sections[1].orientation).toBe("landscape");
    expect(ins.sections[1].printableWidthTw).toBe(16838 - 2000);
    expect(ins.tables[0].overflowTw).toBe(0);
    expect(ins.tables[0].fixedLayout).toBe(true);
    // 2つ目の表（16000twip）は横向きのページ（14838twip）からはみ出している → 見つけられる
    expect(ins.tables[1].section).toBe(1);
    expect(ins.tables[1].overflowTw).toBe(16000 - 14838);
    expect(ins.nonEmptyCells).toBe(4);
  });
});
