import { test, expect } from "@playwright/test";
import { formatExcelNumber } from "@/lib/excel/excel-number-format";

/**
 * Excelの数値の表示書式の整形（Excel→PDFで使う）。
 * 電話番号・郵便番号のように、数字の桁の途中に記号（ハイフン）が挟まる書式と、
 * 既存の書式（桁区切り・小数・パーセント・指数・分数・負数・ゼロ）が変わらないことを確認する。
 */

test.describe("桁の途中に記号が挟まる書式（電話番号・郵便番号）", () => {
  test("電話番号: 0##-####-#### など、Excelと同じ表示になる", () => {
    expect(formatExcelNumber(9012345678, "0##-####-####")).toBe("090-1234-5678");
    expect(formatExcelNumber(9012345678, "0##\\-####\\-####")).toBe("090-1234-5678");
    expect(formatExcelNumber(9012345678, '0##"-"####"-"####')).toBe("090-1234-5678");
    expect(formatExcelNumber(9012345678, "000-0000-0000")).toBe("090-1234-5678");
    expect(formatExcelNumber(312345678, "00-0000-0000")).toBe("03-1234-5678");
  });
  test("郵便番号: 000-0000・###-#### と、先頭が0の郵便番号", () => {
    expect(formatExcelNumber(1600023, "000-0000")).toBe("160-0023");
    expect(formatExcelNumber(1600023, "###-####")).toBe("160-0023");
    expect(formatExcelNumber(600023, "000-0000")).toBe("060-0023");
    expect(formatExcelNumber(600023, "###-####")).toBe("60-0023");
  });
  test("記号の前後に文字がついても崩れない（〒・括弧・全角ハイフン）", () => {
    expect(formatExcelNumber(1600023, '"〒"000-0000')).toBe("〒160-0023");
    expect(formatExcelNumber(9012345678, "(0##)####-####")).toBe("(090)1234-5678");
    expect(formatExcelNumber(1600023, "000－0000")).toBe("160－0023");
  });
  test("桁が余ったときは一番左の桁にまとめる。負数・小数も崩れない", () => {
    expect(formatExcelNumber(123456789, "000-0000")).toBe("12345-6789");
    expect(formatExcelNumber(-1600023, "000-0000")).toBe("-160-0023");
  });
});

test.describe("既存の書式は変わらない", () => {
  test("桁区切り・小数・0埋め・パーセント・単位", () => {
    expect(formatExcelNumber(1234567, "#,##0")).toBe("1,234,567");
    expect(formatExcelNumber(1234.5, "#,##0.00")).toBe("1,234.50");
    expect(formatExcelNumber(5, "00000")).toBe("00005");
    expect(formatExcelNumber(0.1234, "0.00%")).toBe("12.34%");
    expect(formatExcelNumber(1500, '#,##0"円"')).toBe("1,500円");
    expect(formatExcelNumber(12, '"第"0"回"')).toBe("第12回");
    expect(formatExcelNumber(1234567, '#,##0,"千円"')).toBe("1,235千円");
    expect(formatExcelNumber(100, "[$¥-411]#,##0")).toBe("¥100");
  });
  test("指数・分数・負数・括弧", () => {
    expect(formatExcelNumber(123456789, "0.00E+00")).toBe("1.23E+08");
    expect(formatExcelNumber(0.75, "# ?/?")).toBe("3/4");
    expect(formatExcelNumber(-5000, "#,##0;[Red]-#,##0")).toBe("-5,000");
    expect(formatExcelNumber(-1234567, '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)')).toBe("(1,234,567)");
    expect(formatExcelNumber(1500, "#,##0\"円\";▲#,##0\"円\"")).toBe("1,500円");
    expect(formatExcelNumber(-1500, "#,##0\"円\";▲#,##0\"円\"")).toBe("▲1,500円");
  });
});

test.describe("条件つき書式・ゼロのセクション", () => {
  test("小数部の後ろのカンマ（百万単位）と条件 [>=1000000]", () => {
    expect(formatExcelNumber(1234567, '[>=1000000]0.0,,"M";#,##0')).toBe("1.2M");
    expect(formatExcelNumber(1234, '[>=1000000]0.0,,"M";#,##0')).toBe("1,234");
  });
  test("ゼロのときだけ記号を出すセクション", () => {
    expect(formatExcelNumber(0, '#,##0;-#,##0;"-"')).toBe("-");
    expect(formatExcelNumber(10, '#,##0;-#,##0;"-"')).toBe("10");
    expect(formatExcelNumber(-10, '#,##0;-#,##0;"-"')).toBe("-10");
  });
});
