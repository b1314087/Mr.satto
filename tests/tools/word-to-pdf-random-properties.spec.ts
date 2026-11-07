import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { pageSizes, words, type Word } from "../helpers/chart-pdf-inspect";

/**
 * Word→PDF：乱数で構造を変えた文書(6組×5)で、レイアウトの共通の処理が、特定の文書に依らず成り立つべき性質を確かめる。
 *
 * テスト用のDOCXは tests/fixtures/static/word-random/(tests/fixtures/word-random/generate_random_word.py が、
 * シードを固定した乱数で、段落の数・文字数・フォント・文字の大きさ・行間・段落の間隔・表・画像・箇条書き・改ページ・
 * セクション・用紙の向きを変えて作る)。1組ごとに確かめること:
 *  - どの文書でも、目印の文字がちょうど1回ずつ出て、紙の中にある(内容の欠落・重複が無い)
 *  - 同じ文書を2回変換すると、同じ結果になる
 *  - 余白を広くする・文字を大きくする・画像を大きくする・段落を足すと、ページ数は減らない
 *  - 段落を足しても、前からあった目印の文字は消えない
 * Microsoft Wordの結果とは比べていない(Wordのページの区切りそのものではなく、レイアウトの計算の性質を確かめる)。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "word-random");
const manifest: { seed: number; base: string; variants: { file: string; relation: string }[] }[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8")
);

async function convert(page: import("@playwright/test").Page, file: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordrand-"));
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
      const m = /Q\d{3}M\d{3}/.exec(w.text);
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
  return problems;
}

test.describe.configure({ mode: "parallel" });

for (const group of manifest) {
  test(`乱数の文書 ${group.seed}：欠落・重複なし・2回変換して同じ・余白/文字/画像/段落を増やしてもページ数が減らない`, async ({ page }) => {
    test.setTimeout(300_000);
    const problems: string[] = [];
    const base = await convert(page, group.base);
    problems.push(...contentProblems(group.base, base));
    const basePages = pageSizes(base).length;
    const baseFound = markersOf(base);
    const again = await convert(page, group.base);
    const sig = (pdf: string) => [...markersOf(pdf).entries()].map(([k, v]) => `${k}:${v.map((f) => `${f.page}/${f.w.x.toFixed(1)}/${f.w.y.toFixed(1)}`).join("|")}`).sort().join(",");
    if (pageSizes(again).length !== basePages || sig(again) !== sig(base)) problems.push(`${group.base}: 2回の変換で結果が違う`);
    for (const v of group.variants) {
      const out = await convert(page, v.file);
      problems.push(...contentProblems(v.file, out));
      const pages = pageSizes(out).length;
      if (v.relation.includes("pages>=base") && pages < basePages) problems.push(`${v.file}: ページ数が元(${basePages})より少ない(${pages})`);
      if (v.relation.includes("keeps-base-markers")) {
        const f = markersOf(out);
        const lost = [...baseFound.keys()].filter((k) => !f.has(k));
        if (lost.length) problems.push(`${v.file}: 段落を足したら、前からあった目印が ${lost.length}個消えた`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
