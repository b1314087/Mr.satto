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

test.describe("セルの中で折り返した文章", () => {
  test("折り返した2行目は、1つ上の行の同じセルにつなげる。通常の行は別の行のまま", () => {
    // 列: No(x50) / 項目(x90) / 内容(x160〜420)。通常の行間は30、折り返しの行間は16
    const items: PositionedTextItem[] = [];
    const rowY = [700, 670, 624, 594];
    ["No.", "1", "2", "3"].forEach((v, i) => items.push(t(v, 50, rowY[i])));
    ["項目", "目的", "対象", "期間"].forEach((v, i) => items.push(t(v, 90, rowY[i])));
    items.push(t("内容", 160, 700));
    // 1行目の内容は右端(420)近くまで届いて折り返し、2行目(y=654)は「る。」だけ
    items.push(item("新入社員の研修計画を立て、早期に業務へ慣れてもらう", 160, 670, 255));
    items.push(item("る。", 160, 654, 20));
    items.push(item("今年度入社の全社員。", 160, 624, 100));
    items.push(item("4月から6月までとする。", 160, 594, 110));
    const table = tableOf(items);
    const texts = table.rows.map((r) => r.join("|"));
    expect(table.rows.length).toBe(4);
    expect(texts[1]).toContain("新入社員の研修計画を立て、早期に業務へ慣れてもらうる。");
    expect(texts[2]).toContain("今年度入社の全社員。");
  });

  test("全部の行が同じ間隔で並ぶ詰まった表の、1つの列だけが入った行は、結合しない", () => {
    const items: PositionedTextItem[] = [];
    // 行間12で並ぶ表(文字の高さ10)。3行目は1列だけに値がある
    const ys = [700, 688, 676, 664, 652];
    items.push(t("A", 50, ys[0]), t("B", 200, ys[0]));
    items.push(t("りんご", 50, ys[1]), t("みかん", 200, ys[1]));
    items.push(t("ぶどう", 50, ys[2]));
    items.push(t("もも", 50, ys[3]), t("なし", 200, ys[3]));
    items.push(t("かき", 50, ys[4]), t("くり", 200, ys[4]));
    const table = tableOf(items);
    expect(table.rows.length).toBe(5);
  });
});

test.describe("数値の列は、行数が少なくても隙間に埋もれない", () => {
  test("出金・入金のように、片方にしか値が入らない行が多い列も、別の列として分かれる", () => {
    const items: PositionedTextItem[] = [];
    for (let i = 0; i < 12; i++) {
      const y = 700 - i * 20;
      items.push(t(`2026/09/${String(i + 1).padStart(2, "0")}`, 52, y), t("摘要" + i, 160, y));
      if (i % 3 === 0) {
        const v = "280,000";
        items.push(t(v, 449 - textWidth(v), y)); // 入金(右端449)
      } else {
        const v = "4,370";
        items.push(t(v, 369 - textWidth(v), y)); // 出金(右端369)
      }
    }
    const table = tableOf(items);
    // 出金の値と入金の値が、別々の列に入る
    const outCol = table.rows[1].findIndex((c) => c === "4,370");
    const inCol = table.rows[0].findIndex((c) => c === "280,000");
    expect(outCol).toBeGreaterThan(-1);
    expect(inCol).toBeGreaterThan(-1);
    expect(outCol).not.toBe(inCol);
  });
});
