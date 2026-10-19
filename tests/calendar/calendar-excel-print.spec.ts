import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { extractTextBoxes } from "../helpers/pdf-text-boxes";
import { buildCalendarExcel, type CalendarOrientation } from "@/lib/calendar/excel";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { CALENDAR_THEMES, type CalendarThemeId } from "@/lib/calendar/themes";

/**
 * 年度カレンダーExcelを、LibreOfficeで実際に印刷（PDF化）して確かめるテスト。
 * 「印刷設定のXMLがある」だけでなく、「1シートが1ページに収まり、用紙の向きと余白が守られる」ことを
 * 印刷結果で確認する。LibreOffice（soffice）が無い環境では実行しない。
 * 注意: これはExcel本体ではなくLibreOfficeでの印刷結果。Excel本体での確認は別途行う。
 */

const run = promisify(execFile);

function hasSoffice(): boolean {
  try {
    execFileSync("soffice", ["--version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const SOFFICE = hasSoffice();

const MARGIN = (10 * 72) / 25.4;
const A4 = { w: 595.28, h: 841.89 };

interface Variant {
  name: string;
  fy: number;
  ws: WeekStart;
  theme: CalendarThemeId;
  orientation: CalendarOrientation;
}

const VARIANTS: Variant[] = [
  { name: "a", fy: 2026, ws: "mon", theme: "business", orientation: "landscape" },
  { name: "b", fy: 2027, ws: "sun", theme: "natural", orientation: "portrait" },
];

test.describe("年度カレンダーExcel: LibreOfficeでの印刷結果", () => {
  test.skip(!SOFFICE, "LibreOffice(soffice)が無い環境のため、印刷結果の確認は未実施");
  test.setTimeout(240_000);

  test("各シートが1ページに収まり、12ページのA4（向き指定どおり）になり、内容が余白の内側に収まる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-print-"));
    try {
      for (const v of VARIANTS) {
        const blob = await buildCalendarExcel({
          calendar: buildFiscalCalendar({ fiscalYear: v.fy, weekStart: v.ws }),
          theme: CALENDAR_THEMES[v.theme],
          orientation: v.orientation,
        });
        fs.writeFileSync(path.join(dir, `${v.name}.xlsx`), Buffer.from(await blob.arrayBuffer()));
      }
      const profile = path.join(dir, "profile");
      await run(
        "soffice",
        [
          `-env:UserInstallation=file://${profile}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          path.join(dir, "out"),
          ...VARIANTS.map((v) => path.join(dir, `${v.name}.xlsx`)),
        ],
        { timeout: 200_000 },
      );

      for (const v of VARIANTS) {
        const pdf = new Uint8Array(fs.readFileSync(path.join(dir, "out", `${v.name}.pdf`)));
        const pages = await extractTextBoxes(pdf);
        expect(pages, `${v.name} ページ数`).toHaveLength(12);
        const [w, h] = v.orientation === "landscape" ? [A4.h, A4.w] : [A4.w, A4.h];
        pages.forEach((p, i) => {
          const label = `${v.name} p${i + 1}`;
          expect(p.width, label).toBeCloseTo(w, 0);
          expect(p.height, label).toBeCloseTo(h, 0);
          const month = ((3 + i) % 12) + 1;
          const year = i < 9 ? v.fy : v.fy + 1;
          // 月のタイトルが、そのページにある（シートの順番どおりに印刷されている）。
          // LibreOfficeは文字を「2026」「年」「4」「月」のように細かく分けて出力するため、同じ行の文字をつなげて調べる
          const titleSize = Math.max(...p.boxes.map((b) => b.size));
          const titleBoxes = p.boxes.filter((b) => b.size >= titleSize - 0.5);
          const titleY = Math.max(...titleBoxes.map((b) => b.y));
          const titleLine = titleBoxes
            .filter((b) => Math.abs(b.y - titleY) < 2)
            .sort((a, b) => a.x - b.x)
            .map((b) => b.str)
            .join("");
          expect(titleLine, `${label} タイトル`).toBe(`${year}年${month}月`);
          // 文字がすべて印刷可能範囲（余白の内側）に収まる
          for (const b of p.boxes) {
            expect(b.x, `${label} 「${b.str}」左`).toBeGreaterThanOrEqual(MARGIN - 1);
            expect(b.x + b.width, `${label} 「${b.str}」右`).toBeLessThanOrEqual(p.width - MARGIN + 1);
            expect(b.y, `${label} 「${b.str}」下`).toBeGreaterThanOrEqual(MARGIN - 1);
            expect(b.y + b.size, `${label} 「${b.str}」上`).toBeLessThanOrEqual(p.height - MARGIN + 1);
          }
          // 縮小されすぎていない（内容が用紙の幅の85%以上を使っている）
          const minX = Math.min(...p.boxes.map((b) => b.x));
          const maxX = Math.max(...p.boxes.map((b) => b.x + b.width));
          expect((maxX - minX) / (p.width - MARGIN * 2), `${label} 幅の使用率`).toBeGreaterThan(0.85);
          // その月の日付の数字がすべて印刷されている
          const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
          // （タイトル帯の中の数字は除く: タイトルの行より20pt以上下にある数字だけが日付）
          const nums = p.boxes
            .filter((b) => /^\d{1,2}$/.test(b.str) && b.y < titleY - 20)
            .map((b) => Number(b.str))
            .sort((a, b) => a - b);
          expect(nums, `${label} 日付`).toEqual(Array.from({ length: daysInMonth }, (_, k) => k + 1));
        });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
