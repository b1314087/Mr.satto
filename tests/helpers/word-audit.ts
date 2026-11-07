import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clickAndDownload, uploadFixture } from "./tool-runner";
import { components, countPixels, pageSizes, pdfText, render, words, type Img, type Pred, type Word } from "./chart-pdf-inspect";

/**
 * Word→PDFの検証の共通の道具：Mr.SattoでDOCXをPDFにする(convert)、期待値(*.expect.json)と比べる(audit)。
 * tests/tools/word-to-pdf-page-fidelity.spec.ts・word-to-pdf-ooxml-spec.spec.ts で使う。
 */

export interface WordExpect {
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
  /** 目印の左の位置の範囲(pt) [下限, 上限]。禁則・ぶら下げで、行のどこから始まるかの確認 */
  xRange?: Record<string, [number, number]>;
  /** 目印の文字の高さ(pt)の下限。文字の大きさが反映されているかの確認 */
  minHeight?: Record<string, number>;
  /** 行の先頭に来てはいけない文字・行の末尾に来てはいけない文字(禁則) */
  forbiddenLineStarts?: string;
  forbiddenLineEnds?: string;
  /** 1つの行の中に続けて出るべき文字列(分離禁止) */
  inseparable?: string[];
  /** PDFの英単語(数字を含まない語)が、すべてこの中のどれか(英単語を途中で分けていない) */
  dictWords?: string[];
  /** PDFのリンク(URI)に含まれるべきURL */
  linkUris?: string[];
}

/** ページの文字を、行(下の位置がほぼ同じ語)ごとにまとめる(左から順) */
export function textLines(pageWords: Word[]): Word[][] {
  const sorted = [...pageWords].sort((a, b) => a.y2 - b.y2 || a.x - b.x);
  const lines: Word[][] = [];
  for (const w of sorted) {
    const line = lines.find((l) => Math.abs(l[0].y2 - w.y2) < 2);
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

export async function convert(page: import("@playwright/test").Page, file: string): Promise<{ pdf: string; screen: string }> {
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

export function audit(pdf: string, screen: string, e: WordExpect): string[] {
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
  for (const [m, [lo, hi]] of Object.entries(e.xRange ?? {})) {
    const f = (found.get(m) ?? [])[0];
    if (f && (f.w.x < lo || f.w.x > hi)) problems.push(`${m} の左の位置：期待 ${lo}〜${hi}pt、実際 ${f.w.x.toFixed(1)}pt`);
  }
  for (const [m, h] of Object.entries(e.minHeight ?? {})) {
    const f = (found.get(m) ?? [])[0];
    if (f && f.w.y2 - f.w.y < h) problems.push(`${m} の文字の高さ：期待 ${h}pt以上、実際 ${(f.w.y2 - f.w.y).toFixed(1)}pt`);
  }
  if (e.forbiddenLineStarts || e.forbiddenLineEnds || e.inseparable) {
    const lineTexts: string[] = [];
    pageWords.forEach((ws, i) => {
      for (const line of textLines(ws)) {
        const first = Array.from(line[0].text)[0] ?? "";
        const lastWord = Array.from(line[line.length - 1].text);
        const last = lastWord[lastWord.length - 1] ?? "";
        if (e.forbiddenLineStarts?.includes(first)) problems.push(`${i + 1}ページ目：行の先頭に「${first}」がある(禁則)：${line.map((w) => w.text).join(" ").slice(0, 30)}`);
        if (e.forbiddenLineEnds?.includes(last)) problems.push(`${i + 1}ページ目：行の末尾に「${last}」がある(禁則)：…${line.map((w) => w.text).join(" ").slice(-30)}`);
        lineTexts.push(line.map((w) => w.text).join(""));
      }
    });
    for (const t of e.inseparable ?? []) {
      const joined = lineTexts.join("").split(t).length - 1;
      const perLine = lineTexts.reduce((n, l) => n + l.split(t).length - 1, 0);
      if (joined > perLine) problems.push(`「${t}」が行の境目で分かれている`);
    }
  }
  if (e.dictWords) {
    const dict = new Set(e.dictWords);
    const bad = new Set<string>();
    for (const ws of pageWords)
      for (const w of ws) {
        if (/\d/.test(w.text)) continue; // 目印(数字を含む)は除く
        for (const m of w.text.match(/[A-Za-z]{2,}/g) ?? []) if (!dict.has(m)) bad.add(m);
      }
    if (bad.size > 0) problems.push(`元の文書に無い英単語(単語の途中で分けた可能性)：${[...bad].slice(0, 8).join("・")}`);
  }
  if (e.linkUris && e.linkUris.length > 0) {
    const out = execFileSync("pdfinfo", ["-url", pdf]).toString();
    for (const u of e.linkUris) if (!out.includes(u)) problems.push(`リンク ${u} が無い`);
  }
  return [...problems, ...examples.map((x) => `  例：${x}`)];
}

