import fs from "node:fs";
import { unzipSync } from "fflate";
import { test as premiumTest, expect } from "../fixtures/premium-test";
import { test as baseTest, type Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { setDevPlanOverride } from "../helpers/dev-plan";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { runBatchSequentially } from "@/lib/batch/run-batch";
import { BATCH_LIMITS, canUseBatch } from "@/lib/batch/batch-config";
import { BATCH_COPY_PAIRS } from "@/lib/seo/batch-copy";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { adaptToolSeoContentWith } from "@/lib/seo/feature-copy";
import { chooseCompressOnly } from "../helpers/image-ops";

/**
 * Premium 複数ファイル一括処理のテスト。
 * - 無料・旧スタンダードは1ファイルずつ（単体処理はこれまでどおり使える）。複数を選ぶと案内が出る。
 * - プレミアムは対応ツール（画像圧縮・画像リサイズ・PDF圧縮、既存の画像形式変換など）でまとめて処理できる。
 */

// ---------------------------------------------------------------------------
// 仕組み（ブラウザを使わない確認）
// ---------------------------------------------------------------------------

baseTest.describe("一括処理の仕組み", () => {
  baseTest("1ファイルずつ順番に処理し、途中で失敗しても残りのファイルは処理を続ける", async () => {
    const files = ["a.png", "b.png", "c.png"].map((name) => new File(["x"], name));
    const order: string[] = [];
    let maxConcurrent = 0;
    let running = 0;
    const updates: string[][] = [];
    const items = await runBatchSequentially(
      files,
      async (file) => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        order.push(file.name);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (file.name === "b.png") throw new Error("壊れた画像です");
        return file.name.toUpperCase();
      },
      (next) => updates.push(next.map((i) => i.status))
    );
    expect(order).toEqual(["a.png", "b.png", "c.png"]);
    expect(maxConcurrent).toBe(1);
    expect(items.map((i) => i.status)).toEqual(["done", "error", "done"]);
    expect(items[1].error).toBe("壊れた画像です");
    expect(items[2].result).toBe("C.PNG");
    expect(updates[0]).toEqual(["waiting", "waiting", "waiting"]);
    expect(updates).toContainEqual(["done", "processing", "waiting"]);
  });

  baseTest("一括処理を使えるのはプレミアムだけ（無料・旧スタンダード・プラン不明は使えない）", () => {
    expect(canUseBatch("premium")).toBe(true);
    expect(canUseBatch("standard")).toBe(false);
    expect(canUseBatch("free")).toBe(false);
    expect(canUseBatch(null)).toBe(false);
  });

  baseTest("説明文に書いた上限の数が、実際の上限と一致している", () => {
    const text = BATCH_COPY_PAIRS.map((p) => `${p.on}${p.off}`).join("\n");
    expect(text).toContain(`最大${BATCH_LIMITS["image-format-convert"]}枚`);
    expect(text).toContain(`最大${BATCH_LIMITS["background-remover"]}枚`);
    expect(text).toContain(`最大${BATCH_LIMITS["pdf-compress"]}個のPDF`);
    // 工程3：画像リサイズは画像圧縮に統合した（「画像リサイズ・圧縮」。上限は画像圧縮の設定を使う）
    expect(BATCH_LIMITS["image-compress"]).toBe(50);
    expect("image-resize" in BATCH_LIMITS).toBe(false);
  });

  baseTest("課金オフの間は、説明文からプレミアムの話がなくなる（だれでも一括処理を使えるため）", () => {
    for (const id of ["image-format-convert", "image-batch-convert", "background-remover", "image-padding-text", "image-padding", "image-compress", "pdf-compress"]) {
      const content = getToolSeoContent(id)!;
      const off = adaptToolSeoContentWith(content, { billing: false, ads: false, premiumOnly: false, standardOffered: false });
      const all = [off.metaTitle, off.metaDescription, off.lead, ...off.howTo, ...off.faq.flatMap((f) => [f.question, f.answer])].join("\n");
      expect(all, id).not.toContain("プレミアム");
      // 課金オンでは、一括処理がプレミアムの機能だと書いてある
      const on = adaptToolSeoContentWith(content, { billing: true, ads: false, premiumOnly: false, standardOffered: false });
      const onText = [on.metaDescription, on.lead, ...on.howTo, ...on.faq.map((f) => f.answer)].join("\n");
      expect(onText, id).toContain("プレミアムプラン");
    }
  });
});

// ---------------------------------------------------------------------------
// 無料・旧スタンダード：1ファイルずつ
// ---------------------------------------------------------------------------

async function asPlan(page: Page, plan: "free" | "standard", baseURL: string | undefined) {
  await setDevPlanOverride(page.context(), plan, baseURL!);
}

for (const plan of ["free", "standard"] as const) {
  baseTest.describe(`${plan === "free" ? "無料" : "旧スタンダード"}: 一括処理は使えず、1ファイルずつ処理できる`, () => {
    baseTest("画像圧縮: 2枚選ぶと1枚目だけを読み込み、プレミアムの機能だと案内する。そのまま1枚を処理できる", async ({ page, baseURL }) => {
      await asPlan(page, plan, baseURL);
      await page.goto("/tools/image-compress");
      await chooseCompressOnly(page);
      await expect(page.getByTestId("batch-hint")).toContainText("プレミアムプラン");
      await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
      const notice = page.getByTestId("batch-notice");
      await expect(notice).toContainText("一度に処理できるのは1ファイルです");
      await expect(notice).toContainText("sample.png");
      await expect(notice.getByRole("link", { name: "料金プランを見る" })).toHaveAttribute("href", "/pricing");
      await expect(page.getByRole("button", { name: "圧縮する", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /まとめて/ })).toHaveCount(0);
      await page.getByRole("button", { name: "圧縮する", exact: true }).click();
      await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("batch-results")).toHaveCount(0);
    });

    baseTest("1枚だけ選んだときは、案内を出さずにこれまでどおり処理できる", async ({ page, baseURL }) => {
      await asPlan(page, plan, baseURL);
      await page.goto("/tools/image-compress?mode=resize");
      await uploadFixture(page, fixtures.png);
      await expect(page.getByTestId("batch-notice")).toHaveCount(0);
      await page.getByRole("button", { name: "リサイズする", exact: true }).click();
      await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 30_000 });
    });

    baseTest("PDF圧縮: 2つ選ぶと1つ目だけを読み込む", async ({ page, baseURL }) => {
      await asPlan(page, plan, baseURL);
      await page.goto("/tools/pdf-compress");
      await uploadFixture(page, [fixtures.singlePagePdf, fixtures.multiPagePdf]);
      await expect(page.getByTestId("batch-notice")).toContainText("single-page.pdf");
      await expect(page.getByTestId("compress-run")).toHaveText("圧縮する");
    });

    baseTest("既存の画像形式変換: 2枚選ぶと1枚だけになり、ボタンも1件の変換になる", async ({ page, baseURL }) => {
      await asPlan(page, plan, baseURL);
      await page.goto("/tools/image-batch-convert");
      await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
      await expect(page.getByTestId("batch-notice")).toBeVisible();
      await page.getByTestId("convert-format-webp").click();
      await expect(page.getByRole("button", { name: "1件をWebPに変換する" })).toBeVisible();
      // もう1枚足しても、入れ替わるだけで2枚にはならない
      await uploadFixture(page, fixtures.portraitPng);
      await expect(page.getByRole("button", { name: "1件をWebPに変換する" })).toBeVisible();
    });
  });
}

baseTest("無料: 既存の明るさ調整・背景透過・余白文字入れも、2枚選ぶと1枚だけになる", async ({ page, baseURL }) => {
  await asPlan(page, "free", baseURL);
  for (const id of ["image-adjust", "background-remover", "image-padding-text"]) {
    await page.goto(`/tools/${id}`);
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    await expect(page.getByTestId("batch-notice"), id).toBeVisible();
    await expect(page.getByTestId("batch-hint"), id).toContainText("プレミアムプラン");
  }
});

// ---------------------------------------------------------------------------
// プレミアム：まとめて処理できる
// ---------------------------------------------------------------------------

function zipEntries(path: string): string[] {
  return Object.keys(unzipSync(new Uint8Array(fs.readFileSync(path))));
}

premiumTest.describe("プレミアム: 一括処理", () => {
  premiumTest("画像圧縮: 3枚をまとめて圧縮し、ファイルごとに完了が出て、ZIPと1枚ずつの両方で保存できる", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    await expect(page.getByTestId("batch-hint")).toContainText(`${BATCH_LIMITS["image-compress"]}枚まで`);
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg, fixtures.portraitPng]);
    await expect(page.getByTestId("batch-notice")).toHaveCount(0);
    await page.getByRole("button", { name: "3枚をまとめて圧縮する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("3ファイル中 3ファイルが完了", { timeout: 60_000 });
    await expect(page.getByTestId("batch-row").filter({ hasText: "完了" })).toHaveCount(3);

    const zip = await clickAndDownload(page, "完了した3ファイルをZIPで保存");
    expect(zip.suggestedFilename()).toBe("sample-compressed.zip");
    const { path } = await assertDownloadedFile(zip, { format: "zip" });
    expect(zipEntries(path)).toHaveLength(3);

    const one = page.waitForEvent("download");
    await page.getByTestId("batch-row").nth(1).getByRole("button", { name: /を保存$/ }).click();
    await assertDownloadedFile(await one, { minBytes: 10 });
  });

  premiumTest("壊れた画像が混ざっていても、ほかの画像は処理され、成功したものだけがZIPに入る", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    await uploadFixture(page, [fixtures.png, fixtures.corruptedImage, fixtures.landscapeJpg]);
    await page.getByRole("button", { name: "3枚をまとめて圧縮する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("3ファイル中 2ファイルが完了・1ファイルが失敗", { timeout: 60_000 });
    await expect(page.getByTestId("batch-row").nth(1)).toHaveAttribute("data-status", "error");
    const zip = await clickAndDownload(page, "完了した2ファイルをZIPで保存");
    const { path } = await assertDownloadedFile(zip, { format: "zip" });
    expect(zipEntries(path)).toHaveLength(2);
  });

  premiumTest("同じ名前の画像があっても、ZIPの中で上書きされない", async ({ page }) => {
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    const png = fs.readFileSync(fixtures.png);
    const portrait = fs.readFileSync(fixtures.portraitPng);
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: "photo.png", mimeType: "image/png", buffer: png },
      { name: "photo.png", mimeType: "image/png", buffer: portrait },
    ]);
    await page.getByRole("button", { name: "2枚をまとめて圧縮する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
    const { path } = await assertDownloadedFile(await clickAndDownload(page, "完了した2ファイルをZIPで保存"), { format: "zip" });
    const names = zipEntries(path);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  premiumTest("上限を超えて選ぶと、上限の枚数だけを読み込んで案内する", async ({ page }) => {
    const limit = BATCH_LIMITS["image-compress"];
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    const png = fs.readFileSync(fixtures.png);
    const many = Array.from({ length: limit + 1 }, (_, i) => ({ name: `img-${i + 1}.png`, mimeType: "image/png", buffer: png }));
    await page.locator('input[type="file"]').first().setInputFiles(many);
    await expect(page.getByTestId("batch-notice")).toContainText(`${limit}ファイルまで`);
    await expect(page.getByTestId("batch-notice")).toContainText("超えた1ファイル");
    await expect(page.getByRole("button", { name: `${limit}枚をまとめて圧縮する` })).toBeVisible();
  });

  premiumTest("画像リサイズ: 縦横比を固定すると、指定した幅に合わせて画像ごとに高さが決まる", async ({ page }) => {
    await page.goto("/tools/image-compress?mode=resize");
    // sample.png は 64×64、landscape.jpg は 300×200
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    await expect(page.getByTestId("batch-resize-note")).toContainText("画像ごとに高さを自動で決めます");
    const widthInput = page.getByLabel("幅 (px)");
    await expect(widthInput).toHaveValue("64");
    await widthInput.fill("30");
    await page.getByRole("button", { name: "2枚をまとめてリサイズする" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
    await expect(page.getByTestId("batch-row").nth(0)).toContainText("30×30px");
    await expect(page.getByTestId("batch-row").nth(1)).toContainText("30×20px");
  });

  premiumTest("PDF圧縮: 2つのPDFをまとめて圧縮し、ZIPで保存できる", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    await expect(page.getByTestId("batch-hint")).toContainText(`${BATCH_LIMITS["pdf-compress"]}ファイルまで`);
    await uploadFixture(page, [fixtures.singlePagePdf, fixtures.multiPagePdf]);
    await page.getByTestId("compress-mode-quality").check();
    await expect(page.getByTestId("compress-run")).toHaveText("2つのPDFをまとめて圧縮する");
    await page.getByTestId("compress-run").click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
    const zip = await clickAndDownload(page, "完了した2ファイルをZIPで保存");
    const { path } = await assertDownloadedFile(zip, { format: "zip" });
    const names = zipEntries(path).sort();
    expect(names).toEqual(["multi-page-compressed.pdf", "single-page-compressed.pdf"]);
  });

  premiumTest("ページを開いた後にプレミアムでなくなった場合、一括処理は始まらず案内が出る", async ({ page, baseURL }) => {
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    // 契約が終わった・ログアウトした状態を再現する（サーバーでの確認が無料になる）
    await setDevPlanOverride(page.context(), "free", baseURL!);
    await page.getByRole("button", { name: "2枚をまとめて圧縮する" }).click();
    await expect(page.getByTestId("batch-notice")).toContainText("プレミアムプランを確認できなかったため");
    await expect(page.getByTestId("batch-results")).toHaveCount(0);
  });

  premiumTest("スマホ幅でも、結果の一覧と保存ボタンが画面に収まる", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/tools/image-compress");
    await chooseCompressOnly(page);
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    await page.getByRole("button", { name: "2枚をまとめて圧縮する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
    await expect(page.getByRole("button", { name: "完了した2ファイルをZIPで保存" })).toBeInViewport({ ratio: 0.5 }).catch(async () => {
      await page.getByRole("button", { name: "完了した2ファイルをZIPで保存" }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "完了した2ファイルをZIPで保存" })).toBeInViewport();
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

baseTest("料金ページに、一括処理がプレミアムの機能であることが書いてある", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByTestId("pricing-batch-premium")).toContainText("複数ファイルの一括処理");
  await expect(page.getByTestId("pricing-batch-free")).toContainText("1つずつ");
});

// 既存の単体処理の確認（プレミアムでも、1ファイルのときは従来どおりの結果画面になる）
premiumTest("プレミアムでも、1枚だけのときは従来どおりの結果画面で保存できる", async ({ page }) => {
  await page.goto("/tools/image-compress");
  await chooseCompressOnly(page);
  await uploadFixture(page, fixtures.png);
  await page.getByRole("button", { name: "圧縮する", exact: true }).click();
  await waitForSuccess(page, "変換が完了しました");
  await expect(page.getByTestId("batch-results")).toHaveCount(0);
  await expect(page.getByTestId("result-popup")).toBeVisible();
});
