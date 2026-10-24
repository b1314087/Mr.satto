import fs from "node:fs";
import { test as premiumTest, expect } from "../fixtures/premium-test";
import { test as baseTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { clearDevOverrides } from "../helpers/dev-plan";
import { waitForSuccess, clickAndDownload, assertDownloadedFile, uploadFixture } from "../helpers/tool-runner";
import { tools } from "@/lib/tools/data";

/**
 * 画像回転・画像反転の共通画面のテスト。
 * 四隅の色が違う画像（左上=赤・右上=緑・左下=青・右下=黄、縦20×横40）を使い、
 * プレビューと、実際にダウンロードされた画像の「向き・大きさ」を、四隅の色で確かめる。
 */

type Corner = "red" | "green" | "blue" | "yellow";

/** 四隅の色が違う画像をブラウザの中で作る */
async function makeQuadrantPng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 20;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 20, 10);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(20, 0, 20, 10);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 10, 20, 10);
    ctx.fillStyle = "#ffff00";
    ctx.fillRect(20, 10, 20, 10);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  return Buffer.from(base64, "base64");
}

async function uploadQuadrant(page: Page) {
  const buffer = await makeQuadrantPng(page);
  await page.locator('input[type="file"]').first().setInputFiles({ name: "quad.png", mimeType: "image/png", buffer });
}

/** 画像（バイト列）の大きさと、四隅（左上・右上・左下・右下）の色 */
async function readCorners(page: Page, buffer: Buffer): Promise<{ width: number; height: number; corners: Corner[] }> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const classify = (x: number, y: number): string => {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (r > 200 && g < 60 && b < 60) return "red";
      if (g > 200 && r < 60 && b < 60) return "green";
      if (b > 200 && r < 60 && g < 60) return "blue";
      if (r > 200 && g > 200 && b < 60) return "yellow";
      return `other(${r},${g},${b})`;
    };
    const w = canvas.width;
    const h = canvas.height;
    const pts: [number, number][] = [
      [Math.floor(w * 0.25), Math.floor(h * 0.25)],
      [Math.floor(w * 0.75), Math.floor(h * 0.25)],
      [Math.floor(w * 0.25), Math.floor(h * 0.75)],
      [Math.floor(w * 0.75), Math.floor(h * 0.75)],
    ];
    return { width: w, height: h, corners: pts.map(([x, y]) => classify(x, y)) as never };
  }, buffer.toString("base64"));
}

/** プレビュー（キャンバス）の大きさと四隅の色 */
async function readPreviewCorners(page: Page): Promise<{ width: number; height: number; corners: Corner[] }> {
  return page.getByTestId("transform-preview-canvas").evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const classify = (x: number, y: number): string => {
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      if (r > 200 && g < 60 && b < 60) return "red";
      if (g > 200 && r < 60 && b < 60) return "green";
      if (b > 200 && r < 60 && g < 60) return "blue";
      if (r > 200 && g > 200 && b < 60) return "yellow";
      return `other(${r},${g},${b})`;
    };
    const w = canvas.width;
    const h = canvas.height;
    const pts: [number, number][] = [
      [Math.floor(w * 0.25), Math.floor(h * 0.25)],
      [Math.floor(w * 0.75), Math.floor(h * 0.25)],
      [Math.floor(w * 0.25), Math.floor(h * 0.75)],
      [Math.floor(w * 0.75), Math.floor(h * 0.75)],
    ];
    return { width: w, height: h, corners: pts.map(([x, y]) => classify(x, y)) as never };
  });
}

/** 元画像（左上=赤・右上=緑・左下=青・右下=黄、40×20）に対する、期待する結果 */
const EXPECTED = {
  "rotate-90": { width: 20, height: 40, corners: ["blue", "red", "yellow", "green"] },
  "rotate-180": { width: 40, height: 20, corners: ["yellow", "blue", "green", "red"] },
  "rotate-270": { width: 20, height: 40, corners: ["green", "yellow", "red", "blue"] },
  "flip-horizontal": { width: 40, height: 20, corners: ["green", "red", "yellow", "blue"] },
  "flip-vertical": { width: 40, height: 20, corners: ["blue", "yellow", "red", "green"] },
} as const;

async function pickOperation(page: Page, op: keyof typeof EXPECTED) {
  if (op.startsWith("flip")) {
    await page.getByTestId("transform-mode-flip").click();
    await page.getByTestId(op).click();
  } else {
    await page.getByTestId("transform-mode-rotate").click();
    await page.getByTestId(op).click();
  }
}

premiumTest.describe("画像回転・反転: 各URLの初期モード", () => {
  premiumTest("画像回転: 初期モードは回転。回転の角度が選べる", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    await expect(page.getByTestId("transform-mode-rotate")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("transform-mode-flip")).toHaveAttribute("aria-pressed", "false");
    await uploadQuadrant(page);
    for (const deg of ["rotate-90", "rotate-180", "rotate-270"]) await expect(page.getByTestId(deg)).toBeVisible();
    await expect(page.getByTestId("rotate-90")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("flip-horizontal")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "回転する" })).toBeVisible();
  });

  premiumTest("画像反転: 初期モードは反転。左右・上下が選べる", async ({ page }) => {
    await page.goto("/tools/image-flip");
    await expect(page.getByTestId("transform-mode-flip")).toHaveAttribute("aria-pressed", "true");
    await uploadQuadrant(page);
    await expect(page.getByTestId("flip-horizontal")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("flip-vertical")).toBeVisible();
    await expect(page.getByTestId("rotate-90")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "反転する" })).toBeVisible();
  });

  premiumTest("共通画面の中で、回転と反転を切り替えられる", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    await uploadQuadrant(page);
    await page.getByTestId("transform-mode-flip").click();
    await expect(page.getByTestId("flip-horizontal")).toBeVisible();
    await expect(page.getByRole("button", { name: "反転する" })).toBeVisible();
    await page.getByTestId("transform-mode-rotate").click();
    await expect(page.getByTestId("rotate-90")).toBeVisible();
  });
});

premiumTest.describe("画像回転・反転: 処理結果とプレビューの一致", () => {
  for (const op of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
    premiumTest(`${op}: プレビューも、ダウンロードした画像も、期待どおりの向き・大きさ`, async ({ page }) => {
      await page.goto(op.startsWith("flip") ? "/tools/image-flip" : "/tools/image-rotate");
      await uploadQuadrant(page);
      await pickOperation(page, op);

      const expected = EXPECTED[op];
      // プレビュー
      await expect.poll(async () => (await readPreviewCorners(page)).corners).toEqual(expected.corners);
      const preview = await readPreviewCorners(page);
      expect([preview.width, preview.height]).toEqual([expected.width, expected.height]);

      // ダウンロード
      await page.getByRole("button", { name: op.startsWith("flip") ? "反転する" : "回転する" }).click();
      await waitForSuccess(page, "完了");
      const download = await clickAndDownload(page, "ダウンロード");
      const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
      const out = await readCorners(page, fs.readFileSync(path));
      expect([out.width, out.height]).toEqual([expected.width, expected.height]);
      expect(out.corners).toEqual(expected.corners);
      // プレビューと書き出しは同じ結果
      expect(out.corners).toEqual(preview.corners);
    });
  }

  premiumTest("JPGの画像は、JPGのまま回転・反転して保存される", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    await uploadFixture(page, fixtures.landscapeJpg);
    await page.getByRole("button", { name: "回転する" }).click();
    await waitForSuccess(page, "完了");
    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toBe("landscape.jpg");
    await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
  });
});

premiumTest.describe("画像回転・反転: 古い結果が誤ってダウンロードされない", () => {
  premiumTest("角度を変えると、前の結果とダウンロードは消える", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    await uploadQuadrant(page);
    await page.getByRole("button", { name: "回転する" }).click();
    await waitForSuccess(page, "回転が完了しました");
    await expect(page.getByRole("button", { name: "ダウンロード" })).toBeVisible();
    await page.getByTestId("rotate-180").click();
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
    await expect(page.getByAltText("処理結果のプレビュー")).toHaveCount(0);
    // 選び直した設定でもう一度処理すると、その設定の結果になる
    await page.getByRole("button", { name: "回転する" }).click();
    await waitForSuccess(page, "回転が完了しました");
    const download = await clickAndDownload(page, "ダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    expect((await readCorners(page, fs.readFileSync(path))).corners).toEqual(EXPECTED["rotate-180"].corners);
  });

  premiumTest("反転の向きや、回転⇄反転のモードを変えても、前の結果は消える", async ({ page }) => {
    await page.goto("/tools/image-flip");
    await uploadQuadrant(page);
    await page.getByRole("button", { name: "反転する" }).click();
    await waitForSuccess(page, "反転が完了しました");
    await page.getByTestId("flip-vertical").click();
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
    await page.getByRole("button", { name: "反転する" }).click();
    await waitForSuccess(page, "反転が完了しました");
    await expect(page.getByRole("button", { name: "ダウンロード" })).toBeVisible();
    await page.getByTestId("transform-mode-rotate").click();
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
    await expect(page.getByText("反転が完了しました")).toHaveCount(0);
  });
});

premiumTest.describe("画像回転・反転: エラー処理とスマートフォン幅", () => {
  premiumTest("壊れた画像は、エラーが出て、ダウンロードは出ない", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    await uploadFixture(page, fixtures.corruptedImage);
    await page.getByRole("button", { name: "回転する" }).click();
    await expect(page.getByText("画像の読み込みに失敗しました").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
  });

  premiumTest("画像ではないファイルは、形式エラーで断る", async ({ page }) => {
    await page.goto("/tools/image-flip");
    await uploadFixture(page, fixtures.csv);
    await expect(page.getByText("このファイル形式には対応していません")).toBeVisible();
    await expect(page.getByRole("button", { name: "反転する" })).toHaveCount(0);
  });

  premiumTest.describe("スマートフォン幅", () => {
    premiumTest.use({ viewport: { width: 375, height: 740 } });
    premiumTest("横にはみ出さず、操作の切り替え・処理・ダウンロードができる", async ({ page }) => {
      await page.goto("/tools/image-rotate");
      await uploadQuadrant(page);
      await page.getByTestId("transform-mode-flip").click();
      await page.getByTestId("flip-vertical").click();
      await page.getByRole("button", { name: "反転する" }).click();
      await waitForSuccess(page, "反転が完了しました");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      const download = await clickAndDownload(page, "ダウンロード");
      await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    });
  });
});

baseTest.describe("画像回転・反転: 広告ゲートとプラン判定（Free）", () => {
  baseTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  for (const id of ["image-rotate", "image-flip"] as const) {
    baseTest(`${id}: Freeでも処理でき、ダウンロードの前に広告の確認画面が出る`, async ({ page }) => {
      await page.goto(`/tools/${id}`);
      await uploadFixture(page, fixtures.png);
      await page.getByRole("button", { name: id === "image-rotate" ? "回転する" : "反転する" }).click();
      await waitForSuccess(page, "完了");
      await page.getByRole("button", { name: "ダウンロード" }).click();
      await expect(page.getByTestId("download-gate-dialog")).toBeVisible();
    });
  }
});

premiumTest.describe("画像回転・反転: 既存URL・SEO・ツール登録の維持", () => {
  const PAGES = [
    { id: "image-rotate", title: "画像回転" },
    { id: "image-flip", title: "画像反転" },
  ] as const;
  for (const p of PAGES) {
    premiumTest(`${p.id}: ツール登録・タイトル・canonical・サイトマップが維持されている`, async ({ page, request }) => {
      const tool = tools.find((t) => t.id === p.id);
      expect(tool?.category).toBe("image");
      expect(tool?.status).toBe("available");
      expect(tool?.requiredPlan).toBe("standard");

      await page.goto(`/tools/${p.id}`);
      await expect(page).toHaveTitle(new RegExp(p.title));
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toMatch(new RegExp(`/tools/${p.id}$`));
      await expect(page.getByRole("heading", { level: 1 })).toContainText(tool!.name);
      const sitemap = await (await request.get("/sitemap.xml")).text();
      expect(sitemap).toContain(`/tools/${p.id}<`);
    });
  }

  premiumTest("画像回転の説明に、反転への切り替えが書かれ、実際の画面と合っている", async ({ page }) => {
    await page.goto("/tools/image-rotate");
    const body = await page.locator("main").innerText();
    expect(body).toContain("「反転」に切り替えて向きを選びます");
    // 説明どおり、同じ画面に反転のモードがある
    await expect(page.getByTestId("transform-mode-flip")).toBeVisible();
  });
});
