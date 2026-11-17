import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { createDefaultSurvey, newQuestion, type Question, type Survey } from "@/lib/survey/model";
import { approxMeasure, layoutSurvey, type Prim } from "@/lib/survey/layout";

/**
 * アンケート用紙作成（2026-11-17。/tools/survey-sheet）。
 * 編集（質問の追加・削除・複製・形式の変更・選択肢・並べ替え・セクション）、紙のプレビュー（即時の反映・A4縦横・ページ分け）、
 * PDF・Word・印刷、ブラウザ内の自動保存・復元・削除、スマホの表示を確かめる。
 */

const pythonOk = (() => {
  try {
    execFileSync("python3", ["-c", "import docx"], { stdio: "ignore" });
    execFileSync("which", ["pdftotext"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const sofficeOk = (() => {
  try {
    execFileSync("which", ["soffice"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function open(page: Page, { mobile = false } = {}) {
  await page.goto("/tools/survey-sheet");
  await expect(page.getByTestId("guide-open-howto")).toBeVisible();
  await page.waitForLoadState("networkidle");
  // 画面が操作できる状態（保存データの読み込みまで終わった状態）になるまで待つ
  await expect(page.getByTestId("survey-tool")).toHaveAttribute("data-loaded", "1");
  // スマホでは、プレビューは「プレビュー」を押すまで隠れている
  await expect(page.getByTestId(mobile ? "survey-editor" : "survey-page")).toBeVisible();
}

const pageText = (page: Page) => page.getByTestId("survey-page").textContent();
/** すべてのページの文字（ページを切り替えながら集める） */
async function allPagesText(page: Page): Promise<string> {
  const buttons = page.getByTestId("survey-page-button");
  const n = await buttons.count();
  if (n === 0) return (await pageText(page)) ?? "";
  let out = "";
  for (let i = 0; i < n; i++) {
    await buttons.nth(i).click();
    out += (await pageText(page)) ?? "";
  }
  await buttons.nth(0).click();
  return out;
}
const questions = (page: Page) => page.getByTestId("survey-question");

/** 質問カードを開く（編集中のカードだけが開いている） */
async function openCard(page: Page, i: number) {
  const card = questions(page).nth(i);
  if ((await card.getAttribute("data-active")) !== "1") await card.getByTestId("survey-question-open").click();
  await expect(card).toHaveAttribute("data-active", "1");
  return card;
}

async function designTab(page: Page) {
  await page.getByTestId("survey-panel").getByRole("radio", { name: "デザイン" }).click();
}

async function addQuestion(page: Page, type: string) {
  await page.getByTestId("survey-add").click();
  await page.getByTestId(`survey-add-${type}`).click();
}

async function download(page: Page, name: string, file: string) {
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name }).click();
  const d = await dl;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "survey-")), file);
  await d.saveAs(out);
  return { out, suggested: d.suggestedFilename() };
}

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------
test.describe("ページ分け（配置の計算）", () => {
  function texts(p: Prim[]): string[] {
    return p.filter((x): x is Extract<Prim, { k: "text" }> => x.k === "text").map((x) => x.text);
  }
  function build(qs: Question[], patch: Partial<Survey["design"]> = {}): Survey {
    const s = createDefaultSurvey();
    return { ...s, questions: qs, design: { ...s.design, ...patch } };
  }
  const choice = (n: number, opts = 6): Question => ({ ...newQuestion("single"), title: `設問${n}`, options: Array.from({ length: opts }, (_, i) => `答${n}-${i + 1}`) });

  test("質問の途中・選択肢の途中でページを分けない", () => {
    const layout = layoutSurvey(build(Array.from({ length: 25 }, (_, i) => choice(i + 1))), approxMeasure);
    expect(layout.pages.length).toBeGreaterThan(1);
    for (let n = 1; n <= 25; n++) {
      const pagesWith = layout.pages.map((p, i) => (texts(p).some((t) => t === `設問${n}` || t.startsWith(`答${n}-`)) ? i : -1)).filter((i) => i >= 0);
      expect(new Set(pagesWith).size, `設問${n} が複数のページに分かれています`).toBe(1);
    }
  });

  test("セクションの見出しだけがページの最後に残らない", () => {
    const qs: Question[] = [];
    for (let i = 1; i <= 12; i++) {
      qs.push({ ...newQuestion("section"), title: `見出し${i}` });
      qs.push(choice(i, 4));
    }
    const layout = layoutSurvey(build(qs), approxMeasure);
    expect(layout.pages.length).toBeGreaterThan(1);
    layout.pages.forEach((p, pi) => {
      const t = texts(p);
      for (let i = 1; i <= 12; i++) {
        const at = t.indexOf(`見出し${i}`);
        if (at < 0) continue;
        expect(t.slice(at + 1).includes(`設問${i}`), `見出し${i}（${pi + 1}ページ目）の後に、その質問が同じページにありません`).toBe(true);
      }
    });
  });

  test("長文記述の記入欄は分けない。すべての部品が用紙の中（余白の内側）に収まる", () => {
    const qs = Array.from({ length: 6 }, (_, i) => ({ ...newQuestion("long"), title: `長文${i + 1}`, lines: 12 }));
    for (const orientation of ["portrait", "landscape"] as const) {
      const layout = layoutSurvey(build(qs, { orientation, margin: 15 }), approxMeasure);
      const H = layout.height;
      for (const p of layout.pages) {
        for (const x of p) {
          if (x.k === "rect") {
            expect(x.y).toBeGreaterThanOrEqual(15 - 0.01);
            expect(x.y + x.h).toBeLessThanOrEqual(H - 15 + 1.5);
          }
          if (x.k === "text" && !/^\d+ \/ \d+$/.test(x.text)) expect(x.y).toBeLessThanOrEqual(H - 15 + 1);
        }
      }
    }
  });

  test("ページ番号は「n / 全体」で、オフにすると出ない", () => {
    const qs = Array.from({ length: 30 }, (_, i) => choice(i + 1));
    const on = layoutSurvey(build(qs, { pageNumbers: true }), approxMeasure);
    expect(texts(on.pages[0])).toContain(`1 / ${on.pages.length}`);
    const off = layoutSurvey(build(qs, { pageNumbers: false }), approxMeasure);
    expect(texts(off.pages[0]).some((t) => /^\d+ \/ \d+$/.test(t))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
test.describe("編集とプレビュー", () => {
  test("タイトル・説明の編集、質問の追加・削除・複製・形式の変更・選択肢・並べ替えが、すぐにプレビューに出る", async ({ page }) => {
    await open(page);
    await page.getByTestId("survey-title").fill("社員満足度アンケート");
    await page.getByTestId("survey-description").fill("ご協力をお願いします。");
    await expect.poll(() => pageText(page)).toContain("社員満足度アンケート");
    await expect.poll(() => pageText(page)).toContain("ご協力をお願いします。");
    await expect(questions(page)).toHaveCount(2);

    // 追加（単一選択）→ 質問文・選択肢を編集
    await addQuestion(page, "single");
    await expect(questions(page)).toHaveCount(3);
    const q3 = questions(page).nth(2);
    await q3.getByTestId("survey-question-title").fill("通勤手段を教えてください");
    await q3.getByTestId("survey-option").nth(0).fill("電車");
    await q3.getByTestId("survey-option-add").click();
    await expect(q3.getByTestId("survey-option")).toHaveCount(4);
    await q3.getByTestId("survey-option").nth(3).fill("自転車");
    await q3.getByTestId("survey-option-remove").nth(1).click();
    await expect(q3.getByTestId("survey-option")).toHaveCount(3);
    await expect.poll(() => pageText(page)).toContain("通勤手段を教えてください");
    await expect.poll(() => pageText(page)).toContain("自転車");
    await expect.poll(() => pageText(page)).not.toContain("選択肢2");

    // 複製・形式の変更
    await q3.getByTestId("survey-question-duplicate").click();
    await expect(questions(page)).toHaveCount(4);
    await questions(page).nth(3).getByTestId("survey-question-type").selectOption("multiple");
    await expect(questions(page).nth(3)).toHaveAttribute("data-type", "multiple");
    await expect(questions(page).nth(3).getByTestId("survey-option").nth(0)).toHaveValue("電車");

    // セクションの追加
    await addQuestion(page, "section");
    await questions(page).nth(4).getByTestId("survey-question-title").fill("基本情報");
    await expect.poll(() => pageText(page)).toContain("基本情報");

    // 並べ替え（ボタン）：セクションを先頭へ
    for (let i = 0; i < 4; i++) await questions(page).nth(4 - i).getByTestId("survey-question-up").click();
    await expect(questions(page).nth(0)).toHaveAttribute("data-type", "section");
    // 番号はセクションを数えない
    await expect.poll(async () => (await pageText(page))?.indexOf("基本情報") ?? -1).toBeLessThan(await pageText(page).then((t) => t?.indexOf("満足度を教えてください") ?? 0));

    // 並べ替え（ドラッグ）：2つ目を最後へ
    const firstTitle = await (await openCard(page, 1)).getByTestId("survey-question-title").inputValue();
    const handle = questions(page).nth(1).getByTestId("survey-question-drag");
    const target = questions(page).nth(4);
    const hb = (await handle.boundingBox())!;
    const tb = (await target.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, tb.y + tb.height - 5, { steps: 12 });
    await page.mouse.up();
    await expect((await openCard(page, 4)).getByTestId("survey-question-title")).toHaveValue(firstTitle);

    // 削除（ゴミ箱のアイコン）
    await expect(questions(page).nth(4).getByTestId("survey-question-remove").locator("svg[data-icon=trash]")).toHaveCount(1);
    await questions(page).nth(4).getByTestId("survey-question-remove").click();
    await expect(questions(page)).toHaveCount(4);
    await expect.poll(() => pageText(page)).not.toContain(firstTitle);
  });

  test("すべての形式を追加でき、紙に必要な記号・記入欄が出る（日本語の文字もそのまま）", async ({ page }) => {
    await open(page);
    for (const t of ["multiple", "short", "long", "rating", "scale", "number", "date"]) await addQuestion(page, t);
    await expect(questions(page)).toHaveCount(9);
    expect(await page.locator("#survey-print-root polygon").count()).toBe(5); // 評価の★5つ（すべてのページ）
    expect(await page.locator("#survey-print-root circle").count()).toBeGreaterThan(5); // 単一選択・段階評価の○（すべてのページ）
    const all = await allPagesText(page);
    expect(all).toContain("とても良い");
    expect(all).toContain("歳");
    expect(all).toContain("年");
    // 必須の印（スイッチ）
    const req = (await openCard(page, 2)).getByTestId("survey-question-required");
    await req.click();
    await expect(req).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => pageText(page)).toContain("必須");
  });

  test("A4縦・横の切り替え、余白・文字の大きさ、複数ページとページの切り替え、ページ番号", async ({ page }) => {
    await open(page);
    const svg = page.getByTestId("survey-page");
    await expect(svg).toHaveAttribute("viewBox", "0 0 210 297");
    await designTab(page);
    await page.getByTestId("survey-orientation").getByRole("radio", { name: "A4横" }).click();
    await expect(svg).toHaveAttribute("viewBox", "0 0 297 210");
    await page.getByTestId("survey-orientation").getByRole("radio", { name: "A4縦" }).click();
    // 余白を変えると、タイトルの位置が変わる
    const x1 = await svg.locator("text").first().getAttribute("y");
    await page.getByTestId("survey-margin").fill("28");
    await expect.poll(() => svg.locator("text").first().getAttribute("y")).not.toBe(x1);
    await page.getByTestId("survey-panel").getByRole("radio", { name: "質問" }).click();
    // 長文の質問を足して、2ページ以上にする
    for (let i = 0; i < 6; i++) await addQuestion(page, "long");
    await expect(page.getByTestId("survey-page-count")).toContainText(/全[2-9]ページ/);
    await expect(page.getByTestId("survey-page-button")).not.toHaveCount(0);
    // 足した質問（編集中）が載っているページが出ている。ページを切り替えられる
    await page.getByTestId("survey-page-button").nth(0).click();
    expect(await pageText(page)).toMatch(/1 \/ \d/);
    await page.getByTestId("survey-page-button").nth(1).click();
    expect(await pageText(page)).toMatch(/2 \/ \d/);
    await designTab(page);
    await page.getByTestId("survey-page-numbers").click();
    await expect.poll(() => pageText(page)).not.toMatch(/\d \/ \d/);
  });

  test("編集中のカードだけが開き、ほかは要約で表示。プレビューの質問を押すと、その質問を編集できる", async ({ page }) => {
    await open(page);
    await expect(questions(page).nth(0)).toHaveAttribute("data-active", "0");
    await expect(questions(page).nth(0)).toContainText("満足 / やや満足 / やや不満 / 不満");
    await openCard(page, 0);
    await expect(questions(page).nth(1)).toHaveAttribute("data-active", "0");
    // ○ は飾り（用紙で回答者が丸を付ける場所）であることを知らせる
    await expect(questions(page).nth(0).getByTestId("survey-options-hint")).toContainText("ここでは押せません");
    // プレビューの2つ目の質問を押す → 2つ目のカードが開く
    const q2id = await questions(page).nth(1).getAttribute("data-qid");
    await page.locator(`[data-testid=survey-preview-region][data-id="${q2id}"]`).click();
    await expect(questions(page).nth(1)).toHaveAttribute("data-active", "1");
    await expect(questions(page).nth(0)).toHaveAttribute("data-active", "0");
    // 長文の記入欄の高さ（＋）
    await expect(questions(page).nth(1).getByTestId("survey-long-lines")).toHaveText("5行");
    await questions(page).nth(1).getByTestId("survey-long-more").click();
    await expect(questions(page).nth(1).getByTestId("survey-long-lines")).toHaveText("6行");
  });

  test("「その他」の追加・削除、横に並べるスイッチ、この下に質問を追加、プレビューの拡大", async ({ page }) => {
    await open(page);
    const c = await openCard(page, 0);
    await c.getByTestId("survey-other-add").click();
    await expect.poll(() => pageText(page)).toContain("その他");
    await c.getByTestId("survey-other-remove").click();
    await expect.poll(() => pageText(page)).not.toContain("その他");
    const dir = c.getByTestId("survey-question-direction");
    await expect(dir).toHaveAttribute("aria-checked", "true");
    await dir.click();
    await expect(dir).toHaveAttribute("aria-checked", "false");
    // この下に追加：1つ目と2つ目の間に入る
    await c.getByTestId("survey-question-insert").click();
    await page.getByTestId("survey-add-menu").getByTestId("survey-add-date").click();
    await expect(questions(page)).toHaveCount(3);
    await expect(questions(page).nth(1)).toHaveAttribute("data-type", "date");
    await expect(questions(page).nth(1)).toHaveAttribute("data-active", "1");
    // 拡大
    await page.getByTestId("survey-zoom-in").click();
    await expect(page.getByTestId("survey-zoom")).toHaveText("125%");
    await expect(page.getByTestId("survey-page")).toHaveAttribute("style", /width: 125%/);
  });

  test("テンプレート：見た目だけが変わり、質問は消えない。質問例は確認してから入れ替える", async ({ page }) => {
    await open(page);
    await page.getByTestId("survey-title").fill("私のアンケート");
    await designTab(page);
    await page.getByTestId("survey-template-school").click();
    await expect(page.getByTestId("survey-template-school")).toHaveAttribute("aria-pressed", "true");
    // 質問例：やめる → そのまま
    await page.getByTestId("survey-use-sample").click();
    await page.getByTestId("survey-confirm-no").click();
    await page.getByTestId("survey-panel").getByRole("radio", { name: "質問" }).click();
    await expect(page.getByTestId("survey-title")).toHaveValue("私のアンケート");
    await expect(questions(page)).toHaveCount(2);
    await designTab(page);
    // 入れ替える
    await page.getByTestId("survey-use-sample").click();
    await page.getByTestId("survey-confirm-yes").click();
    await page.getByTestId("survey-panel").getByRole("radio", { name: "質問" }).click();
    await expect(page.getByTestId("survey-title")).toHaveValue("学校生活アンケート");
    await expect(questions(page)).toHaveCount(4);
  });
});

// ---------------------------------------------------------------------------
test.describe("出力", () => {
  test.skip(!pythonOk, "python-docx・pdftotext が無い環境");

  test("PDF：A4で、プレビューと同じページ数・日本語の文字が入る。横向きにも対応", async ({ page }) => {
    await open(page);
    await designTab(page);
    await page.getByTestId("survey-template-business").click();
    await page.getByTestId("survey-use-sample").click();
    await page.getByTestId("survey-confirm-yes").click();
    await page.getByTestId("survey-panel").getByRole("radio", { name: "質問" }).click();
    for (let i = 0; i < 4; i++) await addQuestion(page, "long");
    await page.waitForTimeout(800);
    const previewPages = Number((await page.getByTestId("survey-page-count").textContent())!.match(/全(\d+)ページ/)![1]);
    await page.getByTestId("survey-make-pdf").click();
    await expect(page.getByTestId("survey-pdf-ready")).toBeVisible({ timeout: 60_000 });
    const { out, suggested } = await download(page, "PDFをダウンロード", "a.pdf");
    expect(suggested).toBe("セミナー参加者アンケート.pdf");
    const info = execFileSync("pdfinfo", [out]).toString();
    expect(Number(/Pages:\s+(\d+)/.exec(info)![1])).toBe(previewPages);
    expect(info).toMatch(/Page size:\s+595\.\d+ x 841\.\d+/);
    const text = execFileSync("pdftotext", ["-layout", out, "-"]).toString();
    expect(text).toContain("セミナー参加者アンケート");
    expect(text).toContain("セミナーについて");
    expect(text).toContain("やや満足");
    expect(text).toMatch(new RegExp(`1\\s*/\\s*${previewPages}`));

    // 横向き
    await designTab(page);
    await page.getByTestId("survey-orientation").getByRole("radio", { name: "A4横" }).click();
    await expect(page.getByTestId("survey-pdf-ready")).toHaveCount(0); // 内容が変わったら作り直す
    await page.getByTestId("survey-make-pdf").click();
    await expect(page.getByTestId("survey-pdf-ready")).toBeVisible({ timeout: 60_000 });
    const land = await download(page, "PDFをダウンロード", "b.pdf");
    expect(execFileSync("pdfinfo", [land.out]).toString()).toMatch(/Page size:\s+841\.\d+ x 595\.\d+/);
  });

  test("Word：文字・段落・表で作られ（画像なし）、Wordで編集できる形。用紙・ページ番号も入る", async ({ page }) => {
    await open(page);
    await designTab(page);
    await page.getByTestId("survey-template-business").click();
    await page.getByTestId("survey-use-sample").click();
    await page.getByTestId("survey-confirm-yes").click();
    await page.getByTestId("survey-make-docx").click();
    await expect(page.getByTestId("survey-docx-ready")).toBeVisible({ timeout: 60_000 });
    const { out, suggested } = await download(page, "Wordをダウンロード", "a.docx");
    expect(suggested).toBe("セミナー参加者アンケート.docx");
    const r = JSON.parse(
      execFileSync("python3", [
        "-c",
        `import json,sys,docx,zipfile
d=docx.Document(sys.argv[1])
s=d.sections[0]
z=zipfile.ZipFile(sys.argv[1])
paras=[p.text for p in d.paragraphs]
cells=[c.text for t in d.tables for row in t.rows for c in row.cells]
print(json.dumps({"paras":paras,"cells":cells,"tables":len(d.tables),"images":len(d.inline_shapes),"media":[n for n in z.namelist() if n.startswith("word/media")],
"w":round(s.page_width.mm),"h":round(s.page_height.mm),"footer":z.read("word/footer1.xml").decode() if "word/footer1.xml" in z.namelist() else ""}))`,
        out,
      ]).toString(),
    );
    const all = [...r.paras, ...r.cells].join("\n");
    expect(all).toContain("セミナー参加者アンケート");
    expect(all).toContain("セミナーについて");
    expect(all).toContain("内容の難易度はいかがでしたか");
    expect(all).toContain("○ 難しい");
    expect(all).toContain("□ メール");
    expect(all).toContain("氏名：");
    expect(all).toContain("やや満足");
    expect(r.tables).toBeGreaterThanOrEqual(3);
    expect(r.images).toBe(0);
    expect(r.media).toEqual([]);
    expect([r.w, r.h]).toEqual([210, 297]);
    expect(r.footer).toContain("PAGE");
    if (sofficeOk) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-"));
      execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, out], { stdio: "ignore", timeout: 120_000 });
      expect(fs.readdirSync(dir).some((f) => f.endsWith(".pdf"))).toBe(true);
    }
  });

  test("印刷：紙のページだけが印刷され、編集画面・ボタンは印刷されない", async ({ page }) => {
    await open(page);
    for (let i = 0; i < 5; i++) await addQuestion(page, "long");
    const n = Number((await page.getByTestId("survey-page-count").textContent())!.match(/全(\d+)ページ/)![1]);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#survey-print-root")).toBeVisible();
    await expect(page.locator("#survey-print-root .survey-print-page")).toHaveCount(n);
    await expect(page.getByTestId("survey-editor")).toBeHidden();
    await expect(page.getByTestId("survey-make-pdf")).toBeHidden();
    await expect(page.locator("header").first()).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    await expect(page.locator("#survey-print-root")).toBeHidden();
    await expect(page.getByTestId("survey-editor")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
test.describe("ブラウザ内の保存", () => {
  const KEY = "mr-satto:survey-sheet:draft:v1";
  const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), KEY);

  test("最初は保存しない。閉じる前に確認を出す（入力した内容が消えるため）", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("survey-persist")).not.toBeChecked();
    await page.getByTestId("survey-title").fill("保存しないテスト");
    await addQuestion(page, "short");
    await page.waitForTimeout(900);
    expect(await stored(page)).toBeNull();
    await expect(page.getByTestId("survey-save-status")).toContainText("保存していません");
    // 再読み込みしようとすると、確認が出る（受け入れると内容は消える）
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await page.reload();
    expect(dialogs).toContain("beforeunload");
    await expect(page.getByTestId("survey-title")).toHaveValue("アンケート");
    await expect(page.getByTestId("survey-restored")).toHaveCount(0);
  });

  test("「この端末に保存する」を選ぶと保存し、再読み込みしても続きから表示する。チェックを外すと保存した内容を消す", async ({ page }) => {
    await open(page);
    await page.getByTestId("survey-title").fill("保存のテスト");
    await addQuestion(page, "rating");
    await page.getByTestId("survey-persist").check();
    await expect(page.getByTestId("survey-save-status")).toContainText("保存しました");
    // 保存は端末のブラウザ（localStorage）だけ
    await expect.poll(() => stored(page)).toContain("保存のテスト");

    await page.reload();
    await expect(page.getByTestId("survey-title")).toHaveValue("保存のテスト");
    await expect(questions(page)).toHaveCount(3);
    await expect(page.getByTestId("survey-restored")).toBeVisible();
    await expect(page.getByTestId("survey-persist")).toBeChecked();

    // チェックを外す → 保存した内容はすぐ消える（画面の内容はそのまま）
    await page.getByTestId("survey-persist").uncheck();
    expect(await stored(page)).toBeNull();
    await expect(page.getByTestId("survey-save-status")).toContainText("削除しました");
    await expect(page.getByTestId("survey-title")).toHaveValue("保存のテスト");
    // 外したあとに編集しても、保存しない
    await page.getByTestId("survey-title").fill("保存のテスト2");
    await page.waitForTimeout(900);
    expect(await stored(page)).toBeNull();
    page.on("dialog", (d) => void d.accept());
    await page.reload();
    await expect(page.getByTestId("survey-title")).toHaveValue("アンケート");
    await expect(page.getByTestId("survey-restored")).toHaveCount(0);
    await expect(page.getByTestId("survey-persist")).not.toBeChecked();
  });

  test("壊れた保存データがあっても画面は止まらない。編集中にサーバーへの送信はない", async ({ page }) => {
    await page.addInitScript(() => {
      // 1回目の読み込みのときだけ、壊れたデータを入れる
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("mr-satto:survey-sheet:draft:v1", "{ broken json");
      }
    });
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET" && !/__nextjs|hot-update|_rsc|analytics/.test(r.url())) posts.push(`${r.method()} ${r.url()}`);
    });
    await open(page);
    await expect(page.getByTestId("survey-title")).toHaveValue("アンケート");
    await expect(page.getByTestId("survey-persist")).not.toBeChecked();
    await page.getByTestId("survey-persist").check();
    await page.getByTestId("survey-title").fill("送信されないこと");
    await addQuestion(page, "short");
    await page.waitForTimeout(800);
    expect(posts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
test.describe("スマホの幅", () => {
  test.use({ viewport: { width: 375, height: 800 } });
  test("編集とプレビューを切り替えられ、質問の追加・削除・並べ替えができる。横スクロールは出ない", async ({ page }) => {
    await open(page, { mobile: true });
    await expect(page.getByTestId("survey-editor")).toBeVisible();
    await expect(page.getByTestId("survey-page")).toBeHidden();
    await addQuestion(page, "multiple");
    await expect(questions(page)).toHaveCount(3);
    await questions(page).nth(2).getByTestId("survey-question-up").click();
    await expect(questions(page).nth(1)).toHaveAttribute("data-type", "multiple");
    await questions(page).nth(1).getByTestId("survey-question-remove").click();
    await expect(questions(page)).toHaveCount(2);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(1);
    await page.getByTestId("survey-tabs").getByRole("radio", { name: /プレビュー/ }).click();
    await expect(page.getByTestId("survey-page")).toBeVisible();
    await expect(page.getByTestId("survey-editor")).toBeHidden();
    expect(await overflow()).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("survey-make-pdf")).toBeVisible();
  });
});
