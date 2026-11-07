import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { audit, convert, type WordExpect } from "../helpers/word-audit";

/**
 * Word→PDF：OOXMLの仕様に沿った検証(12種類のDOCX)。
 *
 * テスト用のDOCXと期待値は tests/fixtures/static/word-ooxml-spec/(tests/fixtures/word-ooxml-spec/generate_spec_word.py が作る)。
 * 期待値は、Mr.Sattoの変換結果ではなく、OOXMLの各要素の意味と、計算で決まるレイアウトから決めたもの:
 *  - 内容コントロール(w:sdt)の中の段落・表、入れ子の表、表のセルの中の画像、ハイパーリンク、すべて大文字 → 文字・画像が1回ずつ出る
 *  - 段落スタイルの「段落の前で改ページ」→ 新しいページから始まる
 *  - 表の行の途中の分割・「行の途中で改ページしない」・タイトル行の繰り返し・高さが固定の行 → 1行20ptの文字で、ページが計算で決まる
 *  - 日本語の禁則(標準・高レベル)・句読点のぶら下げ・分離禁止・英単語を途中で分けない
 * Microsoft Word本体の結果とは直接比べていない。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "word-ooxml-spec");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".docx")).sort();

test.describe.configure({ mode: "parallel" });

for (const file of files) {
  const e: WordExpect = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".docx", ".expect.json")), "utf-8"));
  test(`${file.replace(".docx", "")} ${e.title}`, async ({ page }) => {
    test.setTimeout(180_000);
    const { pdf, screen } = await convert(page, path.join(DIR, file));
    const problems = audit(pdf, screen, e);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
