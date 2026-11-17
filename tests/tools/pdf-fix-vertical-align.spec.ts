import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadWhenReady } from "../helpers/tool-ready";
import { clickAndDownload } from "../helpers/tool-runner";
import { choosePdfFixOperation } from "../helpers/pdf-fix-operation";

/**
 * PDF修正（2026-11-17の改善）：
 * - 文字を縦書きにできる（画面と書き出したPDFで、同じ位置に出る）
 * - 2つ以上の注釈を選んで、上・下・左・右・中央（高さ）を揃えられる
 * - プレビューの上の小さな帯から、注釈を複製できる
 * - 「配置した注釈」の一覧は、選んだ注釈だけが開き、ほかは見出し（種類・中身）だけになる
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
  const canvas = page.locator(CANVAS);
  const size = (await canvas.boundingBox())!;
  const x = size.width * fx;
  const y = size.height * fy;
  // 押したい位置が画面（とプレビューの枠）の真ん中に来るようにスクロールしてから押す（tests/helpers/pdf-fix-operation.ts と同じ方法）
  await canvas.evaluate(
    (el, p) => {
      const mark = document.createElement("div");
      mark.style.cssText = `position:absolute;left:${p.x}px;top:${p.y}px;width:1px;height:1px;pointer-events:none`;
      el.appendChild(mark);
      mark.scrollIntoView({ block: "center", inline: "nearest" });
      mark.remove();
    },
    { x, y }
  );
  const b = (await canvas.boundingBox())!;
  await page.mouse.click(b.x + x, b.y + y);
}

/** 要素を、Shift を押しながら押す */
async function shiftClick(page: Page, selector: string, index: number) {
  const el = page.locator(selector).nth(index);
  await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
  const b = (await el.boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.up("Shift");
}

async function addText(page: Page, fx: number, fy: number, text: string) {
  await choosePdfFixOperation(page, "テキスト");
  await clickCanvas(page, fx, fy);
  await expect(page.getByTestId("pdf-annotate-inline-text")).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

async function addCheck(page: Page, fx: number, fy: number) {
  await choosePdfFixOperation(page, "チェック");
  await clickCanvas(page, fx, fy);
}

/** 画面の要素の箱（キャンバスの左上が原点、px） */
async function boxOf(page: Page, selector: string, index: number) {
  return page.evaluate(
    ([sel, i]) => {
      const el = document.querySelectorAll(sel)[i as number] as HTMLElement;
      const c = document.querySelector('[data-testid="pdf-annotate-canvas"]')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { left: r.left - c.left, top: r.top - c.top, right: r.right - c.left, bottom: r.bottom - c.top };
    },
    [selector, index] as const
  );
}

test.describe("PDF修正：縦書き・揃える・複製・一覧の折りたたみ", () => {
  test.describe.configure({ timeout: 120_000 });

  test("縦書きで置ける。帯の「縦書き」で横書き⇔縦書きを切り替えても、文字の箱の左上は動かない", async ({ page }) => {
    await open(page);
    await choosePdfFixOperation(page, "テキスト");
    await page.getByTestId("pdf-annotate-text-vertical-setting").check();
    await clickCanvas(page, 0.5, 0.2);
    await expect(page.getByTestId("pdf-annotate-inline-text")).toBeFocused();
    await page.keyboard.type("縦書きテスト");
    await page.keyboard.press("Escape");
    const obj = page.getByTestId("pdf-annotate-text-object");
    await expect(obj).toHaveAttribute("data-vertical", "true");
    const v = (await obj.boundingBox())!;
    // 6文字が縦に並ぶので、縦に長い
    expect(v.height).toBeGreaterThan(v.width * 3);
    // 一覧の見出しで、縦書きだと分かる
    await expect(page.getByTestId("pdf-annotate-object-summary").first()).toContainText("テキスト（縦書き）");
    await expect(page.getByTestId("pdf-annotate-object-summary").first()).toContainText("縦書きテスト");

    // 横書きに戻す → 横に長くなり、左上はほぼ同じ
    const before = await boxOf(page, '[data-testid="pdf-annotate-text-object"]', 0);
    await page.getByTestId("pdf-annotate-text-vertical").click();
    await expect(obj).not.toHaveAttribute("data-vertical", "true");
    const h = (await obj.boundingBox())!;
    expect(h.width).toBeGreaterThan(h.height * 3);
    const after = await boxOf(page, '[data-testid="pdf-annotate-text-object"]', 0);
    expect(Math.abs(after.left - before.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(3);
    // もう一度縦書きに
    await page.getByTestId("pdf-annotate-text-vertical").click();
    await expect(obj).toHaveAttribute("data-vertical", "true");
  });

  test("縦書きの文字は、書き出したPDFでも画面と同じ位置に出る（回す文字「ー」も含む。1.5pt以内）", async ({ page }) => {
    test.skip(!pythonOk, "pdfplumber が無い環境");
    await open(page);
    await choosePdfFixOperation(page, "テキスト");
    await page.getByTestId("pdf-annotate-text-vertical-setting").check();
    await clickCanvas(page, 0.5, 0.15);
    await page.keyboard.type("縦ーA");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.fonts.check("16px MrSattoPdfJP"));
    await page.waitForTimeout(300);
    // 画面：SVG の文字の原点（x・y の属性）を、PDFの座標に直す
    const screen = await page.evaluate(
      ([pageW, pageH]) => {
        const svg = document.querySelector('[data-testid="pdf-annotate-text-object"] svg') as SVGSVGElement;
        const img = document.querySelector('[data-testid="pdf-annotate-canvas"] img') as HTMLImageElement;
        const s = svg.getBoundingClientRect();
        const c = img.getBoundingClientRect();
        const scale = c.width / pageW;
        const out: Record<string, { x: number; y: number }> = {};
        for (const t of Array.from(svg.querySelectorAll("text"))) {
          const ch = t.textContent ?? "";
          if (out[ch]) continue;
          const x = Number(t.getAttribute("x"));
          const y = Number(t.getAttribute("y"));
          out[ch] = { x: (s.left - c.left + x) / scale, y: pageH - (s.top - c.top + y) / scale };
        }
        return out;
      },
      [PAGE_W, PAGE_H]
    );
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    const dl = await clickAndDownload(page, /PDFをダウンロード/);
    const file = `${(await dl.path())!}.pdf`;
    await dl.saveAs(file);
    const pdf = JSON.parse(
      execFileSync("python3", [
        "-c",
        `
import json, sys, pdfplumber
out = {}
with pdfplumber.open(sys.argv[1]) as p:
    for c in p.pages[0].chars:
        if c["text"] not in out:
            out[c["text"]] = {"x": c["matrix"][4], "y": c["matrix"][5], "upright": c["upright"], "m": list(c["matrix"])}
print(json.dumps(out))`,
        file,
      ]).toString()
    );
    for (const ch of ["縦", "ー", "A"]) {
      expect(pdf[ch], ch).toBeTruthy();
      expect(Math.abs(pdf[ch].x - screen[ch].x), JSON.stringify({ ch, pdf: pdf[ch], screen: screen[ch] })).toBeLessThanOrEqual(1.5);
      expect(Math.abs(pdf[ch].y - screen[ch].y), JSON.stringify({ ch, pdf: pdf[ch], screen: screen[ch] })).toBeLessThanOrEqual(1.5);
    }
    // 「ー」は回して描く（縦書きの向き）。「縦」は回さない
    expect(Math.abs(pdf["ー"].m[1]), JSON.stringify(pdf["ー"])).toBeGreaterThan(0.5);
    expect(Math.abs(pdf["縦"].m[1]), JSON.stringify(pdf["縦"])).toBeLessThan(0.01);
    // 縦に並ぶ：2文字目は1文字目より下、横はほぼ同じ列
    expect(pdf["A"].y).toBeLessThan(pdf["縦"].y);
  });

  test("PC：Shift を押しながら2つ目を押して選び、上・高さ（上下の中央）・左を揃えられる", async ({ page }) => {
    await open(page);
    await addCheck(page, 0.2, 0.2);
    await addCheck(page, 0.6, 0.5);
    const sel = '[data-testid="pdf-annotate-checkbox-object"]';
    // 1つ目を選び、Shift を押しながら2つ目を押す
    await page.locator(sel).nth(0).click();
    await shiftClick(page, sel, 1);
    await expect(page.getByTestId("pdf-annotate-align-bar")).toBeVisible();
    await expect(page.getByTestId("pdf-annotate-align-count")).toContainText("2個");

    await page.getByTestId("pdf-annotate-align-top").click();
    let a = await boxOf(page, sel, 0);
    let b = await boxOf(page, sel, 1);
    expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
    // 上は、上にあった1つ目に揃う
    expect(a.top).toBeLessThan(200);

    await page.getByTestId("pdf-annotate-align-left").click();
    a = await boxOf(page, sel, 0);
    b = await boxOf(page, sel, 1);
    expect(Math.abs(a.left - b.left)).toBeLessThanOrEqual(1);

    // 「解除」で選ぶのを1つに戻すと、揃える帯は消える
    await page.getByTestId("pdf-annotate-align-clear").click();
    await expect(page.getByTestId("pdf-annotate-align-bar")).toHaveCount(0);

    // 元に戻すで、1回ずつ戻せる（左揃えを取り消す）
    await page.getByRole("button", { name: "元に戻す" }).click();
    b = await boxOf(page, sel, 1);
    a = await boxOf(page, sel, 0);
    expect(Math.abs(a.left - b.left)).toBeGreaterThan(20);
    expect(Math.abs(a.top - b.top)).toBeLessThanOrEqual(1);
  });

  test("文字とチェックの高さ（上下の中央）を揃えられる。帯の「複数選択」でも選べる（スマホ向け）", async ({ page }) => {
    await open(page, 390, 844);
    await addText(page, 0.15, 0.3, "氏名");
    await addCheck(page, 0.7, 0.6);
    // 文字を選び直して、帯の「複数選択」をオンにし、チェックを押す
    await page.getByTestId("pdf-annotate-text-object").click();
    await page.getByTestId("pdf-annotate-toolbar-multi").click();
    await expect(page.getByTestId("pdf-annotate-multi-hint")).toBeVisible();
    await page.getByTestId("pdf-annotate-checkbox-object").click();
    await expect(page.getByTestId("pdf-annotate-align-count")).toContainText("2個");
    await page.getByTestId("pdf-annotate-align-vcenter").click();
    const t = await boxOf(page, '[data-testid="pdf-annotate-text-object"]', 0);
    const c = await boxOf(page, '[data-testid="pdf-annotate-checkbox-object"]', 0);
    expect(Math.abs((t.top + t.bottom) / 2 - (c.top + c.bottom) / 2)).toBeLessThanOrEqual(1.5);
  });

  test("プレビューの上の帯から複製できる（文字・チェック）", async ({ page }) => {
    await open(page);
    await addText(page, 0.2, 0.2, "複製する文字");
    // 置いたあとの文字は選ばれたままなので、帯の「複製」を押す
    await page.getByTestId("pdf-annotate-toolbar-duplicate").click();
    await expect(page.getByTestId("pdf-annotate-text-object")).toHaveCount(2);
    await expect(page.getByTestId("pdf-annotate-text-object").nth(1)).toHaveText("複製する文字");
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

    await addCheck(page, 0.6, 0.7);
    await page.getByTestId("pdf-annotate-checkbox-object").first().click({ position: { x: 1, y: 1 } });
    // チェックを押すとチェックが切り替わるが、選んだ状態になり、帯が出る
    await page.getByTestId("pdf-annotate-object-toolbar").getByTestId("pdf-annotate-toolbar-duplicate").click();
    await expect(page.getByTestId("pdf-annotate-checkbox-object")).toHaveCount(2);
  });

  test("配置した注釈の一覧は、選んだものだけ開き、ほかは見出し（種類・中身）だけ。見出しを押すと開く", async ({ page }) => {
    await open(page);
    await addText(page, 0.2, 0.15, "申請日");
    await addText(page, 0.2, 0.35, "山田太郎");
    await addCheck(page, 0.7, 0.6);
    const items = page.getByTestId("pdf-annotate-object-item");
    await expect(items).toHaveCount(3);
    // 最後に置いたチェックだけが開いている
    await expect(items.nth(0)).toHaveAttribute("data-expanded", "false");
    await expect(items.nth(1)).toHaveAttribute("data-expanded", "false");
    await expect(items.nth(2)).toHaveAttribute("data-expanded", "true");
    await expect(items.nth(0).getByTestId("pdf-annotate-text-input")).toHaveCount(0);
    // 見出しで、何の注釈か分かる
    await expect(items.nth(0).getByTestId("pdf-annotate-object-summary")).toContainText("テキスト");
    await expect(items.nth(0).getByTestId("pdf-annotate-object-summary")).toContainText("申請日");
    await expect(items.nth(1).getByTestId("pdf-annotate-object-summary")).toContainText("山田太郎");
    await expect(items.nth(2).getByTestId("pdf-annotate-object-summary")).toContainText("チェック");
    // 見出しを押すと、その注釈が開き、ほかは閉じる
    await items.nth(1).getByTestId("pdf-annotate-object-summary").click();
    await expect(items.nth(1)).toHaveAttribute("data-expanded", "true");
    await expect(items.nth(2)).toHaveAttribute("data-expanded", "false");
    await expect(items.nth(1).getByTestId("pdf-annotate-text-input")).toHaveValue("山田太郎");
    // もう一度押すと閉じる
    await items.nth(1).getByTestId("pdf-annotate-object-summary").click();
    await expect(items.nth(1)).toHaveAttribute("data-expanded", "false");
  });
});
