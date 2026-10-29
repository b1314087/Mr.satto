import { test, expect } from "@playwright/test";
import {
  computeColumnBreaksAcrossPages,
  groupIntoLines,
  reconstructTable,
  splitItemsAtNumericGaps,
} from "@/lib/pdf/table-reconstruction";
import type { PositionedTextItem } from "@/lib/pdf/pdfjs-client";

/**
 * 検証用に作った様々なPDF(詰まった数値の列・請求書・表と文章の混在)で見つかった
 * 「列が1つにつながる」「文章が列の途中で切れる」不具合の回帰テスト。
 */

const FH = 10;
const item = (str: string, x: number, y: number, width: number): PositionedTextItem => ({
  str,
  x,
  y,
  width,
  height: FH,
  fontHeight: FH,
  hasEOL: false,
});
/** 1文字10ptの全角文字、5.56ptの数字(カンマ2.78pt)で幅を決めて項目を作る */
const textWidth = (s: string) =>
  [...s].reduce((sum, ch) => sum + (/[0-9]/.test(ch) ? 5.56 : ch === "," || ch === "." ? 2.78 : 10), 0);
const t = (str: string, x: number, y: number) => item(str, x, y, textWidth(str));

function tableOf(items: PositionedTextItem[]) {
  const breaks = computeColumnBreaksAcrossPages([groupIntoLines(items)]);
  return reconstructTable(items, breaks);
}

test.describe("1つの項目に隠れた数値同士の隙間", () => {
  test("「789 2」のように隣の列の数値とつながった項目は、数値ごとに分ける", () => {
    // pdfjsが「3,456,789」と「2,765,432」の間の隙間を空白にして、1つの項目にまとめた例
    const merged = item("789 2", 103.2, 700, 26.7);
    const [a, b] = splitItemsAtNumericGaps([merged]);
    expect(a.str).toBe("789");
    expect(b.str).toBe("2");
    expect(a.x).toBeCloseTo(103.2, 1);
    expect(b.x).toBeGreaterThan(a.x + a.width + 3); // 隙間が見える
    expect(b.x + b.width).toBeCloseTo(103.2 + 26.7, 1);
  });

  test("文章や、数値以外を含む項目は分けない", () => {
    const sentence = item("Web サイト 30 000", 10, 700, 80);
    expect(splitItemsAtNumericGaps([sentence])).toHaveLength(1);
    const label = item("TEL 03", 10, 700, 40);
    expect(splitItemsAtNumericGaps([label])).toHaveLength(1);
  });

  test("数値が詰まって(隙間4.5pt)並ぶ表でも、列が分かれる", () => {
    const rows: [string, string, string][] = [
      ["1,234,567", "987,654", "246,913"],
      ["2,345,678", "1,876,543", "469,135"],
      ["3,456,789", "2,765,432", "691,357"],
      ["7,037,034", "5,629,629", "1,407,405"],
    ];
    const items: PositionedTextItem[] = [];
    rows.forEach((r, i) => {
      const y = 700 - i * 17;
      // 右端をそろえた3列。列の右端は 120 / 169 / 218
      items.push(t("月", 55, y));
      items.push(t(r[0], 120 - textWidth(r[0]), y));
      // 前の列と次の列が「文字列として」つながって1つの項目になっている状態を再現する
      const joined = `${r[1]}`;
      items.push(t(joined, 169 - textWidth(joined), y));
      items.push(t(r[2], 218 - textWidth(r[2]), y));
    });
    const table = tableOf(splitItemsAtNumericGaps(items));
    expect(table.columnCount).toBe(4);
    expect(table.rows[1].slice(1)).toEqual(["2,345,678", "1,876,543", "469,135"]);
  });
});

test.describe("表の上の長い行・表の中の長いラベルがあっても列が残る", () => {
  // 請求書: 品名(x50)・数量(右端366)・単価(右端454)・金額(右端542)
  const invoice = () => {
    const it: PositionedTextItem[] = [];
    let y = 700;
    const next = () => (y -= 24);
    // 表の上のタイトルと宛名(左側だけ)
    it.push(t("請 求 書", 276, y));
    it.push(t("株式会社サンプル御中", 50, next()));
    // 表の上の「請求日」「請求番号」: 単価・金額の列にまたがる長い文字列
    it.push(item("請求日：2026年10月30日", 422, next(), 126));
    it.push(item("請求番号：INV-2026-0042", 419, next(), 129));
    next();
    const header = next();
    it.push(t("品名", 50, header), t("数量", 346, header), t("単価", 404, header), t("金額", 492, header));
    const body: [string, string, string, string][] = [
      ["Webサイト保守", "1", "30,000", "30,000"],
      ["サーバー費用", "1", "8,800", "8,800"],
      ["追加ページ作成", "3", "12,000", "36,000"],
    ];
    for (const [name, qty, price, amount] of body) {
      const by = next();
      it.push(t(name, 50, by), t(qty, 366 - textWidth(qty), by), t(price, 454 - textWidth(price), by), t(amount, 542 - textWidth(amount), by));
    }
    // 合計欄: ラベルが単価の列から金額の列の手前まで伸びる(消費税(10%)は幅が広い)
    const sub = next();
    it.push(t("小計", 425, sub), t("74,800", 542 - textWidth("74,800"), sub));
    const tax = next();
    it.push(t("消費税(10%)", 425, tax), t("7,480", 542 - textWidth("7,480"), tax));
    const total = next();
    it.push(t("合計", 425, total), t("82,280", 542 - textWidth("82,280"), total));
    return it;
  };

  test("数量・単価・金額が別々の列になり、「請求日」などの長い行は1つのセルに入る", () => {
    const table = tableOf(invoice());
    const header = table.rows.find((r) => r.includes("品名"))!;
    expect(header.filter((c) => c !== "")).toEqual(["品名", "数量", "単価", "金額"]);
    const qtyRow = table.rows.find((r) => r.includes("Webサイト保守"))!;
    expect(qtyRow.filter((c) => c !== "")).toEqual(["Webサイト保守", "1", "30,000", "30,000"]);
    // 長い行は途中で切れずに1つのセルにそのまま入る
    const dateRow = table.rows.find((r) => r.some((c) => c.startsWith("請求日")))!;
    expect(dateRow.filter((c) => c !== "")).toEqual(["請求日：2026年10月30日"]);
  });

  test("1つの列に短い値が数行だけ入っている列(数量)は、長い行の許容で隙間に埋もれない", () => {
    const table = tableOf(invoice());
    const qty = table.rows.map((r) => r[table.rows.find((x) => x.includes("数量"))!.indexOf("数量")]);
    // 表の上のタイトル(請 求 書)が同じ位置に入ることがあるため、数量の見出しと値だけを確認する
    expect(qty.filter((c) => c !== "" && c !== "請 求 書")).toEqual(["数量", "1", "1", "3"]);
  });
});

test.describe("接している文字列は列区切りで切らない", () => {
  test("フォントの切り替わりで項目が分かれた1つの文は、列区切りをまたいでも1つのセルに残す", () => {
    // 表の列区切りは x=240 付近にある。「作業予定表」の項目が 200〜330 に隙間なく並ぶ
    const items: PositionedTextItem[] = [];
    for (let i = 0; i < 4; i++) {
      const y = 700 - i * 20;
      items.push(t("項目", 50, y), t(String(10 + i), 300 - textWidth(String(10 + i)), y));
      items.push(t("金額", 340, y));
    }
    // 表の上のタイトル(3つの項目が接している): 50〜 に始まり x=300 を超える
    items.push(item("作業", 50, 760, 40), item("予定", 90, 760, 40), item("2026", 130, 760, 22.2), item("年度", 152.2, 760, 20));
    const table = tableOf(items);
    const title = table.rows.find((r) => r.some((c) => c.includes("作業")))!;
    expect(title.filter((c) => c !== "")).toEqual(["作業予定2026年度"]);
  });
});
