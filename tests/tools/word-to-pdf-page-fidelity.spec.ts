import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { audit, convert, type WordExpect } from "../helpers/word-audit";

/**
 * Word→PDF：ページ単位の再現性(ページ数・改ページの位置・セクション・段落の改ページの制御・表・画像)の検証(23種類のDOCX)。
 *
 * テスト用のDOCXと期待値は tests/fixtures/static/word-page-fidelity/(*.docx と *.expect.json。架空のデータのみ)。
 * tests/fixtures/word-page-fidelity/generate_word_fixtures.py が作る。期待値の決まり方(how)は4種類:
 *   A=明示的な区切り(改ページ・段落の前で改ページ・セクション区切り)、B=行の高さを固定した文書(1ページに入る行数が計算で決まる)、
 *   C=Wordが保存した改ページの位置(w:lastRenderedPageBreak)と総ページ数を持つ文書、D=自然に流れる文書(参考。ページの境目は確かめない)。
 * 確かめること：ページ数・用紙の大きさ・目印の文字が期待したページに1回だけ出ること(D は1回だけ出ること)・紙の中に描かれていること・
 * 画像のページと大きさ・ヘッダー/フッター/ページ番号の文字・セクションの余白。
 * Microsoft Word本体で印刷した結果とは直接比べていない(LibreOfficeとの比較は compare_with_libreoffice.py で別に行う)。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "word-page-fidelity");

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".docx")).sort();

const readExpect = (file: string): WordExpect => JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".docx", ".expect.json")), "utf-8"));

const run = (file: string, e: WordExpect) =>
  test(`${file.replace(".docx", "")} ${e.title}：ページ数・改ページの位置・欠落`, async ({ page }) => {
    test.setTimeout(180_000);
    const { pdf, screen } = await convert(page, path.join(DIR, file));
    const problems = audit(pdf, screen, e);
    expect(problems, problems.join("\n")).toEqual([]);
  });

test.describe("ページの境目が決まる文書（A・B・C）", () => {
  test.describe.configure({ mode: "parallel" });
  for (const file of files) if (readExpect(file).how !== "D") run(file, readExpect(file));
});

// 自然に流れる長い文書（D）は、変換と、出来上がったPDFの読み取りが特に重い。並べて同時に動かすと、
// テストの道具（Playwright）の中の確認で止まることがあった（監査の「原因未確定」w22・w23。1つずつ動かすと、問題は0件）。
// アプリの不具合ではないため、この2件は1つずつ順番に動かす
test.describe("自然に流れる文書（D・参考）", () => {
  test.describe.configure({ mode: "serial" });
  for (const file of files) if (readExpect(file).how === "D") run(file, readExpect(file));
});
