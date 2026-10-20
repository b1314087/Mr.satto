import { test, expect } from "@playwright/test";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar } from "@/lib/calendar/model";
import {
  CALENDAR_CUSTOM_DEFAULT,
  CALENDAR_CUSTOM_ROLES,
  CALENDAR_THEMES,
  CALENDAR_THEME_CHOICES,
  CALENDAR_THEME_IDS,
  buildCustomTheme,
  contrastRatio,
  invalidCustomRoles,
  normalizeHexColor,
  resolveCalendarTheme,
  sanitizeCustomPalette,
  themeSwatchColors,
  type CalendarCustomPalette,
  type CalendarTheme,
} from "@/lib/calendar/themes";
import { readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { readPdfColors } from "../helpers/calendar-pdf-colors";
import { extractTextBoxes, readFontBytes } from "../helpers/pdf-text-boxes";
import { pinHolidayData } from "../helpers/holiday-pin";

pinHolidayData(); // 祝日の表示（2028年度の推定の注記）は、固定データ（2027年まで確定）で確かめる

/**
 * 年度カレンダーのデザイン拡張（新プリセット・カスタム配色・白黒）のテスト。
 * テーマ定義、プレビュー・Excel・PDFで同じ色が使われること、白黒に余計な色がないことを確かめる。
 * （既存の「ビジネス」「ナチュラル」が変わっていないことは calendar-theme-regression.spec.ts で確かめる）
 */

const CAL = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "sun" });
const ARGB = (hex: string) => hex.slice(1).toUpperCase(); // タブ色は FF を除いた6けたで読み取られる
const hexOfArgb = (v: string | null) => (v ? `#${v.slice(-6).toUpperCase()}` : null);

const MIXED: CalendarCustomPalette = { main: "#2E7D32", accent: "#C2185B", background: "#FFF8E1", ink: "#263238" };

async function excelOf(theme: CalendarTheme, orientation: "landscape" | "portrait" = "landscape") {
  const x = await buildCalendarExcel({ calendar: CAL, theme, orientation, showAdjacentDays: true });
  return readXlsxWorkbook(new Uint8Array(await x.arrayBuffer()));
}

test.describe("テーマ定義", () => {
  test("選択肢は ビジネス・ナチュラル・シンプル・パステル・ブルーグレー・カスタム の6つ", () => {
    expect(CALENDAR_THEME_IDS).toEqual(["business", "natural", "simple", "pastel", "bluegray"]);
    expect(CALENDAR_THEME_CHOICES).toEqual([...CALENDAR_THEME_IDS, "custom"]);
    expect(CALENDAR_THEMES.simple.label).toContain("シンプル");
    expect(CALENDAR_THEMES.simple.label).toContain("白黒");
    expect(CALENDAR_THEMES.pastel.label).toContain("パステル");
    expect(CALENDAR_THEMES.bluegray.label).toContain("ブルーグレー");
  });

  test("色コードの正規化: 3けた・# なし・小文字・前後の空白を受け付け、不正な値は null", () => {
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(normalizeHexColor("1f3864")).toBe("#1F3864");
    expect(normalizeHexColor(" #1f3864 ")).toBe("#1F3864");
    for (const bad of ["", "#", "#12", "#12345", "#1234567", "#GGGGGG", "red", "rgb(0,0,0)", null, undefined, 123, {}]) {
      expect(normalizeHexColor(bad), String(bad)).toBeNull();
    }
  });

  test("不正な色が混ざっても例外にならず、その役割だけ初期値になる（ほかの色は保たれる）", () => {
    const p = sanitizeCustomPalette({ main: "zzz", accent: "#112233", background: undefined, ink: 5 });
    expect(p).toEqual({ main: CALENDAR_CUSTOM_DEFAULT.main, accent: "#112233", background: CALENDAR_CUSTOM_DEFAULT.background, ink: CALENDAR_CUSTOM_DEFAULT.ink });
    expect(invalidCustomRoles({ main: "zzz", accent: "#112233", background: undefined, ink: 5 })).toEqual(["main", "background", "ink"]);
    expect(invalidCustomRoles(MIXED)).toEqual([]);
    expect(() => buildCustomTheme(null)).not.toThrow();
    expect(() => buildCustomTheme({ main: "<script>" })).not.toThrow();
    // 結果のテーマは、どんな入力でもすべて #RRGGBB
    const t = buildCustomTheme({ main: "x", accent: "", background: "#12", ink: "#GGGGGG" });
    for (const v of JSON.stringify(t).match(/#[0-9A-Fa-f]+/g) ?? []) expect(v).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("4色は互いに独立: 1色だけ変えると、その役割に関わる項目だけが変わる", () => {
    const base = buildCustomTheme(MIXED);
    const flat = (t: CalendarTheme) => JSON.parse(JSON.stringify(t)) as Record<string, unknown>;
    const changedKeys = (a: CalendarTheme, b: CalendarTheme) => {
      const fa = flat(a), fb = flat(b), out: string[] = [];
      for (const k of Object.keys(fa)) if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) out.push(k);
      return out;
    };
    // メイン: 見出し帯・曜日見出し・土曜日・タブだけ。アクセント・背景・文字の項目は変わらない
    const m = changedKeys(base, buildCustomTheme({ ...MIXED, main: "#0000FF" }));
    expect(m).not.toContain("holidayNameText");
    expect(m).not.toContain("memoBg");
    expect(m).not.toContain("noteText");
    expect(m).not.toContain("border");
    expect(m).toEqual(expect.arrayContaining(["titleBg", "tabColor"]));
    // アクセント: 日曜日・祝日だけ
    const a = changedKeys(base, buildCustomTheme({ ...MIXED, accent: "#FF0000" }));
    expect(a).not.toContain("titleBg");
    expect(a).not.toContain("tabColor");
    expect(a).not.toContain("memoBg");
    expect(a).toEqual(expect.arrayContaining(["holidayNameText", "headerSundayText"]));
    // 背景: 日付のマスと予定記入欄の背景。見出し帯の色（メイン）は変わらない
    const b = changedKeys(base, buildCustomTheme({ ...MIXED, background: "#EEEEEE" }));
    expect(b).not.toContain("titleBg");
    expect(b).not.toContain("holidayNameText");
    expect(b).toEqual(expect.arrayContaining(["dayBg", "memoBg"]));
    // 文字・罫線
    const i = changedKeys(base, buildCustomTheme({ ...MIXED, ink: "#000000" }));
    expect(i).not.toContain("titleBg");
    expect(i).not.toContain("holidayNameText");
    expect(i).not.toContain("tabColor");
    expect(i).toEqual(expect.arrayContaining(["headerText", "border", "noteText"]));
  });

  test("4色がそのまま使われる: メイン=見出し帯、アクセント=日曜・祝日、背景=平日のマス・予定欄、文字=平日の文字", () => {
    const t = buildCustomTheme(MIXED);
    expect(t.titleBg).toBe(MIXED.main);
    expect(t.tabColor).toBe(MIXED.main);
    expect(t.dayText.sunday).toBe(MIXED.accent);
    expect(t.dayText.holiday).toBe(MIXED.accent);
    expect(t.holidayNameText).toBe(MIXED.accent);
    expect(t.dayBg.weekday).toBe(MIXED.background);
    expect(t.memoBg).toBe(MIXED.background);
    expect(t.dayText.weekday).toBe(MIXED.ink);
  });

  test("見出し帯の文字は、メインカラーの上で読みやすい白か黒が自動で選ばれる", () => {
    for (const main of ["#000000", "#FFFFFF", "#1F3864", "#FFEB3B", "#7F7F7F", "#FF0000"]) {
      const t = buildCustomTheme({ main });
      expect(["#FFFFFF", "#000000"]).toContain(t.titleText);
      const other = t.titleText === "#FFFFFF" ? "#000000" : "#FFFFFF";
      expect(contrastRatio(t.titleText, t.titleBg), main).toBeGreaterThanOrEqual(contrastRatio(other, t.titleBg));
    }
  });

  test("プリセットを選ぶと、渡された4色は一切混ざらない（カスタムと行き来しても元に戻る）", () => {
    for (const id of CALENDAR_THEME_IDS) {
      expect(resolveCalendarTheme(id, MIXED)).toBe(CALENDAR_THEMES[id]);
      expect(resolveCalendarTheme(id, null)).toBe(CALENDAR_THEMES[id]);
    }
    const before = JSON.stringify(CALENDAR_THEMES);
    resolveCalendarTheme("custom", MIXED);
    expect(JSON.stringify(CALENDAR_THEMES)).toBe(before); // プリセットの定義は書き換わらない
    expect(resolveCalendarTheme("custom", MIXED)).toEqual(buildCustomTheme(MIXED));
    expect(resolveCalendarTheme("custom", MIXED).id).toBe("custom");
  });

  test("初期値のカスタムは4色すべてが正しい色で、読みやすい", () => {
    const t = buildCustomTheme(CALENDAR_CUSTOM_DEFAULT);
    expect(contrastRatio(t.dayText.weekday, t.dayBg.weekday)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.dayText.sunday, t.dayBg.sunday)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.titleText, t.titleBg)).toBeGreaterThanOrEqual(4.5);
    expect(CALENDAR_CUSTOM_ROLES).toEqual(["main", "accent", "background", "ink"]);
  });

  test("色見本は4色で、シンプル（白黒）の見本に色がない", () => {
    for (const choice of CALENDAR_THEME_CHOICES) expect(themeSwatchColors(resolveCalendarTheme(choice, MIXED))).toHaveLength(4);
    for (const c of themeSwatchColors(CALENDAR_THEMES.simple)) {
      const n = parseInt(c.slice(1), 16);
      expect([(n >> 16) & 255, (n >> 8) & 255, n & 255].every((v, _, a) => v === a[0]), c).toBe(true);
    }
  });
});

test.describe("Excel: プレビューと同じ共通テーマの色", () => {
  test("カスタム配色: タブ色・見出し帯・日付のマスの塗り・文字色が、カスタムの共通テーマと一致し、12シートのまま", async () => {
    test.setTimeout(120_000);
    const theme = resolveCalendarTheme("custom", MIXED);
    const wb = await excelOf(theme);
    expect(wb.sheets).toHaveLength(12);
    for (const sheet of wb.sheets) {
      expect(sheet.tabColor, sheet.name).toBe(ARGB(theme.tabColor!));
      const fills = new Set<string>(), fonts = new Set<string>();
      for (const cell of sheet.cells.values()) {
        const s = wb.style(cell);
        if (s?.fillColor) fills.add(hexOfArgb(s.fillColor)!);
        if (s?.fontColor) fonts.add(hexOfArgb(s.fontColor)!);
      }
      for (const f of [theme.titleBg, theme.dayBg.weekday, theme.dayBg.sunday, theme.headerBg]) expect(fills, `${sheet.name} 塗り ${f}`).toContain(f);
      for (const f of [theme.titleText, theme.dayText.weekday, theme.dayText.sunday, theme.holidayNameText]) expect(fonts, `${sheet.name} 文字 ${f}`).toContain(f);
      // カスタム以外のテーマ（ビジネス）の色が混ざっていない
      for (const f of [CALENDAR_THEMES.business.titleBg, CALENDAR_THEMES.business.headerBg, CALENDAR_THEMES.business.border]) expect(fills).not.toContain(f);
    }
  });

  test("カスタムの色を変えると、Excelの色も変わる（1色だけ変えたとき、ほかの役割の色は変わらない）", async () => {
    test.setTimeout(120_000);
    const a = await excelOf(resolveCalendarTheme("custom", MIXED));
    const b = await excelOf(resolveCalendarTheme("custom", { ...MIXED, accent: "#FF0000" }));
    const sheetA = a.sheets[0], sheetB = b.sheets[0];
    expect(sheetB.tabColor).toBe(sheetA.tabColor); // メインは変えていない
    const fontsOf = (wb: typeof a, sheet: typeof sheetA) => new Set([...sheet.cells.values()].map((c) => hexOfArgb(wb.style(c)?.fontColor ?? null)));
    expect(fontsOf(b, sheetB)).toContain("#FF0000");
    expect(fontsOf(a, sheetA)).not.toContain("#FF0000");
    expect(fontsOf(b, sheetB)).toContain(MIXED.ink); // 文字・罫線の色は変わらない
  });

  for (const id of ["simple", "pastel", "bluegray"] as const) {
    test(`${id}: Excelの色がプレビューと同じ共通テーマ（タブ色・見出し帯・日曜日のマス）で、12シート`, async () => {
      test.setTimeout(120_000);
      const theme = CALENDAR_THEMES[id];
      const wb = await excelOf(theme);
      expect(wb.sheets).toHaveLength(12);
      const sheet = wb.sheets[3];
      const fills = new Set([...sheet.cells.values()].map((c) => hexOfArgb(wb.style(c)?.fillColor ?? null)));
      const fonts = new Set([...sheet.cells.values()].map((c) => hexOfArgb(wb.style(c)?.fontColor ?? null)));
      if (theme.noFill) {
        expect(sheet.tabColor).toBeNull();
      } else {
        expect(sheet.tabColor).toBe(ARGB(theme.tabColor!));
        for (const f of [theme.titleBg, theme.headerBg, theme.dayBg.sunday, theme.dayBg.saturday]) expect(fills, f).toContain(f);
      }
      for (const f of [theme.dayText.weekday, theme.dayText.sunday, theme.holidayNameText]) expect(fonts, f).toContain(f);
    });
  }
});

test.describe("白黒（シンプル）: 余計な色がない", () => {
  test("Excel: 塗りつぶしなし・タブ色なし・文字と罫線は白黒グレーだけ・祝日名は通常表示・12シート", async () => {
    test.setTimeout(120_000);
    const wb = await excelOf(CALENDAR_THEMES.simple);
    expect(wb.sheets).toHaveLength(12);
    const isGray = (hex: string) => /^#([0-9A-F]{2})\1\1$/.test(hex);
    for (const sheet of wb.sheets) {
      expect(sheet.tabColor, `${sheet.name} タブ色`).toBeNull();
      expect(sheet.rawXml).not.toContain("<tabColor");
    }
    // styles.xml: 塗り(fill)は「なし」「gray125」のほかに無い
    for (const s of wb.styles) {
      expect(s.fillColor, `塗り ${s.fillColor}`).toBeNull();
      if (s.fontColor) expect(isGray(hexOfArgb(s.fontColor)!), `文字色 ${s.fontColor}`).toBe(true);
      for (const side of [s.borders.left, s.borders.right, s.borders.top, s.borders.bottom]) {
        if (side && /^[0-9A-Fa-f]{6,8}$/.test(side)) expect(isGray(hexOfArgb(side)!), `罫線 ${side}`).toBe(true);
      }
    }
    // 祝日名は通常どおり表示される（元日）
    const jan = wb.sheets.find((s) => s.name === "1月")!;
    const texts = [...jan.cells.values()].map((c) => c.value).filter((v): v is string => typeof v === "string");
    expect(texts.some((t) => t.includes("元日"))).toBe(true);
  });

  test("PDF: 図形の塗りつぶしがなく、文字・線の色は白黒グレーだけ・祝日名は通常表示・12ページ", async () => {
    test.setTimeout(150_000);
    const p = await buildCalendarPdf({ calendar: CAL, theme: CALENDAR_THEMES.simple, orientation: "landscape", showAdjacentDays: true, fontBytes: readFontBytes() });
    expect(p.pageCount).toBe(12);
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const pages = await readPdfColors(bytes);
    expect(pages).toHaveLength(12);
    const gray = (hex: string) => /^#([0-9A-F]{2})\1\1$/.test(hex);
    pages.forEach((pg, i) => {
      expect(pg.fillOpCount, `p${i + 1} 塗りつぶし`).toBe(0);
      expect(pg.strokeOpCount, `p${i + 1} 罫線`).toBeGreaterThan(0);
      for (const c of [...pg.fillColors, ...pg.strokeColors]) expect(gray(c), `p${i + 1} ${c}`).toBe(true);
    });
    const boxes = await extractTextBoxes(bytes);
    // 2026年度の10枚目は1月（元日）
    expect(boxes[9].boxes.some((b) => b.str.includes("元日"))).toBe(true);
  });

  test("PDF: ビジネス（比較用）には塗りつぶしと有彩色がある", async () => {
    test.setTimeout(150_000);
    const p = await buildCalendarPdf({ calendar: CAL, theme: CALENDAR_THEMES.business, orientation: "landscape", fontBytes: readFontBytes() });
    const pg = (await readPdfColors(new Uint8Array(await p.blob.arrayBuffer())))[0];
    expect(pg.fillOpCount).toBeGreaterThan(0);
    expect(pg.fillColors).toContain("#1F3864");
  });
});

test.describe("PDF: カスタム・新プリセットの色がプレビューと同じ共通テーマ", () => {
  test("カスタム配色: 見出し帯・日付のマス・文字の色が、カスタムの共通テーマと一致し、12ページ", async () => {
    test.setTimeout(150_000);
    const theme = resolveCalendarTheme("custom", MIXED);
    const p = await buildCalendarPdf({ calendar: CAL, theme, orientation: "portrait", fontBytes: readFontBytes() });
    expect(p.pageCount).toBe(12);
    const pages = await readPdfColors(new Uint8Array(await p.blob.arrayBuffer()));
    expect(pages).toHaveLength(12);
    for (const pg of pages) {
      for (const c of [theme.titleBg, theme.dayBg.weekday, theme.dayBg.sunday, theme.headerBg, theme.titleText, theme.dayText.weekday, theme.dayText.sunday]) {
        expect(pg.fillColors, c).toContain(c);
      }
      expect(pg.strokeColors).toContain(theme.border);
      expect(pg.fillColors).not.toContain(CALENDAR_THEMES.business.titleBg);
    }
  });

  for (const id of ["pastel", "bluegray"] as const) {
    test(`${id}: PDFの色が共通テーマ（見出し帯・日曜日のマス・罫線）と一致し、12ページ`, async () => {
      test.setTimeout(150_000);
      const theme = CALENDAR_THEMES[id];
      const p = await buildCalendarPdf({ calendar: CAL, theme, orientation: "landscape", fontBytes: readFontBytes() });
      expect(p.pageCount).toBe(12);
      const pg = (await readPdfColors(new Uint8Array(await p.blob.arrayBuffer())))[5];
      for (const c of [theme.titleBg, theme.headerBg, theme.dayBg.sunday, theme.dayBg.saturday, theme.dayText.sunday]) expect(pg.fillColors, c).toContain(c);
      expect(pg.strokeColors).toContain(theme.border);
    });
  }
});

test.describe("配色を変えても内容は変わらない（日付・曜日・祝日名・注記）", () => {
  test("PDFの文字（日付・曜日・祝日名・注記）が、どのテーマでも同じ内容・同じ位置", async () => {
    test.setTimeout(240_000);
    const cal = buildFiscalCalendar({ fiscalYear: 2028, weekStart: "mon" });
    const textsOf = async (theme: CalendarTheme) => {
      const p = await buildCalendarPdf({ calendar: cal, theme, orientation: "landscape", fontBytes: readFontBytes() });
      return (await extractTextBoxes(new Uint8Array(await p.blob.arrayBuffer()))).map((pg) => pg.boxes.map((b) => [b.str, Math.round(b.x), Math.round(b.y)]));
    };
    const base = await textsOf(CALENDAR_THEMES.business);
    expect(await textsOf(CALENDAR_THEMES.simple)).toEqual(base);
    expect(await textsOf(resolveCalendarTheme("custom", MIXED))).toEqual(base);
    // 2028年度の3月（推定の春分の日）の注記が残っている
    expect(base[11].some(([s]) => String(s).includes("推定"))).toBe(true);
  });

  test("Excelのセルの値（日付・曜日・祝日名・注記）が、どのテーマでも同じ", async () => {
    test.setTimeout(240_000);
    const cal = buildFiscalCalendar({ fiscalYear: 2028, weekStart: "mon" });
    const valuesOf = async (theme: CalendarTheme) => {
      const x = await buildCalendarExcel({ calendar: cal, theme, orientation: "portrait", showAdjacentDays: false });
      const wb = readXlsxWorkbook(new Uint8Array(await x.arrayBuffer()));
      return wb.sheets.map((s) => [s.name, [...s.cells.entries()].map(([k, c]) => [k, c.value])]);
    };
    const base = await valuesOf(CALENDAR_THEMES.business);
    expect(await valuesOf(CALENDAR_THEMES.simple)).toEqual(base);
    expect(await valuesOf(CALENDAR_THEMES.pastel)).toEqual(base);
    expect(await valuesOf(resolveCalendarTheme("custom", MIXED))).toEqual(base);
  });
});
