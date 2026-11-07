import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "./tool-runner";
import { countPixels, pageSizes, pdfText, render, words, type Img, type Pred, type Word } from "./chart-pdf-inspect";

/**
 * Excel→PDFの印刷の再現性の監査(共通の道具)。
 * テスト用のExcelと期待値(*.expect.json)は、tests/fixtures/excel-print-audit/ と tests/fixtures/excel-page-fidelity/ の
 * 生成スクリプトが作る(Mr.Sattoの計算とは別に、Excelの印刷の決まりに沿って期待値を計算している)。
 */

export interface Expect {
  title: string;
  /** box：表の本体を印刷できる枠 [左, 上, 右, 下](紙の左上が原点、pt) */
  pages: { pageNo: number; width: number; height: number; scale: number; sheet: string; drawings: string[]; box?: [number, number, number, number] }[];
  markers: Record<string, number[]>;
  absent: string[];
  texts?: string[];
  textsAbsent?: string[];
  colors?: Record<string, [number, number, number]>;
  colorAbsent?: string[];
  origin?: Record<string, { page: number; x: number; y: number }>;
  rightLimitCol?: number;
  warningsContain?: string[];
}

/** Excelのファイル(絶対パス)をMr.SattoでPDFにして保存し、PDFのパスと画面の文字を返す */
export async function convert(page: Page, file: string): Promise<{ pdf: string; screen: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlaudit-"));
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, file);
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "PDFの生成が完了しました", 170_000);
  const screen = await page.locator("main").innerText();
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return { pdf, screen };
}

const near = (rgb: [number, number, number], tol = 30): Pred => (r, g, b) => Math.abs(r - rgb[0]) < tol && Math.abs(g - rgb[1]) < tol && Math.abs(b - rgb[2]) < tol;
const inkPixel: Pred = (r, g, b) => r < 200 && g < 200 && b < 200;

/** 1つのExcelの監査。問題を文字の一覧で返す(テストの失敗の説明にそのまま出す) */
export async function audit(pdf: string, screen: string, e: Expect): Promise<string[]> {
  const problems: string[] = [];
  const sizes = pageSizes(pdf);
  if (sizes.length !== e.pages.length) problems.push(`ページ数：期待 ${e.pages.length}、実際 ${sizes.length}`);
  e.pages.forEach((p, i) => {
    const s = sizes[i];
    if (s && (Math.abs(s.w - p.width) > 1 || Math.abs(s.h - p.height) > 1)) problems.push(`${i + 1}ページ目(${p.sheet})の用紙：期待 ${p.width}×${p.height}、実際 ${s.w}×${s.h}`);
  });

  // ページごとの文字と画像
  const pageWords: Word[][] = [];
  const pageImgs: (Img | null)[] = [];
  for (let n = 1; n <= sizes.length; n++) {
    pageWords.push(words(pdf, n));
    pageImgs.push(render(pdf, n));
  }
  const found = new Map<string, { page: number; w: Word }[]>();
  pageWords.forEach((ws, i) => {
    for (const w of ws) {
      const list = found.get(w.text) ?? [];
      list.push({ page: i + 1, w });
      found.set(w.text, list);
    }
  });

  // セルの固有の文字：期待したページに、期待した回数だけ
  let missing = 0;
  let wrong = 0;
  let invisible = 0;
  let outOfBox = 0;
  const examples: string[] = [];
  for (const [marker, expectedPages] of Object.entries(e.markers)) {
    const got = (found.get(marker) ?? []).map((f) => f.page).sort((a, b) => a - b);
    const want = [...expectedPages].sort((a, b) => a - b);
    if (got.length === 0) {
      missing++;
      if (examples.length < 12) examples.push(`${marker} が無い(期待 ${want.join("・")}ページ)`);
      continue;
    }
    if (got.join(",") !== want.join(",")) {
      wrong++;
      if (examples.length < 12) examples.push(`${marker} のページ：期待 ${want.join("・")}、実際 ${got.join("・")}`);
    }
    // 紙の中にあり、実際に描かれている(切り取られていない)
    for (const f of found.get(marker) ?? []) {
      const s = sizes[f.page - 1];
      const scale = e.pages[f.page - 1]?.scale ?? 1;
      const outside = f.w.x < -0.5 || f.w.y < -0.5 || f.w.x2 > s.w + 0.5 || f.w.y2 > s.h + 0.5;
      // 印刷できる枠(余白の内側)からはみ出していないこと(ページの下端・右端で余白に食い込んでいないこと)
      const box = e.pages[f.page - 1]?.box;
      if (box && !outside && (f.w.x < box[0] - 2 || f.w.y < box[1] - 2 || f.w.x2 > box[2] + 2 || f.w.y2 > box[3] + 2)) {
        outOfBox++;
        if (examples.length < 12) examples.push(`${marker}(${f.page}ページ目)が余白にはみ出している(${f.w.x.toFixed(1)}, ${f.w.y.toFixed(1)})-(${f.w.x2.toFixed(1)}, ${f.w.y2.toFixed(1)})`);
      }
      const img = pageImgs[f.page - 1];
      const ink = img && scale >= 0.3 ? countPixels(img, inkPixel, { x0: f.w.x, y0: f.w.y, x1: f.w.x2, y1: f.w.y2 }) : 1;
      if (outside || ink === 0) {
        invisible++;
        if (examples.length < 12) examples.push(`${marker}(${f.page}ページ目)が${outside ? "紙の外" : "見えない(切り取られている)"}`);
      }
    }
  }
  if (missing) problems.push(`出ていないセルの文字：${missing}個`);
  if (wrong) problems.push(`ページが違う・重複しているセルの文字：${wrong}個`);
  if (invisible) problems.push(`紙の外・切り取られて見えないセルの文字：${invisible}個`);
  if (outOfBox) problems.push(`余白にはみ出しているセルの文字：${outOfBox}個`);
  const leaked = e.absent.filter((t) => found.has(t));
  if (leaked.length) {
    problems.push(`出てはいけないのに出たセルの文字：${leaked.length}個`);
    examples.push(...leaked.slice(0, 5).map((t) => `${t} が出ている(範囲の外・非表示)`));
  }

  // 文字(表示形式のある値・タイトルなど)
  // 折り返したセルの文字は、-layout(見た目の並び)では隣の列の文字と行ごとに混ざるため、描いた順(-raw)の文字でも探す
  const layoutText = pdfText(pdf).replace(/\s/g, "");
  const rawText = execFileSync("pdftotext", ["-raw", pdf, "-"], { maxBuffer: 512 * 1024 * 1024 }).toString().replace(/\s/g, "");
  const hasText = (t: string) => layoutText.includes(t.replace(/\s/g, "")) || rawText.includes(t.replace(/\s/g, ""));
  for (const t of e.texts ?? []) if (!hasText(t)) problems.push(`文字「${t}」が無い`);
  for (const t of e.textsAbsent ?? []) if (hasText(t)) problems.push(`文字「${t}」が出ている(出てはいけない)`);

  // 画像・グラフ(色)
  // 1ページに収まる画像・グラフは、そのページに色があること。
  // ページの境目をまたぐものは、かかるページのどれかに色があること(端の少しだけかかるページには、
  // グラフの余白や軸しか入らず、棒の色が無いことがあるため)。
  if (e.colors) {
    const pagesOf = new Map<string, number[]>();
    e.pages.forEach((p, i) => p.drawings.forEach((name) => pagesOf.set(name, [...(pagesOf.get(name) ?? []), i])));
    for (const [name, idxs] of pagesOf) {
      const has = idxs.map((i) => (pageImgs[i] ? countPixels(pageImgs[i]!, near(e.colors![name])) >= 15 : true));
      if (idxs.length === 1 && !has[0]) problems.push(`${idxs[0] + 1}ページ目に「${name}」の画像・グラフが無い`);
      if (idxs.length > 1 && !has.some(Boolean)) problems.push(`${idxs.map((i) => i + 1).join("・")}ページ目のどこにも「${name}」の画像・グラフが無い`);
    }
    for (const name of e.colorAbsent ?? []) {
      pageImgs.forEach((img, i) => {
        if (img && countPixels(img, near(e.colors![name], 20)) > 15) problems.push(`${i + 1}ページ目に、出てはいけない「${name}」の画像・グラフが出ている`);
      });
    }
  }

  // 余白・中央配置：セルの文字の左上が、期待した位置の近く(セルの内側の余白・行の中の上下の位置の分だけ右下)
  for (const [marker, o] of Object.entries(e.origin ?? {})) {
    const f = (found.get(marker) ?? []).find((x) => x.page === o.page);
    if (!f) continue;
    if (f.w.x < o.x - 1 || f.w.x > o.x + 10 || f.w.y < o.y - 1 || f.w.y > o.y + 12) problems.push(`${marker} の位置：期待(${o.x.toFixed(1)}, ${o.y.toFixed(1)})の近く、実際(${f.w.x.toFixed(1)}, ${f.w.y.toFixed(1)})`);
  }

  // 印刷範囲の右端より右に、文字の画素が無い
  if (e.rightLimitCol !== undefined && pageImgs[0]) {
    const limitX = 0.7 * 72 + e.rightLimitCol * 54;
    const n = countPixels(pageImgs[0], inkPixel, { x0: limitX + 1, y0: 0, x1: pageImgs[0].w, y1: pageImgs[0].h });
    if (n > 0) problems.push(`印刷範囲の右端より右に、文字などが描かれている(${n}画素)`);
  }
  for (const t of e.warningsContain ?? []) if (!screen.includes(t)) problems.push(`画面の注意書きに「${t}」が無い`);
  return [...problems, ...examples.map((x) => `  例：${x}`)];
}

