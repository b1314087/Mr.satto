import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { test as premiumTest, expect } from "../fixtures/premium-test";
import { test as baseTest, type Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { setDevPlanOverride } from "../helpers/dev-plan";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { BATCH_LIMITS } from "@/lib/batch/batch-config";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { adaptToolSeoContentWith } from "@/lib/seo/feature-copy";

/**
 * プレミアムの一括処理を15ツールに追加（2026-11 料金プランの見直し）のテスト。
 * - プレミアム：2つ以上のファイルを選ぶと、同じ設定で1つずつ順番に処理し、結果の一覧からZIPでまとめて保存できる。
 * - 無料・旧スタンダード：これまでどおり1ファイルずつ（2つ選ぶと1つ目だけを読み込み、プレミアムの機能だと案内する）。
 */

type Upload = { name: string; mimeType: string; buffer: Buffer };

function asUpload(file: string, name = path.basename(file)): Upload {
  const ext = path.extname(file).toLowerCase();
  const mimeType =
    ext === ".pdf"
      ? "application/pdf"
      : ext === ".png"
        ? "image/png"
        : ext === ".jpg"
          ? "image/jpeg"
          : ext === ".zip"
            ? "application/zip"
            : ext === ".docx"
              ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return { name, mimeType, buffer: fs.readFileSync(file) };
}

async function upload(page: Page, files: Upload[]) {
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(files);
}

function zipEntries(file: string): string[] {
  return Object.keys(unzipSync(new Uint8Array(fs.readFileSync(file))));
}

interface Case {
  /** テストの名前 */
  name: string;
  url: string;
  key: keyof typeof BATCH_LIMITS;
  limit: number;
  unit: "枚" | "ファイル";
  files: () => Upload[];
  /** ファイルを選んだあと、処理の前にする操作（パスワードの入力など） */
  prepare?: (page: Page) => Promise<void>;
  /** まとめて処理するボタンの名前（2ファイルのとき） */
  button: string | RegExp;
  /** 全体のZIPに入るファイルの数（2ファイル分） */
  zipCount: number;
}

const image2 = () => [asUpload(fixtures.png), asUpload(fixtures.landscapeJpg)];
const pdf2 = () => [asUpload(fixtures.singlePagePdf), asUpload(fixtures.multiPagePdf)];

const CASES: Case[] = [
  { name: "PDF→画像", url: "/tools/pdf-to-image", key: "pdf-to-image", limit: 50, unit: "ファイル", files: pdf2, button: "2つのPDFをまとめて画像化する", zipCount: 0 },
  { name: "画像トリミング", url: "/tools/image-crop", key: "image-crop", limit: 50, unit: "枚", files: image2, button: "2枚をまとめてトリミングする", zipCount: 2 },
  { name: "画像回転・反転", url: "/tools/image-rotate", key: "image-rotate-flip", limit: 50, unit: "枚", files: image2, button: "2枚をまとめて回転する", zipCount: 2 },
  {
    name: "画像メタデータ削除",
    url: "/tools/image-metadata-remove",
    key: "image-metadata-remove",
    limit: 50,
    unit: "枚",
    files: image2,
    button: "2枚のメタデータをまとめて削除する",
    zipCount: 2,
  },
  { name: "画像ウォーターマーク", url: "/tools/image-watermark", key: "image-watermark", limit: 50, unit: "枚", files: image2, button: "2枚にまとめて透かしを追加する", zipCount: 2 },
  {
    name: "画像タイル分割",
    url: "/tools/image-tile-split",
    key: "image-tile-split",
    limit: 30,
    unit: "枚",
    files: image2,
    prepare: async (page) => {
      await page.getByRole("button", { name: "2×2", exact: true }).click();
    },
    button: "2枚をまとめて4枚ずつに分割する",
    zipCount: 8,
  },
  {
    name: "画像モザイク",
    url: "/tools/image-mosaic",
    key: "image-mosaic",
    limit: 30,
    unit: "枚",
    files: image2,
    prepare: async (page) => {
      await page.getByRole("button", { name: /範囲を追加/ }).click();
    },
    button: "2枚をまとめてPNGで保存",
    zipCount: 2,
  },
  {
    name: "PDF修正（ページ番号）",
    url: "/tools/pdf-fix?mode=page-numbers",
    key: "pdf-fix",
    limit: 20,
    unit: "ファイル",
    files: pdf2,
    button: "2つのPDFにまとめてページ番号を追加する",
    zipCount: 2,
  },
  {
    name: "PDF修正（透かし）",
    url: "/tools/pdf-fix?mode=watermark",
    key: "pdf-fix",
    limit: 20,
    unit: "ファイル",
    files: pdf2,
    button: "2つのPDFにまとめて透かしを追加する",
    zipCount: 2,
  },
  {
    name: "Word→PDF",
    url: "/tools/word-to-pdf",
    key: "word-to-pdf",
    limit: 10,
    unit: "ファイル",
    files: () => [asUpload(fixtures.wordPageBreakDocx), asUpload(fixtures.wordMarginsDocx)],
    button: "2つの文書をまとめてPDFに変換する",
    zipCount: 2,
  },
  {
    name: "Excel→PDF",
    url: "/tools/excel-to-pdf",
    key: "excel-to-pdf",
    limit: 10,
    unit: "ファイル",
    files: () => [asUpload(fixtures.xlsx, "a.xlsx"), asUpload(fixtures.xlsx, "b.xlsx")],
    button: "2つのファイルをまとめてPDFに変換する",
    zipCount: 2,
  },
  {
    name: "PDFパスワード保護",
    url: "/tools/pdf-password-protect",
    key: "pdf-password-protect",
    limit: 10,
    unit: "ファイル",
    files: pdf2,
    prepare: async (page) => {
      await page.getByLabel("開くためのパスワード").fill("secret123");
      await page.getByLabel("パスワード(確認用)").fill("secret123");
    },
    button: "2つのPDFにまとめてパスワードを設定する",
    zipCount: 2,
  },
  { name: "PDFページサイズ変更", url: "/tools/pdf-resize-pages", key: "pdf-resize-pages", limit: 10, unit: "ファイル", files: pdf2, button: "2つのPDFをまとめて変更する", zipCount: 2 },
  {
    name: "PDFメタデータ削除",
    url: "/tools/pdf-metadata-remove",
    key: "pdf-metadata-remove",
    limit: 10,
    unit: "ファイル",
    files: pdf2,
    button: "2つのPDFのメタデータをまとめて削除する",
    zipCount: 2,
  },
  { name: "PDF余白調整", url: "/tools/pdf-crop-pages", key: "pdf-crop-pages", limit: 10, unit: "ファイル", files: pdf2, button: "2つのPDFの余白をまとめて調整する", zipCount: 2 },
  {
    name: "ZIP解凍",
    url: "/tools/file-unzip",
    key: "file-unzip",
    limit: 10,
    unit: "ファイル",
    files: () => [asUpload(fixtures.zip, "first.zip"), asUpload(fixtures.zip, "second.zip")],
    button: "2つのZIPをまとめて解凍する",
    zipCount: 0,
  },
];

baseTest("一括処理の上限：指示どおりの数になっている", () => {
  const expected: Record<string, number> = {
    "pdf-to-image": 50,
    "image-crop": 50,
    "image-rotate-flip": 50,
    "image-metadata-remove": 50,
    "image-watermark": 50,
    "image-tile-split": 30,
    "image-mosaic": 30,
    "pdf-fix": 20,
    "word-to-pdf": 10,
    "excel-to-pdf": 10,
    "pdf-password-protect": 10,
    "pdf-resize-pages": 10,
    "pdf-metadata-remove": 10,
    "pdf-crop-pages": 10,
    "file-unzip": 10,
  };
  for (const [key, limit] of Object.entries(expected)) {
    expect(BATCH_LIMITS[key as keyof typeof BATCH_LIMITS], key).toBe(limit);
  }
  for (const c of CASES) expect(BATCH_LIMITS[c.key], c.name).toBe(c.limit);
});

premiumTest.describe("プレミアム：15ツールの一括処理", () => {
  for (const c of CASES) {
    premiumTest(`${c.name}：2つをまとめて処理し、ZIPで保存できる`, async ({ page }) => {
      premiumTest.setTimeout(120_000);
      await page.goto(c.url);
      await expect(page.getByTestId("batch-hint")).toContainText(`${c.limit}${c.unit}まで`);
      await upload(page, c.files());
      await expect(page.getByTestId("batch-notice")).toHaveCount(0);
      if (c.prepare) await c.prepare(page);
      await page.getByRole("button", { name: c.button }).click();
      await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 90_000 });
      // 1ファイルのときの結果画面（ポップアップ）は出さない
      await expect(page.getByTestId("result-popup")).toHaveCount(0);

      const zip = await clickAndDownload(page, "完了した2ファイルをZIPで保存");
      const { path: zipPath } = await assertDownloadedFile(zip, { format: "zip" });
      const names = zipEntries(zipPath);
      if (c.zipCount > 0) expect(names).toHaveLength(c.zipCount);
      else expect(names.length).toBeGreaterThanOrEqual(2);
      // ZIPの中にZIPを入れない（1つから複数できるツールも、中身を1つずつ入れる）
      expect(names.filter((n) => n.toLowerCase().endsWith(".zip"))).toHaveLength(0);
      expect(new Set(names).size).toBe(names.length);
    });
  }

  premiumTest("PDF→画像：PDFごとの「保存」では、そのPDFのページ画像をまとめたZIPを保存する", async ({ page }) => {
    await page.goto("/tools/pdf-to-image");
    await upload(page, pdf2());
    await page.getByRole("button", { name: "2つのPDFをまとめて画像化する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 90_000 });
    const one = page.waitForEvent("download");
    await page.getByTestId("batch-row").nth(1).getByRole("button", { name: /を保存$/ }).click();
    const download = await one;
    expect(download.suggestedFilename()).toBe("multi-page-images.zip");
    const { path: p } = await assertDownloadedFile(download, { format: "zip" });
    expect(zipEntries(p).length).toBeGreaterThanOrEqual(2);
  });

  premiumTest("画像トリミング：形（1:1）を選ぶと、形の違う画像も画像ごとに正方形で切り抜く", async ({ page }) => {
    await page.goto("/tools/image-crop");
    // sample.png は 64×64、landscape.jpg は 300×200
    await upload(page, image2());
    await expect(page.getByTestId("batch-crop-note")).toBeVisible();
    await page.getByRole("button", { name: "1:1", exact: true }).click();
    await page.getByRole("button", { name: "2枚をまとめてトリミングする" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
    await expect(page.getByTestId("batch-row").nth(0)).toContainText("64×64px");
    await expect(page.getByTestId("batch-row").nth(1)).toContainText("200×200px");
  });

  premiumTest("画像回転：設定を変えると、前の設定でまとめて処理した結果は消える", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    await upload(page, image2());
    await page.getByRole("button", { name: "2枚をまとめて回転する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
    await expect(page.getByTestId("batch-row").nth(1)).toContainText("200×300px");
    await page.getByTestId("rotate-180").click();
    await expect(page.getByTestId("batch-results")).toHaveCount(0);
  });

  premiumTest("壊れた画像が混ざっていても、ほかの画像は処理される（画像メタデータ削除）", async ({ page }) => {
    await page.goto("/tools/image-metadata-remove");
    await upload(page, [asUpload(fixtures.png), asUpload(fixtures.corruptedImage), asUpload(fixtures.landscapeJpg)]);
    await page.getByRole("button", { name: "3枚のメタデータをまとめて削除する" }).click();
    await expect(page.getByTestId("batch-summary")).toHaveText("3ファイル中 2ファイルが完了・1ファイルが失敗", { timeout: 60_000 });
    await expect(page.getByTestId("batch-row").nth(1)).toHaveAttribute("data-status", "error");
  });

  premiumTest("上限を超えて選ぶと、上限の数だけを読み込んで案内する（Word→PDF：10ファイル）", async ({ page }) => {
    await page.goto("/tools/word-to-pdf");
    const many = Array.from({ length: 11 }, (_, i) => asUpload(fixtures.wordPageBreakDocx, `doc-${i + 1}.docx`));
    await upload(page, many);
    await expect(page.getByTestId("batch-notice")).toContainText("10ファイルまで");
    await expect(page.getByTestId("batch-notice")).toContainText("超えた1ファイル");
    await expect(page.getByRole("button", { name: "10個の文書をまとめてPDFに変換する" })).toBeVisible();
  });

  premiumTest("1ファイルだけのときは、これまでどおりの結果画面になる（PDFメタデータ削除）", async ({ page }) => {
    await page.goto("/tools/pdf-metadata-remove");
    await upload(page, [asUpload(fixtures.singlePagePdf)]);
    await page.getByRole("button", { name: "メタデータを削除する", exact: true }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("batch-results")).toHaveCount(0);
  });

  premiumTest("ページを開いた後にプレミアムでなくなった場合、一括処理は始まらない（PDF余白調整）", async ({ page, baseURL }) => {
    await page.goto("/tools/pdf-crop-pages");
    await upload(page, pdf2());
    await setDevPlanOverride(page.context(), "free", baseURL!);
    await page.getByRole("button", { name: "2つのPDFの余白をまとめて調整する" }).click();
    await expect(page.getByTestId("batch-notice")).toContainText("プレミアムプランを確認できなかったため");
    await expect(page.getByTestId("batch-results")).toHaveCount(0);
  });
});

for (const plan of ["free", "standard"] as const) {
  baseTest(`${plan === "free" ? "無料" : "旧スタンダード"}：15ツールとも、2つ選ぶと1つ目だけを読み込み、プレミアムの機能だと案内する`, async ({ page, baseURL }) => {
    baseTest.setTimeout(180_000);
    await setDevPlanOverride(page.context(), plan, baseURL!);
    for (const c of CASES) {
      await page.goto(c.url);
      await expect(page.getByTestId("batch-hint"), c.name).toContainText("プレミアムプラン");
      const files = c.files();
      await upload(page, files);
      await expect(page.getByTestId("batch-notice"), c.name).toContainText("一度に処理できるのは1ファイルです");
      await expect(page.getByTestId("batch-notice"), c.name).toContainText(files[0].name);
      await expect(page.getByRole("button", { name: /まとめて/ }), c.name).toHaveCount(0);
    }
  });
}

// ---------------------------------------------------------------------------
// 追加：画像トリミングのSNSサイズにも一括処理・説明文（よくある質問）
// ---------------------------------------------------------------------------

premiumTest("画像トリミング（SNSサイズ）：形の違う画像も、画像ごとに中央を切り抜いて同じサイズにまとめて変換する", async ({ page }) => {
  await page.goto("/tools/image-crop?mode=sns");
  await expect(page.getByTestId("batch-hint")).toContainText(`${BATCH_LIMITS["image-crop"]}枚まで`);
  await upload(page, image2());
  await expect(page.getByTestId("batch-sns-note")).toBeVisible();
  await page.getByRole("button", { name: "2枚をまとめて変換する" }).click();
  await expect(page.getByTestId("batch-summary")).toHaveText("2ファイル中 2ファイルが完了", { timeout: 60_000 });
  await expect(page.getByTestId("batch-row").nth(0)).toContainText("1080×1080px");
  await expect(page.getByTestId("batch-row").nth(1)).toContainText("1080×1080px");
  const zip = await clickAndDownload(page, "完了した2ファイルをZIPで保存");
  const { path: zipPath } = await assertDownloadedFile(zip, { format: "zip" });
  expect(zipEntries(zipPath).sort()).toEqual(["landscape-sns.jpg", "sample-sns.png"]);
});

baseTest("無料：SNSサイズでも、2枚選ぶと1枚目だけを読み込む", async ({ page, baseURL }) => {
  await setDevPlanOverride(page.context(), "free", baseURL!);
  await page.goto("/tools/image-crop?mode=sns");
  await upload(page, image2());
  await expect(page.getByTestId("batch-notice")).toContainText("一度に処理できるのは1ファイルです");
  await expect(page.getByRole("button", { name: "変換する", exact: true })).toBeVisible();
});

const SEO_IDS = [
  "pdf-to-image",
  "image-crop",
  "image-rotate-flip",
  "image-rotate",
  "image-flip",
  "image-metadata-remove",
  "image-watermark",
  "image-tile-split",
  "image-mosaic",
  "pdf-fix",
  "word-to-pdf",
  "excel-to-pdf",
  "pdf-password-protect",
  "pdf-resize-pages",
  "pdf-metadata-remove",
  "pdf-crop-pages",
  "file-unzip",
];

baseTest("説明文：15ツールのよくある質問に、一括処理の質問があり、上限の数が実際と一致している", () => {
  for (const id of SEO_IDS) {
    const content = getToolSeoContent(id)!;
    const on = adaptToolSeoContentWith(content, { billing: true, ads: false, premiumOnly: false, standardOffered: false });
    const faq = on.faq.find((f) => f.question.startsWith("複数の"));
    expect(faq, id).toBeTruthy();
    expect(faq!.answer, id).toContain("プレミアムプラン");
    expect(faq!.answer, id).toMatch(/最大\d+(枚|個)/);
    const limit = Number(faq!.answer.match(/最大(\d+)/)![1]);
    expect(Object.values(BATCH_LIMITS), id).toContain(limit);
  }
});

baseTest("説明文：課金オフの間は、一括処理の質問からプレミアムの話がなくなる", () => {
  for (const id of SEO_IDS) {
    const content = getToolSeoContent(id)!;
    const off = adaptToolSeoContentWith(content, { billing: false, ads: false, premiumOnly: false, standardOffered: false });
    const faq = off.faq.find((f) => f.question.startsWith("複数の"));
    expect(faq, id).toBeTruthy();
    expect(faq!.answer, id).not.toContain("プレミアム");
    expect(faq!.answer, id).not.toContain("無料プラン");
  }
});

baseTest("説明文：使い方の「ファイルを選ぶ」手順に、まとめて選べる数が書いてあり、課金オフではプランの話がなくなる", () => {
  for (const id of SEO_IDS) {
    const content = getToolSeoContent(id)!;
    const on = adaptToolSeoContentWith(content, { billing: true, ads: false, premiumOnly: false, standardOffered: false });
    const step = on.howTo.find((s) => s.includes("まとめて選べ"));
    expect(step, id).toBeTruthy();
    expect(step!, id).toContain("プレミアムプラン");
    expect(step!, id).not.toContain("1ファイル・");
    const limit = Number(step!.match(/最大(\d+)/)![1]);
    expect(Object.values(BATCH_LIMITS), id).toContain(limit);

    const off = adaptToolSeoContentWith(content, { billing: false, ads: false, premiumOnly: false, standardOffered: false });
    const offStep = off.howTo.find((s) => s.includes("まとめて選べ"));
    expect(offStep, id).toBeTruthy();
    expect(offStep!, id).not.toContain("プレミアム");
  }
});
