import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { pageSizes, pdfText, words, type Word } from "../helpers/chart-pdf-inspect";
import { convert } from "../helpers/print-audit";

/**
 * Excel→PDF：行の高さが保存されていない行の、行の高さの自動の計算の検証(性質のテスト)。
 *
 * テスト用のブックと期待値は tests/fixtures/static/excel-ooxml-spec/(tests/fixtures/excel-ooxml-spec/generate_spec_excel.py)。
 * 列Aに折り返す文字、列Bに行の目印 R{行} がある(どちらも縦の配置は「上」。行の目印から次の行の目印までが、その行の高さ)。確かめること:
 *  - 折り返したセルの文字が、すべて、その行の範囲(その行の目印〜次の行の目印)の中にあり、欠けず、1回だけ出る
 *  - 文字の行が多い行ほど高い・大きな文字の行は文字の大きさ以上・高さを保存した行はその高さ・回転した文字の行は文字の長さぶん
 *  - セル内改行(折り返す)は行が分かれ、折り返さないセルの改行は1行のまま・非表示の行は印刷しない
 *  - 長いシート：行を増やしても、ページ数は減らない
 *  - フォント・文字の大きさ・字下げ・縦書きによる行の高さの関係(同じ内容は同じ高さ・大きな文字/行の高いフォントは低くならない)、
 *    自動で決まる行の高さが0.75pt(96dpiの画面の1点)の倍数であること、非表示の列の文字を印刷しないこと
 * Microsoft Excelの行の高さの数値とは比べていない。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "excel-ooxml-spec");

interface RowSpec {
  row: number;
  words: string[];
  kind: string;
  minBand?: number;
  band?: number | null;
  distinctLines?: number;
}
interface SpecExpect {
  title: string;
  rows: RowSpec[];
  lastRow: number;
  absent: string[];
  /** 行どうしの関係：equal=同じ高さ、greaterEq=[a, b] で a の行は b の行より低くない、multiple075=行の高さが0.75ptの倍数 */
  checks?: { equal: [number, number][]; greaterEq: [number, number][]; multiple075: number[] };
}

function located(pdf: string): Map<string, { page: number; w: Word }[]> {
  const out = new Map<string, { page: number; w: Word }[]>();
  const n = pageSizes(pdf).length;
  for (let p = 1; p <= n; p++) for (const w of words(pdf, p)) out.set(w.text, [...(out.get(w.text) ?? []), { page: p, w }]);
  return out;
}

function checkRows(pdf: string, e: SpecExpect): string[] {
  const problems: string[] = [];
  const found = located(pdf);
  const one = (t: string) => {
    const f = found.get(t) ?? [];
    if (f.length !== 1) problems.push(`${t} が${f.length === 0 ? "無い" : `${f.length}回出た`}`);
    return f[0];
  };
  const bands: { spec: RowSpec; band: number }[] = [];
  for (const spec of e.rows) {
    const marker = one(`R${spec.row}`);
    // 次の(印刷される)行の目印
    let next: { page: number; w: Word } | undefined;
    for (let r = spec.row + 1; r <= e.lastRow && !next; r++) next = (found.get(`R${r}`) ?? [])[0];
    const ws = spec.words.map((t) => one(t));
    if (!marker) continue;
    const bottom = next && next.page === marker.page ? next.w.y : null;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (!w) continue;
      if (w.page !== marker.page) {
        problems.push(`${spec.words[i]} が、行の目印 R${spec.row} と違うページにある`);
        continue;
      }
      // 文字の並ぶ線(ベースライン)が、行の範囲の中にあるか。pdftotext の文字の枠は、PDFに埋め込んだ Noto Sans JP の
      // 高さ(アセント1.16・ディセント0.288、合計1.448)で決まるので、枠の下端から、ディセントの分を引いてベースラインを求める
      const size = (w.w.y2 - w.w.y) / 1.448;
      const baseline = w.w.y2 - 0.288 * size;
      if (baseline < marker.w.y - 1 || (bottom !== null && baseline > bottom + 1)) problems.push(`${spec.words[i]} が、行 ${spec.row} の範囲からはみ出している(行の高さが足りない)`);
    }
    if (bottom !== null) {
      const band = bottom - marker.w.y;
      bands.push({ spec, band });
      if (spec.minBand !== undefined && band < spec.minBand) problems.push(`行 ${spec.row}(${spec.kind})の高さ：期待 ${spec.minBand}pt以上、実際 ${band.toFixed(1)}pt`);
      if (spec.band !== undefined && spec.band !== null && Math.abs(band - spec.band) > 1) problems.push(`行 ${spec.row}(${spec.kind})の高さ：期待 ${spec.band}pt、実際 ${band.toFixed(1)}pt`);
    }
    if (spec.distinctLines !== undefined) {
      const ys = new Set(ws.filter(Boolean).map((w) => Math.round(w!.w.y2)));
      if (ys.size !== spec.distinctLines) problems.push(`行 ${spec.row}(${spec.kind})の文字の行の数：期待 ${spec.distinctLines}、実際 ${ys.size}`);
    }
  }
  // 単語の数が増える(折り返す行が増える)行は、高さが減らない
  const wraps = bands.filter((b) => b.spec.kind === "wrap" && e.rows.length < 40);
  for (let i = 1; i < wraps.length; i++) {
    if (wraps[i].spec.words.length > wraps[i - 1].spec.words.length && wraps[i].band < wraps[i - 1].band - 0.5)
      problems.push(`行 ${wraps[i].spec.row} は、単語が多いのに、行 ${wraps[i - 1].spec.row} より低い`);
  }
  const bandOf = new Map(bands.map((b) => [b.spec.row, b.band]));
  for (const [a, b] of e.checks?.equal ?? []) {
    const ha = bandOf.get(a);
    const hb = bandOf.get(b);
    if (ha !== undefined && hb !== undefined && Math.abs(ha - hb) > 0.05) problems.push(`行 ${a} と行 ${b} は同じ高さのはず(${ha.toFixed(2)} と ${hb.toFixed(2)})`);
  }
  for (const [a, b] of e.checks?.greaterEq ?? []) {
    const ha = bandOf.get(a);
    const hb = bandOf.get(b);
    if (ha !== undefined && hb !== undefined && ha < hb - 0.05) problems.push(`行 ${a}(${ha.toFixed(2)}pt)が、行 ${b}(${hb.toFixed(2)}pt)より低い`);
  }
  for (const r of e.checks?.multiple075 ?? []) {
    const h = bandOf.get(r);
    if (h !== undefined && Math.abs(h / 0.75 - Math.round(h / 0.75)) > 0.05) problems.push(`行 ${r} の高さ ${h.toFixed(3)}pt が、0.75pt(画面の1点)の倍数でない`);
  }
  const text = pdfText(pdf);
  for (const t of e.absent) if (text.includes(t)) problems.push(`${t} が出ている(出てはいけない)`);
  return problems;
}

const load = (f: string): SpecExpect => JSON.parse(fs.readFileSync(path.join(DIR, f.replace(".xlsx", ".expect.json")), "utf-8"));

test.describe.configure({ mode: "parallel" });

test("e01 行の高さの自動の計算(折り返し・改行・文字の大きさ・回転・固定・非表示)", async ({ page }) => {
  test.setTimeout(200_000);
  const { pdf } = await convert(page, path.join(DIR, "e01-auto-row-height.xlsx"));
  const problems = checkRows(pdf, load("e01-auto-row-height.xlsx"));
  expect(problems, problems.join("\n")).toEqual([]);
});

test("e03 フォント・大きさ・日本語・字下げ・縦書き・非表示の列：行の高さの関係と、0.75ptの倍数", async ({ page }) => {
  test.setTimeout(200_000);
  const { pdf } = await convert(page, path.join(DIR, "e03-fonts-indent-vertical.xlsx"));
  const problems = checkRows(pdf, load("e03-fonts-indent-vertical.xlsx"));
  expect(problems, problems.join("\n")).toEqual([]);
});

test("e02 長いシートの折り返し：欠けない・行の範囲に収まる・行を増やしてもページ数が減らない", async ({ page }) => {
  test.setTimeout(300_000);
  const base = await convert(page, path.join(DIR, "e02-long-wrap.xlsx"));
  const more = await convert(page, path.join(DIR, "e02-long-wrap-more.xlsx"));
  const problems = [
    ...checkRows(base.pdf, load("e02-long-wrap.xlsx")).map((p) => `e02-long-wrap: ${p}`),
    ...checkRows(more.pdf, load("e02-long-wrap-more.xlsx")).map((p) => `e02-long-wrap-more: ${p}`),
  ];
  if (pageSizes(more.pdf).length < pageSizes(base.pdf).length) problems.push("行を増やしたのに、ページ数が減った");
  expect(problems, problems.join("\n")).toEqual([]);
});
