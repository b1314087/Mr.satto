import { test, expect } from "@playwright/test";
import { CALENDAR_THEMES, CALENDAR_THEME_IDS, getCalendarTheme, hexToRgb01 } from "@/lib/calendar/themes";

/**
 * 年度カレンダーのデザインテーマ（色）のテスト。
 * 文字色と背景色のコントラスト比を、WCAG 2.x の定義どおりに（実装とは別に）計算して、読みやすさを確かめる。
 */

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const MIN = 4.5;

test.describe("デザインテーマ", () => {
  test("プリセット5種（ビジネス・ナチュラル・シンプル・パステル・ブルーグレー）があり、名前・説明が設定されている", () => {
    expect(CALENDAR_THEME_IDS).toEqual(["business", "natural", "simple", "pastel", "bluegray"]);
    for (const id of CALENDAR_THEME_IDS) {
      const t = getCalendarTheme(id);
      expect(t.id).toBe(id);
      expect(t.label.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(() => getCalendarTheme("unknown" as never)).toThrow();
  });

  test("すべての色が #RRGGBB で、プリセットの配色は互いに異なる", () => {
    const collect = (t: (typeof CALENDAR_THEMES)[keyof typeof CALENDAR_THEMES]) => {
      const colors: string[] = [];
      for (const [k, v] of Object.entries(t)) {
        if (typeof v === "string" && v.startsWith("#")) colors.push(v);
        if (typeof v === "object" && v !== null) colors.push(...Object.values(v as Record<string, string>));
        void k;
      }
      return colors;
    };
    for (const id of CALENDAR_THEME_IDS) {
      for (const c of collect(CALENDAR_THEMES[id])) {
        expect(c, `${id} ${c}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
        const [r, g, b] = hexToRgb01(c);
        expect(Math.max(r, g, b)).toBeLessThanOrEqual(1);
      }
    }
    const signatures = CALENDAR_THEME_IDS.map((id) => JSON.stringify({ ...CALENDAR_THEMES[id], id: "", label: "", description: "" }));
    expect(new Set(signatures).size).toBe(CALENDAR_THEME_IDS.length);
    expect(CALENDAR_THEMES.business.titleBg).not.toBe(CALENDAR_THEMES.natural.titleBg);
    expect(CALENDAR_THEMES.business.dayBg.weekday).not.toBe(CALENDAR_THEMES.natural.dayBg.weekday);
  });

  test("hexToRgb01 は不正な色を受け付けない", () => {
    expect(() => hexToRgb01("red")).toThrow();
    expect(() => hexToRgb01("#FFF")).toThrow();
    expect(hexToRgb01("#FF0000")).toEqual([1, 0, 0]);
  });

  for (const id of CALENDAR_THEME_IDS) {
    test(`${id}: 文字と背景のコントラスト比が ${MIN} 以上（見出し・曜日・日付・祝日名・注記）`, () => {
      const t = CALENDAR_THEMES[id];
      const pairs: [string, string, string][] = [
        ["タイトル", t.titleText, t.titleBg],
        ["曜日見出し(平日)", t.headerText, t.headerBg],
        ["曜日見出し(土)", t.headerSaturdayText, t.headerBg],
        ["曜日見出し(日)", t.headerSundayText, t.headerBg],
        ["日付(平日)", t.dayText.weekday, t.dayBg.weekday],
        ["日付(土)", t.dayText.saturday, t.dayBg.saturday],
        ["日付(日)", t.dayText.sunday, t.dayBg.sunday],
        ["日付(祝日)", t.dayText.holiday, t.dayBg.holiday],
        ["祝日名", t.holidayNameText, t.dayBg.holiday],
        ["祝日名(日曜と重なる)", t.holidayNameText, t.dayBg.sunday],
        ["前後の月の日付", t.noteText, t.outOfMonthBg],
        ["注記", t.noteText, "#FFFFFF"],
      ];
      const failures = pairs.filter(([, fg, bg]) => contrast(fg, bg) < MIN).map(([n, fg, bg]) => `${n}: ${fg}/${bg}=${contrast(fg, bg).toFixed(2)}`);
      expect(failures).toEqual([]);
    });

    test(`${id}: 平日・土曜・日曜（祝日）の背景が互いに見分けられる`, () => {
      const t = CALENDAR_THEMES[id];
      if (t.noFill) {
        // 白黒（装飾色なし）は、平日・土日祝の色分けをしないのが仕様。前後の月の日付も同じ白
        expect(new Set(Object.values(t.dayBg))).toEqual(new Set(["#FFFFFF"]));
        expect(t.outOfMonthBg).toBe("#FFFFFF");
        return;
      }
      expect(t.dayBg.saturday).not.toBe(t.dayBg.weekday);
      expect(t.dayBg.sunday).not.toBe(t.dayBg.weekday);
      expect(t.dayBg.saturday).not.toBe(t.dayBg.sunday);
      expect(t.dayBg.holiday).toBe(t.dayBg.sunday);
      expect(t.dayText.holiday).toBe(t.dayText.sunday);
      expect(t.dayText.saturday).not.toBe(t.dayText.sunday);
      expect(t.outOfMonthBg).not.toBe(t.dayBg.weekday);
    });
  }
});
