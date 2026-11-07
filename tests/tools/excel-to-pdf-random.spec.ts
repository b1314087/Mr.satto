import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { pageSizes, words } from "../helpers/chart-pdf-inspect";
import { audit, convert, type Expect } from "../helpers/print-audit";

/**
 * Excel→PDF：乱数で構造を変えたブック(10組×2)で、変換の共通の処理が、特定のブックに依らず正しいことを確かめる。
 *
 * テスト用のExcelと期待値は tests/fixtures/static/excel-random/(tests/fixtures/excel-random/generate_random_excel.py が、
 * シードを固定した乱数で作る。期待値はExcelの印刷の決まりに沿った、Mr.Sattoとは別の計算)。
 * 1組ごとに確かめること:
 *  - 元のブックと、余白だけを広くしたブックの、ページ数・用紙・セルの文字のページ・欠落/重複/範囲外が、期待値どおり
 *  - 余白を広くした(使える領域が狭い)ブックは、ページ数が減らない
 *  - 同じブックを2回変換すると、同じ結果になる(ページ数・セルの文字の位置)
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "excel-random");
const manifest: { seed: number; base: string; variants: { file: string; relation: string }[] }[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8")
);
const expectOf = (file: string): Expect => JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".xlsx", ".expect.json")), "utf-8"));

test.describe.configure({ mode: "parallel" });

for (const group of manifest) {
  test(`乱数のブック ${group.seed}：期待値どおり・余白を広くしてもページ数が減らない・2回変換して同じ`, async ({ page }) => {
    test.setTimeout(400_000);
    const problems: string[] = [];
    const base = await convert(page, path.join(DIR, group.base));
    problems.push(...(await audit(base.pdf, base.screen, expectOf(group.base))).map((p) => `${group.base}: ${p}`));
    const basePages = pageSizes(base.pdf).length;
    for (const v of group.variants) {
      const out = await convert(page, path.join(DIR, v.file));
      problems.push(...(await audit(out.pdf, out.screen, expectOf(v.file))).map((p) => `${v.file}: ${p}`));
      const pages = pageSizes(out.pdf).length;
      if (v.relation.includes("pages>=base") && pages < basePages) problems.push(`${v.file}: ページ数が元(${basePages})より少ない(${pages})`);
    }
    // 同じブックをもう一度変換して、同じ結果か
    const again = await convert(page, path.join(DIR, group.base));
    const sig = (pdf: string) => {
      const n = pageSizes(pdf).length;
      const ws: string[] = [];
      for (let p = 1; p <= Math.min(n, 3); p++) ws.push(...words(pdf, p).map((w) => `${p}:${w.text}:${w.x.toFixed(1)}:${w.y.toFixed(1)}`));
      return `${n}|${ws.join(",")}`;
    };
    if (sig(base.pdf) !== sig(again.pdf)) problems.push(`${group.base}: 2回の変換で結果が違う`);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
