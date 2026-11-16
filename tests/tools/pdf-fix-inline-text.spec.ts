import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadWhenReady } from "../helpers/tool-ready";
import { clickAndDownload } from "../helpers/tool-runner";
import { choosePdfFixOperation } from "../helpers/pdf-fix-operation";

/**
 * PDF修正（工程1の改善）：プレビューの上で直接文字を入力・編集・移動し、書き出したPDFでも画面と同じ位置に出ること。
 * 「やりたい操作」の帯が、スクロールしても見えたまま（上まで戻らなくてよい）であること。
 */

const CANVAS = '[data-testid="pdf-annotate-canvas"]';
/** テスト用のPDF（tests/fixtures/generated/single-page.pdf）のページの大きさ（pt） */
const PAGE_W = 300;
const PAGE_H = 400;
const pythonOk = (() => {
  try {
    execFileSync("python3", ["-c", "import pdfplumber"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function open(page: Page, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto("/tools/pdf-fix");
  await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS), { readyTimeoutMs: 30_000 });
  await page.locator(CANVAS).scrollIntoViewIfNeeded();
}

async function clickCanvas(page: Page, fx: number, fy: number) {
  const b = (await page.locator(CANVAS).boundingBox())!;
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
}

/** 置いた文字の、PDFの座標（画面に表示している値。書き出しはこの値で描く） */
async function objectPdfPosition(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="pdf-annotate-text-object"]') as HTMLElement;
    const canvas = document.querySelector('[data-testid="pdf-annotate-canvas"]') as HTMLElement;
    const r = el.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    return { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height, canvasW: c.width, canvasH: c.height };
  });
}

test.describe("PDF修正：プレビューの上で直接文字を入力する", () => {
  test.describe.configure({ timeout: 120_000 });

  test("文字の操作でPDFを押すと、その場に入力欄が出て、そのまま入力できる。Escで確定。空の欄は書き出さない", async ({ page }) => {
    await open(page);
    await choosePdfFixOperation(page, "テキスト");
    await clickCanvas(page, 0.3, 0.3);
    const inline = page.getByTestId("pdf-annotate-inline-text");
    await expect(inline).toBeFocused();
    await page.keyboard.type("申請者：山田 太郎");
    await page.keyboard.press("Escape");
    await expect(inline).toHaveCount(0);
    await expect(page.getByTestId("pdf-annotate-text-object")).toHaveText("申請者：山田 太郎");
    // 一覧の入力欄にも同じ文字が入っている（これまでの編集方法も使える）
    await expect(page.getByTestId("pdf-annotate-text-input")).toHaveValue("申請者：山田 太郎");

    // 何も入力せずに確定した欄は「テキスト未入力」と表示する（一覧の入力欄で続きを入力できる。PDFには書き出さない）
    await choosePdfFixOperation(page, "テキスト");
    await clickCanvas(page, 0.5, 0.15);
    await expect(page.getByTestId("pdf-annotate-inline-text")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pdf-annotate-text-object").nth(1)).toHaveText("（テキスト未入力）");
  });

  test("置いた文字は、もう一度押す・ダブルクリック・「編集」で書き直せる。小さな帯で大きさ・太字・揃えを変えられる", async ({ page }) => {
    await open(page);
    await choosePdfFixOperation(page, "テキスト");
    await clickCanvas(page, 0.3, 0.3);
    await page.keyboard.type("1行目\n2行目の文字");
    await page.keyboard.press("Escape");
    const obj = page.getByTestId("pdf-annotate-text-object");
    // 何もない所を押して、選んでいない状態にする
    await clickCanvas(page, 0.85, 0.12);
    await expect(page.getByTestId("pdf-annotate-text-toolbar")).toHaveCount(0);
    await obj.click(); // 選ぶ
    await expect(page.getByTestId("pdf-annotate-text-toolbar")).toBeVisible();
    await expect(page.getByTestId("pdf-annotate-inline-text")).toHaveCount(0);
    await obj.click(); // 選ばれている文字をもう一度押すと編集
    await expect(page.getByTestId("pdf-annotate-inline-text")).toBeFocused();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("を追加");
    await page.keyboard.press("Control+Enter");
    await expect(obj).toContainText("2行目の文字を追加");
    await expect(obj).toHaveAttribute("data-lines", "2");

    await obj.dblclick();
    await expect(page.getByTestId("pdf-annotate-inline-text")).toBeFocused();
    await page.keyboard.press("Escape");

    await obj.click();
    await expect(page.getByTestId("pdf-annotate-text-size")).toHaveText("14pt");
    await page.getByTestId("pdf-annotate-text-larger").click();
    await page.getByTestId("pdf-annotate-text-larger").click();
    await expect(page.getByTestId("pdf-annotate-text-size")).toHaveText("16pt");
    await page.getByTestId("pdf-annotate-text-smaller").click();
    await expect(page.getByTestId("pdf-annotate-text-size")).toHaveText("15pt");
    await page.getByTestId("pdf-annotate-text-align-right").click();
    await expect(page.getByTestId("pdf-annotate-text-align-right")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("pdf-annotate-text-edit").click();
    await expect(page.getByTestId("pdf-annotate-inline-text")).toBeFocused();
  });

  test("ドラッグで動かし、矢印キーで1pt（Shiftで10pt）ずつ微調整できる。拡大・縮小しても位置がずれない", async ({ page }) => {
    await open(page);
    await choosePdfFixOperation(page, "テキスト");
    await clickCanvas(page, 0.3, 0.3);
    await page.keyboard.type("位置の確認");
    await page.keyboard.press("Escape");
    const obj = page.getByTestId("pdf-annotate-text-object");
    await clickCanvas(page, 0.85, 0.12);
    const before = await objectPdfPosition(page);
    const box = (await obj.boundingBox())!;
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 65, box.y + 45, { steps: 6 });
    await page.mouse.up();
    const dragged = await objectPdfPosition(page);
    expect(dragged.left - before.left).toBeGreaterThan(50);
    expect(dragged.top - before.top).toBeGreaterThan(30);

    // 矢印キー（ドラッグしたあとは、その文字が選ばれたまま）：100%のとき、1pt は (キャンバスの幅 / ページの幅) px
    await expect(page.getByTestId("pdf-annotate-text-toolbar")).toBeVisible();
    const scale = dragged.canvasW / PAGE_W;
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowUp");
    const nudged = await objectPdfPosition(page);
    expect(nudged.left - dragged.left).toBeCloseTo(scale * 1, 0);
    expect(dragged.top - nudged.top).toBeCloseTo(scale * 10, 0);

    // 拡大・縮小：位置はページに対する割合で同じ
    const ratio = { x: nudged.left / nudged.canvasW, y: nudged.top / nudged.canvasH };
    for (const z of ["200%", "50%"]) {
      await page.getByRole("button", { name: z, exact: true }).click();
      await expect.poll(async () => {
        const p = await objectPdfPosition(page);
        return Math.abs(p.left / p.canvasW - ratio.x) < 0.004 && Math.abs(p.top / p.canvasH - ratio.y) < 0.006;
      }).toBe(true);
    }
  });

  test("書き出したPDFの文字は、画面と同じ位置に出る（横は1pt以内・縦は1.5pt以内）", async ({ page }) => {
    test.skip(!pythonOk, "pdfplumber が無い環境");
    await open(page);
    await choosePdfFixOperation(page, "テキスト");
    await clickCanvas(page, 0.25, 0.4);
    await page.keyboard.type("位置テスト ABC");
    await page.keyboard.press("Escape");
    // 画面の文字の、最初の文字の左端と、基準線の位置（PDFの座標に直す）
    await page.waitForFunction(() => document.fonts.check("16px MrSattoPdfJP"));
    await page.waitForTimeout(300);
    const screen = await page.evaluate(([pageW, pageH]) => {
      const el = document.querySelector('[data-testid="pdf-annotate-text-object"]') as HTMLElement;
      const canvas = document.querySelector('[data-testid="pdf-annotate-canvas"] img') as HTMLImageElement;
      const range = document.createRange();
      range.setStart(el.firstChild!, 0);
      range.setEnd(el.firstChild!, 1);
      const r = range.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      const scale = c.width / pageW;
      const fontPx = parseFloat(getComputedStyle(el).fontSize);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${fontPx}px MrSattoPdfJP`;
      const m = ctx.measureText("あHg");
      // 文字の範囲の下端 = 基準線 + フォントの下端
      const baseline = r.bottom - m.fontBoundingBoxDescent;
      return { x: (r.left - c.left) / scale, y: pageH - (baseline - c.top) / scale };
    }, [PAGE_W, PAGE_H]);
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    const dl = await clickAndDownload(page, /PDFをダウンロード/);
    const file = `${(await dl.path())!}.pdf`;
    await dl.saveAs(file);
    const pdf = JSON.parse(
      execFileSync("python3", [
        "-c",
        `
import json, sys, pdfplumber
with pdfplumber.open(sys.argv[1]) as p:
    ch = [c for c in p.pages[0].chars if c["text"] == "位"][0]
    print(json.dumps({"x": ch["matrix"][4], "y": ch["matrix"][5]}))`,
        file,
      ]).toString()
    );
    expect(Math.abs(pdf.x - screen.x), JSON.stringify({ pdf, screen })).toBeLessThanOrEqual(1);
    expect(Math.abs(pdf.y - screen.y), JSON.stringify({ pdf, screen })).toBeLessThanOrEqual(1.5);
  });
});

test.describe("PDF修正：やりたい操作の帯", () => {
  for (const vp of [
    { name: "PC（1280px）", width: 1280, height: 800 },
    { name: "スマホ（390px）", width: 390, height: 844 },
  ]) {
    test(`${vp.name}：PDFを下までスクロールしても帯が見えたまま、操作を切り替えられる。帯は1つだけ`, async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, vp.width, vp.height);
      const bar = page.getByTestId("pdf-fix-operation");
      await expect(bar).toHaveCount(1);
      await expect(page.getByTestId("pdf-fix-toolbar-slot")).toBeVisible();
      // PDFのプレビューのどこを見ていても、帯は画面の中にある。
      // PCではプレビューの枠の中をスクロールする（プレビューの列は画面に固定）。スマホではページ全体をスクロールする
      const preview = page.getByTestId("tool-preview");
      const canvasTop = await page.locator(CANVAS).evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
      const canvasHeight = (await page.locator(CANVAS).boundingBox())!.height;
      const positions = vp.width >= 1024 ? ["top", "bottom"] : [canvasTop - 50, canvasTop + canvasHeight - vp.height * 0.6];
      for (const pos of positions) {
        if (vp.width >= 1024) {
          await page.evaluate((y) => window.scrollTo(0, y), canvasTop - 120);
          await preview.evaluate((el, where) => el.scrollTo(0, where === "top" ? 0 : el.scrollHeight), pos);
        } else {
          await page.evaluate((y) => window.scrollTo(0, Math.max(0, y as number)), pos);
        }
        await page.waitForTimeout(200);
        const scroll = String(pos);
        const b = (await bar.boundingBox())!;
        expect(b.y, `スクロール${scroll}`).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height, `スクロール${scroll}`).toBeLessThanOrEqual(vp.height);
        await choosePdfFixOperation(page, pos === positions[0] ? "テキスト" : "選択・移動");
      }
      if (vp.width >= 1024) {
        // PCでは、帯はプレビューの枠の上（PDFの表示に重ならない）
        const c = (await preview.boundingBox())!;
        const b = (await bar.boundingBox())!;
        expect(b.y + b.height).toBeLessThanOrEqual(c.y + 1);
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});
