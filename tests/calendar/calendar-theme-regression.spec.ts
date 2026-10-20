import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { CALENDAR_THEMES, getCalendarTheme } from "@/lib/calendar/themes";
import { excelFingerprint, pdfFingerprint } from "../helpers/calendar-golden";
import { readFontBytes } from "../helpers/pdf-text-boxes";

/**
 * 既存テーマ（ビジネス・ナチュラル）の維持を保証するテスト。デザインの拡張（新プリセット・カスタム配色）の前に記録した
 *  1. 全色コードの一覧（下のリテラル。themes.ts とは別に、人が読める形で残す）
 *  2. Excel・PDFの出力の指紋（tests/fixtures/static/calendar-theme-golden.json。拡張前の実装で作成）
 * と、現在の出力を突き合わせる。色・図形・文字の位置が1つでも変われば失敗する。
 * 意図して既存テーマの見た目を変える場合だけ、このテストと golden を更新する。
 */

const BUSINESS_LITERAL = {
  id: "business",
  label: "ビジネス（ネイビー）",
  titleBg: "#1F3864", titleText: "#FFFFFF", headerBg: "#D9E2F3", headerText: "#1F2937",
  headerSaturdayText: "#1F4E9E", headerSundayText: "#B42318",
  dayBg: { weekday: "#FFFFFF", saturday: "#EAF0FB", sunday: "#FDECEC", holiday: "#FDECEC" },
  outOfMonthBg: "#F2F2F2",
  dayText: { weekday: "#1F2937", saturday: "#1F4E9E", sunday: "#B42318", holiday: "#B42318" },
  holidayNameText: "#B42318", memoBg: "#FFFFFF", memoOutOfMonthBg: "#F2F2F2", border: "#8EA9DB",
  noteText: "#4B5563", tabColor: "#1F3864",
};
const NATURAL_LITERAL = {
  id: "natural",
  label: "ナチュラル（ベージュ・グリーン）",
  titleBg: "#4F6B4A", titleText: "#FFFFFF", headerBg: "#E8E4D0", headerText: "#3B3A32",
  headerSaturdayText: "#2F6275", headerSundayText: "#A63D2A",
  dayBg: { weekday: "#FBF8EF", saturday: "#E8F1F2", sunday: "#F8E6DF", holiday: "#F8E6DF" },
  outOfMonthBg: "#ECE8DA",
  dayText: { weekday: "#3B3A32", saturday: "#2F6275", sunday: "#A63D2A", holiday: "#A63D2A" },
  holidayNameText: "#A63D2A", memoBg: "#FFFEFA", memoOutOfMonthBg: "#ECE8DA", border: "#B5AE92",
  noteText: "#57534A", tabColor: "#4F6B4A",
};

const golden = JSON.parse(fs.readFileSync(path.join(fixtures.dir.static, "calendar-theme-golden.json"), "utf-8")) as {
  excel: Record<string, Record<string, string>>;
  pdf: Record<string, string[]>;
};

test.describe("既存テーマの維持: 色コード", () => {
  test("ビジネス・ナチュラルの全色コードと名称が、拡張前と同じ", () => {
    // description は説明文なので比較しない。色コードと名称だけを固定する
    const strip = (t: Record<string, unknown>) => {
      const rest = { ...t };
      delete rest.description;
      return rest;
    };
    expect(strip(getCalendarTheme("business") as unknown as Record<string, unknown>)).toEqual(BUSINESS_LITERAL);
    expect(strip(getCalendarTheme("natural") as unknown as Record<string, unknown>)).toEqual(NATURAL_LITERAL);
    expect(CALENDAR_THEMES.business.id).toBe("business");
    expect(CALENDAR_THEMES.natural.id).toBe("natural");
  });
});

test.describe("既存テーマの維持: Excel・PDFの出力", () => {
  for (const key of Object.keys(golden.excel)) {
    const [id, fy, ws, orient, adj] = key.split("|");
    test(`出力が拡張前と同じ: ${key}`, async () => {
      test.setTimeout(120_000);
      const calendar = buildFiscalCalendar({ fiscalYear: Number(fy), weekStart: ws as WeekStart });
      const theme = CALENDAR_THEMES[id as "business" | "natural"];
      const x = await buildCalendarExcel({ calendar, theme, orientation: orient as "landscape" | "portrait", showAdjacentDays: adj === "adj" });
      expect(excelFingerprint(new Uint8Array(await x.arrayBuffer())), `Excel ${key}`).toEqual(golden.excel[key]);
      const p = await buildCalendarPdf({
        calendar, theme, orientation: orient as "landscape" | "portrait", showAdjacentDays: adj === "adj", fontBytes: readFontBytes(),
      });
      expect(await pdfFingerprint(new Uint8Array(await p.blob.arrayBuffer())), `PDF ${key}`).toEqual(golden.pdf[key]);
    });
  }
});
