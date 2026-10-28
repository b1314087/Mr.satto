import fs from "node:fs";
import { test as premiumTest, expect } from "../fixtures/premium-test";
import { test as baseTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { clearDevOverrides } from "../helpers/dev-plan";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile, closeResultPopup } from "../helpers/tool-runner";
import { tools } from "@/lib/tools/data";
import { detectConvertFormat, isSameFormat, outputFileNames, sizeChangePercent, splitByFormat, transparencyNote } from "@/lib/image-format-convert";

/**
 * 画像形式変換の共通画面（JPG変換・PNG変換・WebP変換・画像一括変換の4ページ）のテスト。
 * 変換はすべてブラウザ内。実際に生成されたファイルのマジックバイトまで確認する。
 */

const PAGES = [
  { id: "image-jpg-convert", format: "jpg", label: "JPG" },
  { id: "image-png-convert", format: "png", label: "PNG" },
  { id: "image-webp-convert", format: "webp", label: "WebP" },
  { id: "image-batch-convert", format: "jpg", label: "JPG" },
] as const;

/** ブラウザ内でWebP画像を作って、ファイルとして選ぶ（リポジトリにWebPの固定ファイルが無いため） */
async function uploadGeneratedWebp(page: Page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#3366cc";
    ctx.fillRect(0, 0, 40, 30);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/webp", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  await page.locator('input[type="file"]').first().setInputFiles({ name: "generated.webp", mimeType: "image/webp", buffer: Buffer.from(base64, "base64") });
}

premiumTest.describe("画像形式変換: 各URLの出力形式の初期選択", () => {
  for (const p of PAGES) {
    premiumTest(`${p.id}: 出力形式の初期選択は ${p.label}`, async ({ page }) => {
      await page.goto(`/tools/${p.id}`);
      // JPG変換ページで JPG を選ぶと同一形式になるため、初期選択の確認には別形式の画像を使う
      await uploadFixture(page, p.format === "png" ? fixtures.jpg : fixtures.png);
      await expect(page.getByTestId(`convert-format-${p.format}`)).toHaveAttribute("aria-pressed", "true");
      for (const other of ["jpg", "png", "webp"].filter((f) => f !== p.format)) {
        await expect(page.getByTestId(`convert-format-${other}`)).toHaveAttribute("aria-pressed", "false");
      }
      await expect(page.getByRole("button", { name: `1件を${p.label}に変換する` })).toBeEnabled();
    });
  }
});

premiumTest.describe("画像形式変換: 変換・プレビュー・ダウンロード", () => {
  premiumTest("プレビューに変換前後の画像と容量が出て、複数枚ならプレビューする画像を選べる", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    await uploadFixture(page, [fixtures.png, fixtures.portraitPng]);
    const preview = page.getByTestId("tool-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByAltText("変換前の画像")).toBeVisible();
    await expect(preview.getByAltText("変換後の画像")).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByText(/\d+ × \d+px ・ .+ → /)).toBeVisible();
    await expect(preview.getByText("透過部分は白になります")).toBeVisible();

    const select = page.getByTestId("convert-preview-select");
    await expect(select).toBeVisible();
    await select.selectOption("1");
    await expect(preview.getByAltText("変換後の画像")).toBeVisible({ timeout: 15_000 });
  });

  premiumTest("複数画像を変換するとZIPでまとめてダウンロードでき、ファイルごとの結果が出る", async ({ page }) => {
    await page.goto("/tools/image-batch-convert");
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    await page.getByTestId("convert-format-webp").click();
    await page.getByRole("button", { name: "2件をWebPに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");

    const rows = page.getByTestId("convert-result");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-status", "ok");
    await expect(rows.nth(1)).toHaveAttribute("data-status", "ok");
    await expect(rows.nth(0)).toContainText("→");

    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
    const zip = fs.readFileSync(path).toString("latin1");
    expect(zip).toContain("sample.webp");
    expect(zip).toContain("landscape.webp");
  });

  premiumTest("1枚だけ変換したときは、ZIPではなく画像ファイルをダウンロードできる", async ({ page }) => {
    await page.goto("/tools/image-webp-convert");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "1件をWebPに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toBe("sample.webp");
    await assertDownloadedFile(download, { format: "webp", minBytes: 10 });
  });

  premiumTest("WebPの画像をJPG・PNGへ変換できる（入力のWebP判定）", async ({ page }) => {
    await page.goto("/tools/image-png-convert");
    await uploadGeneratedWebp(page);
    await expect(page.getByTestId("convert-same-format")).toHaveCount(0);
    await page.getByRole("button", { name: "1件をPNGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toBe("generated.png");
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  });

  premiumTest("出力形式を変えると、前の形式の結果は消える", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "1件をJPGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByTestId("convert-result")).toHaveCount(1);
    await closeResultPopup(page);
    await page.getByTestId("convert-format-png").click();
    await expect(page.getByTestId("convert-results")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
  });
});

premiumTest.describe("画像形式変換: 同じ形式・エラーの扱い", () => {
  premiumTest("すでに出力形式と同じ画像は変換せずに除き、ほかの画像だけ変換する", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    await uploadFixture(page, [fixtures.png, fixtures.jpg]);
    await expect(page.getByTestId("convert-skip-note")).toContainText("すでにJPG形式の1枚");
    await page.getByRole("button", { name: "1件をJPGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const rows = page.getByTestId("convert-result");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-status", "ok");
    await expect(rows.nth(1)).toHaveAttribute("data-status", "skipped");
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
  });

  premiumTest("選んだ画像がすべて同じ形式なら、変換ボタンを押せず、案内が出る", async ({ page }) => {
    await page.goto("/tools/image-png-convert");
    await uploadFixture(page, fixtures.portraitPng);
    await expect(page.getByTestId("convert-all-same")).toBeVisible();
    await expect(page.getByTestId("convert-same-format")).toBeVisible();
    await expect(page.getByRole("button", { name: "0件をPNGに変換する" })).toBeDisabled();
    // 別の形式を選べば、変換できる
    await page.getByTestId("convert-format-jpg").click();
    await expect(page.getByRole("button", { name: "1件をJPGに変換する" })).toBeEnabled();
  });

  premiumTest("壊れた画像が混ざっていても、ほかの画像は変換でき、壊れた画像の理由が出る", async ({ page }) => {
    await page.goto("/tools/image-batch-convert");
    await uploadFixture(page, [fixtures.png, fixtures.corruptedImage]);
    await page.getByRole("button", { name: "2件をJPGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const rows = page.getByTestId("convert-result");
    await expect(rows.nth(0)).toHaveAttribute("data-status", "ok");
    await expect(rows.nth(1)).toHaveAttribute("data-status", "error");
    await expect(rows.nth(1)).toContainText("変換できませんでした");
    await expect(page.getByText("1件は変換できませんでした")).toBeVisible();
    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toBe("sample.jpg");
    await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
  });

  premiumTest("すべて変換できなかったときは、エラーを出し、ダウンロードは出さない", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    await uploadFixture(page, fixtures.corruptedImage);
    await page.getByRole("button", { name: "1件をJPGに変換する" }).click();
    await expect(page.getByText("変換できた画像がありませんでした")).toBeVisible();
    await expect(page.getByTestId("convert-result")).toHaveAttribute("data-status", "error");
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
  });

  premiumTest("画像ではないファイルは、変換の前に形式エラーで断る", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    await uploadFixture(page, fixtures.csv);
    await expect(page.getByText("このファイル形式には対応していません")).toBeVisible();
    await expect(page.getByTestId("convert-results")).toHaveCount(0);
  });
});

premiumTest.describe("画像形式変換: スマートフォン幅", () => {
  premiumTest.use({ viewport: { width: 375, height: 740 } });
  premiumTest("横にはみ出さず、形式の選択と変換・ダウンロードができる", async ({ page }) => {
    await page.goto("/tools/image-batch-convert");
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    await page.getByTestId("convert-format-png").click();
    await page.getByRole("button", { name: "1件をPNGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  });
});

baseTest.describe("画像形式変換: 広告ゲートとプラン判定（Free）", () => {
  baseTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  baseTest("Freeでも変換でき、ダウンロードの前に広告の確認画面が出る", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "1件をJPGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(page.getByTestId("download-gate-dialog")).toBeVisible();
  });
});

premiumTest.describe("画像形式変換: 既存URL・SEO・ツール登録の維持", () => {
  for (const p of PAGES) {
    premiumTest(`${p.id}: ツール登録・タイトル・canonical・サイトマップが維持されている`, async ({ page, request }) => {
      const tool = tools.find((t) => t.id === p.id);
      expect(tool?.category).toBe("image");
      expect(tool?.status).toBe("available");
      expect(tool?.requiredPlan).toBe("standard");

      await page.goto(`/tools/${p.id}`);
      await expect(page).toHaveTitle(new RegExp(p.id === "image-batch-convert" ? "画像一括変換" : `${p.label}変換`));
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toMatch(new RegExp(`/tools/${p.id}$`));
      await expect(page.getByRole("heading", { level: 1 })).toContainText(tool!.name);

      const sitemap = await (await request.get("/sitemap.xml")).text();
      expect(sitemap).toContain(`/tools/${p.id}<`);
    });
  }

  premiumTest("手順の説明が、実際の操作（複数枚・形式の切り替え・ZIP）と合っている", async ({ page }) => {
    await page.goto("/tools/image-jpg-convert");
    const body = await page.locator("main").innerText();
    expect(body).toContain("複数枚まとめて選べます");
    expect(body).toContain("ZIPにまとめて保存されます");
    expect(body).not.toContain("1ファイル・上限50MB");
  });
});

premiumTest.describe("画像形式変換: 共通ロジック（純粋な処理）", () => {
  premiumTest("形式の判定は、MIMEタイプを優先し、空のときだけ拡張子で補う", () => {
    expect(detectConvertFormat({ name: "a.JPG", type: "image/jpeg" })).toBe("image/jpeg");
    expect(detectConvertFormat({ name: "a.jpeg", type: "image/jpg" })).toBe("image/jpeg");
    expect(detectConvertFormat({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(detectConvertFormat({ name: "a.webp", type: "image/webp" })).toBe("image/webp");
    expect(detectConvertFormat({ name: "a.webp", type: "" })).toBe("image/webp");
    expect(detectConvertFormat({ name: "photo", type: "" })).toBeNull();
    expect(detectConvertFormat({ name: "a.gif", type: "image/gif" })).toBeNull();
    // MIMEが別の画像形式なら、拡張子が jpg でもその形式として扱わない
    expect(detectConvertFormat({ name: "a.jpg", type: "image/gif" })).toBeNull();
  });

  premiumTest("同じ形式の振り分けは、順序を保つ", () => {
    const files = [
      { name: "1.png", type: "image/png" },
      { name: "2.jpg", type: "image/jpeg" },
      { name: "3.png", type: "image/png" },
      { name: "4.gif", type: "image/gif" },
    ];
    const r = splitByFormat(files, "image/png");
    expect(r.sameFormat.map((f) => f.name)).toEqual(["1.png", "3.png"]);
    expect(r.convertible.map((f) => f.name)).toEqual(["2.jpg", "4.gif"]);
    expect(isSameFormat(files[1], "image/jpeg")).toBe(true);
  });

  premiumTest("出力ファイル名は拡張子を替え、同名は連番で一意にする", () => {
    expect(outputFileNames(["a.png", "b.jpeg"], "image/webp")).toEqual(["a.webp", "b.webp"]);
    expect(outputFileNames(["a.png", "a.jpg", "a.webp"], "image/jpeg")).toEqual(["a.jpg", "a_2.jpg", "a_3.jpg"]);
    expect(outputFileNames(["日本語.png"], "image/png")).toEqual(["日本語.png"]);
  });

  premiumTest("容量の増減と、透過の注意", () => {
    expect(sizeChangePercent(1000, 500)).toBe(-50);
    expect(sizeChangePercent(1000, 1500)).toBe(50);
    expect(sizeChangePercent(0, 10)).toBeNull();
    expect(transparencyNote("image/png", "image/jpeg")).toBe(true);
    expect(transparencyNote("image/jpeg", "image/jpeg")).toBe(false);
    expect(transparencyNote("image/png", "image/webp")).toBe(false);
  });
});
