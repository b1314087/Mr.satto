import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { extractTextBoxes, readFontBytes, type PageBoxes, type TextBox } from "../helpers/pdf-text-boxes";
import { buildCalendarPdf, layoutHolidayName, pdfMonthLayout, type CalendarPdfOrientation } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { CALENDAR_THEMES, type CalendarThemeId } from "@/lib/calendar/themes";
import { getHolidays } from "@/lib/calendar/holidays";

/**
 * 年度カレンダーのPDF出力のテスト（工程C）。
 * PDFを実際に読み取り、文字の位置・大きさから、次の独立した参照データと突き合わせる。
 *   - 月の表の開始日と週数: Python標準calendar（calendar-grid-reference.json）
 *   - 祝日名: python-holidays（holidays-reference-python-holidays-2000-2099.json）
 * レイアウトの決まり（余白10mm、タイトル帯34pt、曜日見出し20pt、注記欄16pt、7列の等分）は、
 * このファイルに書き直して使い、実装の関数から期待値を作らない。
 */

const STATIC = fixtures.dir.static;
const grid = JSON.parse(fs.readFileSync(path.join(STATIC, "calendar-grid-reference.json"), "utf-8")) as Record<string, [string, number]>;
const holidayRef = JSON.parse(
  fs.readFileSync(path.join(STATIC, "holidays-reference-python-holidays-2000-2099.json"), "utf-8"),
).holidays as Record<string, [string, string][]>;
const refName = (iso: string) => holidayRef[iso.slice(0, 4)]?.find(([d]) => d === iso)?.[1];

const MARGIN = (10 * 72) / 25.4;
const TITLE_H = 34;
const HEADER_H = 20;
const NOTE_H = 16;
const A4 = { w: 595.28, h: 841.89 };

const fontBytes = readFontBytes();

async function make(fy: number, ws: WeekStart, theme: CalendarThemeId, orientation: CalendarPdfOrientation, adjacent = false) {
  const { blob, pageCount } = await buildCalendarPdf({
    calendar: buildFiscalCalendar({ fiscalYear: fy, weekStart: ws }),
    theme: CALENDAR_THEMES[theme],
    orientation,
    showAdjacentDays: adjacent,
    fontBytes,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, pageCount, pages: await extractTextBoxes(bytes) };
}

function monthOfPage(fy: number, index: number) {
  const m = ((3 + index) % 12) + 1;
  return { y: index < 9 ? fy : fy + 1, m };
}

function dayOffset(startIso: string, days: number): string {
  return new Date(Date.parse(`${startIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** ページの寸法と週数から、独立にマスの位置を求める */
function geometry(page: PageBoxes, weeks: number) {
  const contentW = page.width - MARGIN * 2;
  const contentH = page.height - MARGIN * 2;
  const gridTop = page.height - MARGIN - TITLE_H - HEADER_H;
  const rowH = (contentH - TITLE_H - HEADER_H - NOTE_H) / weeks;
  return { cellW: contentW / 7, rowH, gridTop, contentW };
}

function cellOf(page: PageBoxes, weeks: number, box: TextBox): { row: number; col: number } {
  const g = geometry(page, weeks);
  return { col: Math.floor((box.x - MARGIN) / g.cellW), row: Math.floor((g.gridTop - box.y) / g.rowH) };
}

/** 日付の数字（サイズが大きい1〜2桁の数字だけの文字列） */
const dateNumbers = (p: PageBoxes) => p.boxes.filter((b) => /^\d{1,2}$/.test(b.str) && b.size >= 13);

test.describe("年度カレンダーPDF: ページ構成", () => {
  for (const orientation of ["landscape", "portrait"] as const) {
    test(`月別12ページで、各ページがA4（${orientation === "landscape" ? "横" : "縦"}）`, async () => {
      const { pageCount, pages } = await make(2026, "mon", "business", orientation);
      expect(pageCount).toBe(12);
      expect(pages).toHaveLength(12);
      for (const p of pages) {
        const [w, h] = orientation === "landscape" ? [A4.h, A4.w] : [A4.w, A4.h];
        expect(p.width).toBeCloseTo(w, 0);
        expect(p.height).toBeCloseTo(h, 0);
      }
    });
  }

  test("ページと月の対応: 4月→翌年3月の順で、タイトルに年・月、和暦と年度が入る", async () => {
    const { pages } = await make(2026, "mon", "business", "landscape");
    pages.forEach((p, i) => {
      const { y, m } = monthOfPage(2026, i);
      expect(p.boxes.some((b) => b.str === `${y}年${m}月`), `${y}年${m}月`).toBe(true);
      // 和暦と年度は全角空白で区切って1回で描いており、PDFの読み取りでは2つの文字列に分かれる
      expect(p.boxes.some((b) => b.str === "2026年度"), `年度 p${i + 1}`).toBe(true);
    });
    expect(pages[0].boxes.some((b) => b.str === "令和8年4月")).toBe(true);
    expect(pages[9].boxes.some((b) => b.str === "令和9年1月")).toBe(true);
    expect(pages[11].boxes.some((b) => b.str === "令和9年3月")).toBe(true);
  });

  for (const ws of ["mon", "sun"] as const) {
    test(`曜日見出しが${ws === "mon" ? "月〜日" : "日〜土"}の順で、各列の中央に並ぶ`, async () => {
      const { pages } = await make(2026, ws, "business", "landscape");
      const expected = ws === "mon" ? ["月", "火", "水", "木", "金", "土", "日"] : ["日", "月", "火", "水", "木", "金", "土"];
      for (const p of pages) {
        const headerY = p.height - MARGIN - TITLE_H - HEADER_H + 6;
        const labels = p.boxes.filter((b) => Math.abs(b.y - headerY) < 1 && expected.includes(b.str)).sort((a, b) => a.x - b.x);
        expect(labels.map((b) => b.str)).toEqual(expected);
        const cellW = (p.width - MARGIN * 2) / 7;
        labels.forEach((b, c) => expect(b.x + b.width / 2, `${b.str}`).toBeCloseTo(MARGIN + cellW * (c + 0.5), 0));
      }
    });
  }

  test("日本語フォント（Noto Sans JP）が埋め込まれ、日本語がテキストとして取り出せる", async () => {
    const { bytes, pages } = await make(2026, "mon", "natural", "portrait");
    // PDFの中のフォント定義（/BaseFont）を直接調べる（本体は圧縮されているため、pdf-libで読む）
    const { PDFDocument, PDFName, PDFDict } = await import("pdf-lib");
    const pdf = await PDFDocument.load(bytes);
    const baseFonts: string[] = [];
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Font")) {
        baseFonts.push(String(obj.get(PDFName.of("BaseFont"))));
      }
    }
    expect(baseFonts.some((n) => n.includes("NotoSansJP"))).toBe(true);
    const all = pages.flatMap((p) => p.boxes.map((b) => b.str)).join("");
    for (const word of ["年度", "令和", "憲法記念日", "文化の日", "勤労感謝の日", "月", "日"]) expect(all).toContain(word);
    expect(all).not.toContain("�");
  });

  test("文書のタイトルと言語が設定される", async () => {
    const { bytes } = await make(2026, "mon", "business", "landscape");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("2026年度 カレンダー");
  });
});

test.describe("年度カレンダーPDF: 日付・曜日・祝日名", () => {
  for (const [fy, ws, orientation] of [
    [2026, "mon", "landscape"],
    [2026, "sun", "portrait"],
    [2027, "mon", "portrait"],
    [2023, "sun", "landscape"],
  ] as const) {
    test(`${fy}年度・${ws === "mon" ? "月曜" : "日曜"}始まり・${orientation}: 日付が正しい列・行にあり、祝日名が同じマスにある`, async () => {
      const { pages } = await make(fy, ws, "business", orientation);
      const problems: string[] = [];
      pages.forEach((p, i) => {
        const { y, m } = monthOfPage(fy, i);
        const [start, weeks] = grid[`${y}-${m}-${ws}`];
        const nums = dateNumbers(p);
        const names = p.boxes.filter((b) => !/^\d{1,2}$/.test(b.str) && b.size < 12 && cellOf(p, weeks, b).row >= 0 && cellOf(p, weeks, b).row < weeks);
        const seen = new Set<string>();
        for (const n of nums) {
          const { row, col } = cellOf(p, weeks, n);
          if (row < 0 || row >= weeks || col < 0 || col > 6) {
            problems.push(`p${i + 1} 数字${n.str}がグリッド外 (${row},${col})`);
            continue;
          }
          const iso = dayOffset(start, row * 7 + col);
          if (Number(iso.slice(8)) !== Number(n.str)) problems.push(`p${i + 1} (${row},${col}) 期待=${iso} 実際=${n.str}`);
          if (!iso.startsWith(`${y}-${String(m).padStart(2, "0")}-`)) problems.push(`p${i + 1} ${iso} はその月でないのに表示`);
          seen.add(iso);
        }
        // その月の全日が1回ずつ
        const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
        if (seen.size !== daysInMonth || nums.length !== daysInMonth) problems.push(`p${i + 1} 表示された日数=${nums.length}/${seen.size} 期待=${daysInMonth}`);
        // 祝日名: 同じマスにある
        for (const iso of seen) {
          let expected = refName(iso);
          if (expected && iso > "2027-12-31" && /^(春分|秋分)の日$/.test(expected)) expected += "※";
          const idx = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
          const inCell = names.filter((b) => {
            const c = cellOf(p, weeks, b);
            return c.row === Math.floor(idx / 7) && c.col === idx % 7;
          });
          // 折り返された場合は、同じマス内の文字列をつなげる
          const actual = inCell.sort((a, b) => b.y - a.y).map((b) => b.str).join("") || undefined;
          if (actual !== expected) problems.push(`p${i + 1} ${iso} 祝日名=${actual} 期待=${expected}`);
        }
      });
      expect(problems).toEqual([]);
    });
  }

  test("うるう年: 2028年2月（2027年度）に29日があり、2027年2月（2026年度）にはない", async () => {
    const leap = (await make(2027, "mon", "business", "landscape")).pages[10];
    expect(dateNumbers(leap).map((b) => b.str)).toContain("29");
    expect(dateNumbers(leap)).toHaveLength(29);
    const common = (await make(2026, "mon", "business", "landscape")).pages[10];
    expect(dateNumbers(common)).toHaveLength(28);
  });

  test("未確定（推定）の祝日には※が付き、その月のページにだけ注記が出る", async () => {
    const { pages } = await make(2027, "mon", "business", "landscape");
    expect(pages[11].boxes.some((b) => b.str === "春分の日※")).toBe(true);
    expect(pages[11].boxes.some((b) => b.str.startsWith("※は国立天文台の暦要項")), "3月の注記").toBe(true);
    for (let i = 0; i < 11; i++) expect(pages[i].boxes.some((b) => b.str.includes("推定日")), `p${i + 1}`).toBe(false);
  });

  test("前後の月の日付を表示するオプション: 既定は空欄、オンにするとその月以外の数字も出る", async () => {
    const off = (await make(2026, "mon", "business", "landscape", false)).pages[0];
    expect(dateNumbers(off)).toHaveLength(30);
    const on = (await make(2026, "mon", "business", "landscape", true)).pages[0];
    // 2026年4月（月曜始まり）の表は 3/30〜5/3 の35日
    expect(dateNumbers(on)).toHaveLength(35);
  });
});

test.describe("年度カレンダーPDF: 文字切れ・重なり・余白", () => {
  for (const orientation of ["landscape", "portrait"] as const) {
    for (const ws of ["mon", "sun"] as const) {
      test(`全ページで、文字が用紙の余白の内側にあり、文字どうしが重ならない（${orientation}・${ws}）`, async () => {
        const problems: string[] = [];
        for (const fy of [2026, 2027]) {
          const { pages } = await make(fy, ws, "natural", orientation);
          pages.forEach((p, i) => {
            const boxes = p.boxes.map((b) => ({ ...b, top: b.y + b.size * 0.85, bottom: b.y - b.size * 0.2, right: b.x + b.width }));
            for (const b of boxes) {
              if (b.x < MARGIN - 0.5 || b.right > p.width - MARGIN + 0.5 || b.bottom < MARGIN - 0.5 || b.top > p.height - MARGIN + 0.5) {
                problems.push(`${fy} p${i + 1} 「${b.str}」が余白にかかる`);
              }
            }
            for (let a = 0; a < boxes.length; a++) {
              for (let c = a + 1; c < boxes.length; c++) {
                const A = boxes[a];
                const B = boxes[c];
                const overlapX = Math.min(A.right, B.right) - Math.max(A.x, B.x);
                const overlapY = Math.min(A.top, B.top) - Math.max(A.bottom, B.bottom);
                if (overlapX > 0.5 && overlapY > 0.5) problems.push(`${fy} p${i + 1} 「${A.str}」と「${B.str}」が重なる`);
              }
            }
          });
        }
        expect(problems).toEqual([]);
      });

      test(`日付の数字・祝日名が、自分のマスの中に収まる（${orientation}・${ws}）`, async () => {
        const problems: string[] = [];
        for (const fy of [2026, 2027]) {
          const { pages } = await make(fy, ws, "business", orientation);
          pages.forEach((p, i) => {
            const { y, m } = monthOfPage(fy, i);
            const weeks = grid[`${y}-${m}-${ws}`][1];
            const g = geometry(p, weeks);
            for (const b of p.boxes) {
              const c = cellOf(p, weeks, b);
              if (c.row < 0 || c.row >= weeks) continue; // タイトル・見出し・注記
              const left = MARGIN + c.col * g.cellW;
              const top = g.gridTop - c.row * g.rowH;
              if (b.x < left + 1 || b.x + b.width > left + g.cellW - 1) problems.push(`${fy} p${i + 1} 「${b.str}」が左右のマスからはみ出す`);
              if (b.y + b.size * 0.85 > top - 1 || b.y - b.size * 0.2 < top - g.rowH + 1) problems.push(`${fy} p${i + 1} 「${b.str}」が上下のマスからはみ出す`);
            }
          });
        }
        expect(problems).toEqual([]);
      });
    }
  }

  test("実装のレイアウト計算が、このテストの独立な計算と一致する（余白10mm・7列等分・行の高さ）", () => {
    for (const orientation of ["landscape", "portrait"] as const) {
      for (const weeks of [4, 5, 6]) {
        const L = pdfMonthLayout(weeks, orientation);
        const [w, h] = orientation === "landscape" ? [A4.h, A4.w] : [A4.w, A4.h];
        expect(L.pageWidth).toBeCloseTo(w, 0);
        expect(L.margin).toBeCloseTo(MARGIN, 3);
        expect(L.cellWidth).toBeCloseTo((w - MARGIN * 2) / 7, 3);
        expect(L.rowHeight).toBeCloseTo((h - MARGIN * 2 - TITLE_H - HEADER_H - NOTE_H) / weeks, 3);
      }
    }
  });
});

test.describe("年度カレンダーPDF: 祝日名の収まり", () => {
  test("対応する全年の全祝日名（※付きを含む）が、横・縦どちらでもマスの幅に収まり、2行まで・6pt以上で配置される", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const fontkit = (await import("@pdf-lib/fontkit")).default;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: false });
    const names = new Set<string>();
    for (let y = 2000; y <= 2099; y++) for (const h of getHolidays(y)) names.add(h.name).add(`${h.name}※`);
    expect(names.size).toBeGreaterThan(15);
    for (const orientation of ["landscape", "portrait"] as const) {
      const L = pdfMonthLayout(5, orientation);
      const inner = L.cellWidth - 8;
      const numberSize = orientation === "landscape" ? 16 : 14;
      const numberWidth = font.widthOfTextAtSize("30", numberSize);
      const base = orientation === "landscape" ? 10 : 8.5;
      for (const name of names) {
        const layout = layoutHolidayName(font, name, base, inner - numberWidth - 4, inner);
        expect(layout.size, `${name} ${orientation}`).toBeGreaterThanOrEqual(6);
        expect(layout.lines.length, `${name} ${orientation}`).toBeLessThanOrEqual(2);
        for (const line of layout.lines) {
          const limit = layout.sameLine ? inner - numberWidth - 4 : inner;
          expect(font.widthOfTextAtSize(line, layout.size), `${name} ${orientation}`).toBeLessThanOrEqual(limit + 0.01);
        }
        expect(layout.lines.join(""), name).toBe(name);
      }
    }
  });
});
