import { test, expect } from "../fixtures/premium-test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { components, countPixels, pageSizes, pdfText, render, words, type Img, type Pred, type Word } from "../helpers/chart-pdf-inspect";

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

interface WordExpect {
  title: string;
  how: "A" | "B" | "C" | "D";
  pages: number | null;
  markers: Record<string, number[]>;
  pageSizes?: [number, number][];
  texts?: string[];
  textsAbsent?: string[];
  colors?: Record<string, [number, number, number]>;
  colorPages?: Record<string, number[]>;
  imageSize?: Record<string, [number, number]>;
  leftMargin?: Record<string, number>;
  /** 画面の注意書きに含まれるべき文字 */
  warningsContain?: string[];
  /** 同じ行にあるべき目印の組(上の位置の差が3pt未満) */
  sameLine?: [string, string][];
  /** 目印の左の位置の下限(pt)。回り込み・テキストボックスの位置の確認 */
  minX?: Record<string, number>;
}

async function convert(page: import("@playwright/test").Page, file: string): Promise<{ pdf: string; screen: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordfid-"));
  await page.goto("/tools/word-to-pdf");
  await uploadFixture(page, file);
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await page.getByText("完了", { exact: false }).first().waitFor({ timeout: 120_000 });
  const screen = await page.locator("main").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, screen };
}

const near = (rgb: [number, number, number], tol = 30): Pred => (r, g, b) => Math.abs(r - rgb[0]) < tol && Math.abs(g - rgb[1]) < tol && Math.abs(b - rgb[2]) < tol;
const inkPixel: Pred = (r, g, b) => r < 200 && g < 200 && b < 200;

function audit(pdf: string, screen: string, e: WordExpect): string[] {
  const problems: string[] = [];
  const sizes = pageSizes(pdf);
  if (e.pages !== null && sizes.length !== e.pages) problems.push(`ページ数：期待 ${e.pages}、実際 ${sizes.length}`);
  (e.pageSizes ?? []).forEach((ps, i) => {
    const s = sizes[i];
    if (s && (Math.abs(s.w - ps[0]) > 1.5 || Math.abs(s.h - ps[1]) > 1.5)) problems.push(`${i + 1}ページ目の用紙：期待 ${ps[0]}×${ps[1]}、実際 ${s.w}×${s.h}`);
  });
  const pageWords: Word[][] = [];
  const pageImgs: Img[] = [];
  for (let n = 1; n <= sizes.length; n++) {
    pageWords.push(words(pdf, n));
    pageImgs.push(render(pdf, n));
  }
  const found = new Map<string, { page: number; w: Word }[]>();
  pageWords.forEach((ws, i) => {
    for (const w of ws) found.set(w.text, [...(found.get(w.text) ?? []), { page: i + 1, w }]);
  });
  const examples: string[] = [];
  let missing = 0;
  let wrong = 0;
  let invisible = 0;
  for (const [marker, want] of Object.entries(e.markers)) {
    const got = (found.get(marker) ?? []).map((f) => f.page).sort((a, b) => a - b);
    if (got.length === 0) {
      missing++;
      if (examples.length < 12) examples.push(`${marker} が無い(期待 ${want.join("・")}ページ)`);
      continue;
    }
    const ok = e.how === "D" ? got.length === want.length : got.join(",") === [...want].sort((a, b) => a - b).join(",");
    if (!ok) {
      wrong++;
      if (examples.length < 12) examples.push(`${marker} のページ：期待 ${e.how === "D" ? `${want.length}回` : want.join("・")}、実際 ${got.join("・")}`);
    }
    for (const f of found.get(marker) ?? []) {
      const s = sizes[f.page - 1];
      const outside = f.w.x < -0.5 || f.w.y < -0.5 || f.w.x2 > s.w + 0.5 || f.w.y2 > s.h + 0.5;
      const ink = countPixels(pageImgs[f.page - 1], inkPixel, { x0: f.w.x, y0: f.w.y, x1: f.w.x2, y1: f.w.y2 });
      if (outside || ink === 0) {
        invisible++;
        if (examples.length < 12) examples.push(`${marker}(${f.page}ページ目)が${outside ? "紙の外" : "見えない"}`);
      }
    }
  }
  if (missing) problems.push(`出ていない目印の文字：${missing}個`);
  if (wrong) problems.push(`ページが違う・重複している目印の文字：${wrong}個`);
  if (invisible) problems.push(`紙の外・見えない目印の文字：${invisible}個`);

  // 文字(ヘッダー・フッター・ページ番号・番号付きリストなど)。見た目の並び(-layout)と、描いた順(-raw)のどちらかにあればよい
  const layoutText = pdfText(pdf).replace(/\s/g, "");
  const rawText = execFileSync("pdftotext", ["-raw", pdf, "-"], { maxBuffer: 256 * 1024 * 1024 }).toString().replace(/\s/g, "");
  const has = (t: string) => layoutText.includes(t.replace(/\s/g, "")) || rawText.includes(t.replace(/\s/g, ""));
  for (const t of e.texts ?? []) if (!has(t)) problems.push(`文字「${t}」が無い`);
  for (const t of e.textsAbsent ?? []) if (has(t)) problems.push(`文字「${t}」が出ている(出てはいけない)`);

  // 画像(色)：期待したページにあること、大きさ
  for (const [name, pagesWanted] of Object.entries(e.colorPages ?? {})) {
    const rgb = e.colors![name];
    pageImgs.forEach((img, i) => {
      const n = countPixels(img, near(rgb));
      const want = pagesWanted.includes(i + 1);
      if (want && n < 15) problems.push(`${i + 1}ページ目に画像「${name}」が無い`);
      if (!want && n >= 15) problems.push(`${i + 1}ページ目に、期待していない画像「${name}」がある`);
    });
    const size = e.imageSize?.[name];
    if (size) {
      const img = pageImgs[pagesWanted[0] - 1];
      const comps = img ? components(img, near(rgb), 20) : [];
      const big = comps.sort((a, b) => b.n - a.n)[0];
      if (!big) problems.push(`画像「${name}」の大きさを測れない`);
      else {
        const w = big.x1 - big.x0 + 1;
        const h = big.y1 - big.y0 + 1;
        if (Math.abs(w - size[0]) > 4 || Math.abs(h - size[1]) > 4) problems.push(`画像「${name}」の大きさ：期待 ${size[0]}×${size[1]}pt、実際 約${w}×${h}pt`);
      }
    }
  }
  // セクションの左の余白：目印の文字の左端が、余白の位置(+字下げ・文字の余白の分)にある
  for (const [marker, left] of Object.entries(e.leftMargin ?? {})) {
    const f = (found.get(marker) ?? [])[0];
    if (f && (f.w.x < left - 1 || f.w.x > left + 8)) problems.push(`${marker} の左の位置：期待 ${left}pt、実際 ${f.w.x.toFixed(1)}pt`);
  }
  for (const t of e.warningsContain ?? []) if (!screen.includes(t)) problems.push(`画面の注意書きに「${t}」が無い`);
  for (const [a, b] of e.sameLine ?? []) {
    const fa = (found.get(a) ?? [])[0];
    const fb = (found.get(b) ?? [])[0];
    if (fa && fb && (fa.page !== fb.page || Math.abs(fa.w.y2 - fb.w.y2) >= 3)) problems.push(`${a} と ${b} が同じ行にない(下の位置 ${fa.w.y2.toFixed(1)} と ${fb.w.y2.toFixed(1)})`);
  }
  for (const [m, x] of Object.entries(e.minX ?? {})) {
    const f = (found.get(m) ?? [])[0];
    if (f && f.w.x < x) problems.push(`${m} の左の位置：期待 ${x}pt以上、実際 ${f.w.x.toFixed(1)}pt`);
  }
  return [...problems, ...examples.map((x) => `  例：${x}`)];
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".docx")).sort();

test.describe.configure({ mode: "parallel" });

for (const file of files) {
  const e: WordExpect = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".docx", ".expect.json")), "utf-8"));
  test(`${file.replace(".docx", "")} ${e.title}：ページ数・改ページの位置・欠落`, async ({ page }) => {
    test.setTimeout(180_000);
    const { pdf, screen } = await convert(page, path.join(DIR, file));
    const problems = audit(pdf, screen, e);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
