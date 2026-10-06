import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { strFromU8, unzipSync } from "fflate";
import fs from "node:fs";

/**
 * ラベル作成ツール(id: excel-label)のE2Eテスト。
 * 生成されたWord/Excelの中身(XML)まで読み、設定(文字の大きさ・内容・ページ数・寸法)が反映されていることを確認する。
 */

function readZipText(filePath: string, name: string): string {
  const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)));
  const entry = files[name];
  if (!entry) throw new Error(`${name} が見つかりません: ${Object.keys(files).join(", ")}`);
  return strFromU8(entry);
}


/** ツール本体(動的読み込み)の水和が終わるまで待つ。開発サーバーの初回コンパイル直後は、水和前に操作すると入力が無視される */
async function openTool(page: import("@playwright/test").Page) {
  await page.goto("/tools/excel-label");
  await page.waitForFunction(() => {
    const el = Array.from(document.querySelectorAll("button")).find((b) => /Wordを作成/.test(b.textContent ?? ""));
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
  });
}

async function downloadDocx(page: import("@playwright/test").Page): Promise<{ doc: string; path: string }> {
  await page.getByRole("button", { name: "Wordを作成" }).click();
  await expect(page.getByText("ラベルシートを作成しました")).toBeVisible({ timeout: 15_000 });
  const download = await clickAndDownload(page, /Wordファイルをダウンロード/);
  const path = (await download.path())!;
  // 目視確認用: LABEL_DUMP_DIR を指定すると、生成したWordをそのフォルダへ保存する
  if (process.env.LABEL_DUMP_DIR) fs.copyFileSync(path, `${process.env.LABEL_DUMP_DIR}/label-${Date.now()}-${Math.floor(Math.random() * 1e4)}.docx`);
  return { doc: readZipText(path, "word/document.xml"), path };
}

test.describe("ラベル作成(Word)", () => {
  test("既定値: 全ラベル同じ内容のWordが作成され、12枚ぶんの文字が入る", async ({ page }) => {
    await openTool(page);
    await expect(page.getByTestId("label-cell")).toHaveCount(12);
    const { doc } = await downloadDocx(page);
    expect(doc.match(/見本ラベル/g)?.length).toBe(12);
    // 用紙A4・縦、上余白21.6mm(=1224twips)・左余白33.5mm(=1899twips)
    expect(doc).toMatch(/<w:pgSz [^>]*w:w="11906"[^>]*w:h="16838"/);
    expect(doc).toMatch(/w:top="1225"/);
    expect(doc).toMatch(/w:left="1899"/);
    // 12.0pt = 24 half-points
    expect(doc).toMatch(/<w:sz w:val="24"\/>/);
    // 行の高さは固定(42.3mm = 2398twips)
    expect(doc).toMatch(/<w:trHeight w:val="2398" w:hRule="exact"\/>/);
  });

  test("文字の大きさをバー・数値で変えると、プレビューとWordに反映される", async ({ page }) => {
    await openTool(page);
    const sizeInput = page.getByRole("spinbutton", { name: "文字の大きさ" });
    await sizeInput.fill("30");
    await sizeInput.blur();
    // 30pt = 60 half-points
    const { doc } = await downloadDocx(page);
    expect(doc).toMatch(/<w:sz w:val="60"\/>/);
    // 300ptまで数値で指定できる(バーの上限より大きい値)
    await sizeInput.fill("200");
    await sizeInput.blur();
    await expect(sizeInput).toHaveValue("200");
  });

  test("書体・太字・位置・枠線の設定がWordに反映される", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("書体").selectOption("mincho");
    await page.getByLabel("太字にする").check();
    await page.getByRole("button", { name: "左", exact: true }).first().click();
    await page.getByRole("button", { name: "上", exact: true }).click();
    await page.getByLabel(/ラベルの枠線を印刷する/).uncheck();
    const { doc } = await downloadDocx(page);
    expect(doc).toContain("游明朝");
    expect(doc).toContain("<w:b/>");
    expect(doc).toMatch(/<w:jc w:val="left"\/>/);
    expect(doc).toMatch(/<w:vAlign w:val="top"\/>/);
    // 枠線なし: ラベルの罫線(色999999)が出力されない
    expect(doc).not.toContain("999999");
  });

  test("ラベルごとに違う内容: 空行区切りで入り、使い始める位置を指定でき、複数ページになる", async ({ page }) => {
    await openTool(page);
    await page.getByRole("button", { name: "ラベルごとに違う内容" }).click();
    const entries = Array.from({ length: 14 }, (_, i) => `宛先${i + 1}\n住所${i + 1}`).join("\n\n");
    await page.getByLabel("ラベルごとの文字").fill(entries);
    await expect(page.getByText("14件のラベルを読み取りました（全2ページ）")).toBeVisible();
    await expect(page.getByTestId("label-page-indicator")).toHaveText("1 / 2ページ");
    // 1ページ目は12枚すべてに宛先1〜12
    await expect(page.getByTestId("label-cell").nth(0)).toContainText("宛先1");
    await expect(page.getByTestId("label-cell").nth(11)).toContainText("宛先12");
    // 使い始める位置を5にすると、先頭4枚は空欄になり、ページ数は増える(4+14=18枚→2ページ)
    await page.getByRole("spinbutton", { name: /使い始める位置/ }).fill("5");
    await expect(page.getByTestId("label-cell").nth(3)).toHaveText("");
    await expect(page.getByTestId("label-cell").nth(4)).toContainText("宛先1");
    const { doc } = await downloadDocx(page);
    for (let i = 1; i <= 14; i++) expect(doc).toContain(`宛先${i}<`);
    expect(doc.match(/<w:sectPr/g)?.length).toBe(2);
    // 次のページのプレビュー
    await page.getByRole("button", { name: "次のページ" }).click();
    await expect(page.getByTestId("label-page-indicator")).toHaveText("2 / 2ページ");
  });

  test("1行を1枚にする(タブ区切りは改行になる)", async ({ page }) => {
    await openTool(page);
    await page.getByRole("button", { name: "ラベルごとに違う内容" }).click();
    await page.getByLabel("ラベルの区切り方").selectOption("line");
    await page.getByLabel("ラベルごとの文字").fill("山田\t東京\n佐藤\t大阪");
    await expect(page.getByText("2件のラベルを読み取りました")).toBeVisible();
    await expect(page.getByTestId("label-cell").nth(0)).toContainText("山田");
    await expect(page.getByTestId("label-cell").nth(0)).toContainText("東京");
    const { doc } = await downloadDocx(page);
    expect(doc).toContain("山田<");
    expect(doc).toContain("東京<");
    expect(doc).toContain("大阪<");
  });

  test("用紙に収まらない設定ではエラーが出て作成できない", async ({ page }) => {
    await openTool(page);
    await page.getByRole("spinbutton", { name: "ラベル幅 (mm)" }).fill("120");
    await expect(page.getByText(/ラベルが用紙の横幅に収まりません/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Wordを作成" })).toBeDisabled();
  });

  test("文字が大きすぎるラベルには注意が出る", async ({ page }) => {
    await openTool(page);
    const sizeInput = page.getByRole("spinbutton", { name: "文字の大きさ" });
    await sizeInput.fill("100");
    await sizeInput.blur();
    await expect(page.getByText(/文字が枠に収まらない可能性があります/)).toBeVisible();
  });

  test("よくあるラベル用紙のプリセットを選ぶと寸法が入る", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("よくあるラベル用紙から選ぶ").selectOption("a4-21");
    await expect(page.getByRole("spinbutton", { name: "列数" })).toHaveValue("3");
    await expect(page.getByRole("spinbutton", { name: "行数" })).toHaveValue("7");
    await expect(page.getByTestId("label-cell")).toHaveCount(21);
  });

  test("用紙を横向きにすると、Wordの用紙が横向きになる", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("よくあるラベル用紙から選ぶ").selectOption("a4-12");
    await page.getByRole("button", { name: "横", exact: true }).click();
    // 横向きだと行数6は収まらないので、行数を減らす
    await page.getByRole("spinbutton", { name: "行数" }).fill("4");
    await page.getByRole("spinbutton", { name: "上の余白 (mm)" }).fill("10");
    const { doc } = await downloadDocx(page);
    expect(doc).toMatch(/<w:pgSz [^>]*w:w="16838"[^>]*w:h="11906"/);
    expect(doc).toContain('w:orient="landscape"');
  });
});

test.describe("ラベル作成(Excel)", () => {
  test("Excelを選ぶと、文字の大きさ・内容ごとの値が入ったxlsxができる", async ({ page }) => {
    await openTool(page);
    await page.getByRole("button", { name: "Excel", exact: true }).click();
    await page.getByRole("button", { name: "ラベルごとに違う内容" }).click();
    await page.getByLabel("ラベルごとの文字").fill("りんご\n\nみかん\n\nぶどう");
    const sizeInput = page.getByRole("spinbutton", { name: "文字の大きさ" });
    await sizeInput.fill("20");
    await sizeInput.blur();
    await page.getByRole("button", { name: "Excelを作成" }).click();
    await expect(page.getByText("ラベルシートを作成しました")).toBeVisible({ timeout: 15_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    const path = (await download.path())!;
    const strings = readZipText(path, "xl/sharedStrings.xml");
    for (const w of ["りんご", "みかん", "ぶどう"]) expect(strings).toContain(w);
    expect(strings).not.toContain("見本ラベル");
    const styles = readZipText(path, "xl/styles.xml");
    expect(styles).toMatch(/<sz val="20"\/>/);
  });
});
