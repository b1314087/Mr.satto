import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { pageSizes, words, type Word } from "../helpers/chart-pdf-inspect";
import { textLines } from "../helpers/word-audit";
import { scratchDir } from "../helpers/tmp";

/**
 * Word→PDF：乱数で構造を変えた文書(6組×5)で、レイアウトの共通の処理が、特定の文書に依らず成り立つべき性質を確かめる。
 *
 * テスト用のDOCXは tests/fixtures/static/word-random/(tests/fixtures/word-random/generate_random_word.py が、
 * シードを固定した乱数で、段落の数・文字数・フォント・文字の大きさ・行間・段落の間隔・表・画像・箇条書き・改ページ・
 * セクション・用紙の向きを変えて作る)。1組ごとに確かめること:
 *  - どの文書でも、目印の文字がちょうど1回ずつ出て、紙の中にある(内容の欠落・重複が無い)
 *  - 同じ文書を2回変換すると、同じ結果になる
 *  - 余白を広くする・文字を大きくする・画像を大きくする・段落を足すと、ページ数は減らない
 *  - 段落・表の行・画像を足しても、前からあった目印の文字は消えない
 *  - 日本語の禁則：行の先頭に句読点・閉じ括弧が来ない。英単語を途中で分けない(PDFの英単語が、元の単語のどれか)
 * Microsoft Wordの結果とは比べていない(Wordのページの区切りそのものではなく、レイアウトの計算の性質を確かめる)。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "word-random");
const manifest: { seed: number; base: string; variants: { file: string; relation: string }[] }[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8")
);

async function convert(page: import("@playwright/test").Page, file: string): Promise<string> {
  const dir = scratchDir("wordrand");
  await page.goto("/tools/word-to-pdf");
  await uploadFixture(page, path.join(DIR, file));
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await page.getByText("完了", { exact: false }).first().waitFor({ timeout: 120_000 });
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return pdf;
}

/** 目印の文字(QnnnMnnn)ごとの、出たページと位置 */
function markersOf(pdf: string): Map<string, { page: number; w: Word }[]> {
  const out = new Map<string, { page: number; w: Word }[]>();
  const sizes = pageSizes(pdf);
  for (let p = 1; p <= sizes.length; p++) {
    for (const w of words(pdf, p)) {
      const m = /Q\d{3}[MT]\d{3}/.exec(w.text);
      if (!m) continue;
      out.set(m[0], [...(out.get(m[0]) ?? []), { page: p, w }]);
    }
  }
  return out;
}

function expectedMarkers(file: string): string[] {
  const e = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".docx", ".expect.json")), "utf-8"));
  return Object.keys(e.markers);
}

function contentProblems(file: string, pdf: string): string[] {
  const problems: string[] = [];
  const found = markersOf(pdf);
  const sizes = pageSizes(pdf);
  const missing = expectedMarkers(file).filter((m) => !found.has(m));
  const dup = [...found.entries()].filter(([, v]) => v.length !== 1).map(([k]) => k);
  const outside = [...found.entries()].filter(([, v]) => v.some((f) => f.w.x < -0.5 || f.w.y < -0.5 || f.w.x2 > sizes[f.page - 1].w + 0.5 || f.w.y2 > sizes[f.page - 1].h + 0.5)).map(([k]) => k);
  if (missing.length) problems.push(`${file}: 出ていない目印 ${missing.length}個(例 ${missing.slice(0, 5).join("・")})`);
  if (dup.length) problems.push(`${file}: 2回以上出た目印 ${dup.length}個(例 ${dup.slice(0, 5).join("・")})`);
  if (outside.length) problems.push(`${file}: 紙の外の目印 ${outside.length}個(例 ${outside.slice(0, 5).join("・")})`);
  // 禁則・英単語
  const dict = new Set(["layout", "page", "break", "paragraph", "table", "image", "font", "width", "height", "margin", "section"]);
  for (let p = 1; p <= sizes.length; p++) {
    const ws = words(pdf, p);
    for (const line of textLines(ws)) {
      const first = Array.from(line[0].text)[0] ?? "";
      if ("、。，．」』）】".includes(first)) problems.push(`${file}: ${p}ページ目の行の先頭に「${first}」(禁則)`);
    }
    for (const w of ws) {
      if (/\d/.test(w.text)) continue;
      for (const m of w.text.match(/[A-Za-z]{2,}/g) ?? []) if (!dict.has(m)) problems.push(`${file}: ${p}ページ目に、元の文書に無い英単語「${m}」(単語の途中で分けた可能性)`);
    }
  }
  return problems;
}

/**
 * 1つの組(元の文書と、その変化)を、1つの変換ごとに1つのテストにする(組の中は順に実行し、元の文書の結果を共有する)。
 * 以前は1つのテストで8回変換していたため、並列で実行すると、1つのテストの時間が長くなり、制限時間を超えることがあった。
 */
for (const group of manifest) {
  test.describe(`乱数の文書 ${group.seed}`, () => {
    test.describe.configure({ mode: "serial" });
    let base = "";
    let basePages = 0;
    let baseFound = new Map<string, { page: number; w: Word }[]>();
    const sig = (pdf: string) => [...markersOf(pdf).entries()].map(([k, v]) => `${k}:${v.map((f) => `${f.page}/${f.w.x.toFixed(1)}/${f.w.y.toFixed(1)}`).join("|")}`).sort().join(",");

    test(`${group.base}：欠落・重複なし・禁則・英単語`, async ({ page }) => {
      test.setTimeout(180_000);
      base = await convert(page, group.base);
      basePages = pageSizes(base).length;
      baseFound = markersOf(base);
      const problems = contentProblems(group.base, base);
      expect(problems, problems.join("\n")).toEqual([]);
    });

    test(`${group.base}：2回変換して同じ`, async ({ page }) => {
      test.setTimeout(180_000);
      const again = await convert(page, group.base);
      const problems = pageSizes(again).length !== basePages || sig(again) !== sig(base) ? [`${group.base}: 2回の変換で結果が違う`] : [];
      expect(problems, problems.join("\n")).toEqual([]);
    });

    for (const v of group.variants) {
      test(`${v.file}：${v.relation}`, async ({ page }) => {
        test.setTimeout(180_000);
        const out = await convert(page, v.file);
        const problems = contentProblems(v.file, out);
        const pages = pageSizes(out).length;
        if (v.relation.includes("pages>=base") && pages < basePages) problems.push(`${v.file}: ページ数が元(${basePages})より少ない(${pages})`);
        if (v.relation.includes("keeps-base-markers")) {
          const f = markersOf(out);
          const lost = [...baseFound.keys()].filter((k) => !f.has(k));
          if (lost.length) problems.push(`${v.file}: 内容を足したら、前からあった目印が ${lost.length}個消えた`);
        }
        expect(problems, problems.join("\n")).toEqual([]);
      });
    }
  });
}
