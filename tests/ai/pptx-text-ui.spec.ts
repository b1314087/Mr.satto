import fs from "node:fs";
import type { Page, Route } from "@playwright/test";
import { strFromU8 } from "fflate";
import { test, expect } from "../fixtures/premium-test";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { buildPptx, picture, readParts } from "../helpers/pptx-builder";
import { PPTX_TEXT_CONSENT_VERSION } from "@/lib/ai/pptx-text";

/**
 * PowerPoint白黒反転: 「AIの判断で、きれいに反転する」のE2Eテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAIには接続しない。
 * 実際のAIが画像の文字をどこまで正確に読み取るか・消費するトークンは、このテストでは確認できない。
 */

const SLUG = "/tools/pptx-invert";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_000, remainingAiTokens: 29_999_000, periodEnd: "2026-11-30T00:00:00Z" } };

const line = (over: Record<string, unknown> = {}) => ({ image: 1, text: "直角三角形ABCにおいて", kind: "text", x: 0.1, y: 0.1, w: 0.5, h: 0.06, underline: false, bold: false, confidence: "high", ...over });
const AI_RESULT = {
  ok: true,
  mode: "pptx",
  rejected: 0,
  usage: { limitAiTokens: 30_000_000, usedAiTokens: 9_000, remainingAiTokens: 29_991_000, periodEnd: "2026-11-30T00:00:00Z" },
  lines: [line(), line({ text: "BC/AB", kind: "math", y: 0.3, w: 0.2, h: 0.1 }), line({ text: "自信のない行", y: 0.5, confidence: "low" })],
};

/** ブラウザのcanvasで、黒い文字の入った大きな画像（PNG）を作る */
async function makeDocPng(page: Page): Promise<Uint8Array> {
  const base64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1000;
    c.height = 700;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#000";
    ctx.font = "44px sans-serif";
    ctx.fillText("直角三角形ABCにおいて", 100, 110);
    ctx.fillText("BC/AB", 100, 250);
    return c.toDataURL("image/png").split(",")[1];
  });
  return new Uint8Array(Buffer.from(base64, "base64"));
}

async function open(page: Page) {
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "PowerPoint白黒反転" })).toBeVisible();
  await waitForFileInputHydrated(page);
}

/** ファイルを選び、変換ボタンが出るまで待つ（開発サーバーの画面の作り直しで選択が消えることがあるため、選び直す） */
async function pickAndConvert(page: Page, bytes: Uint8Array) {
  const run = page.getByRole("button", { name: "白黒を反転する" });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.locator('input[type="file"]').first().setInputFiles({ name: "授業資料.pptx", mimeType: PPTX_MIME, buffer: Buffer.from(bytes) });
    const shown = await run.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
    if (shown) {
      await page.waitForTimeout(1_000);
      if (await run.isVisible()) break;
    }
    await page.reload();
    await waitForFileInputHydrated(page);
  }
  await run.click();
  await expect(page.getByTestId("tool-preview")).toBeVisible({ timeout: 30_000 });
}

async function deckWithDocImage(page: Page): Promise<Uint8Array> {
  const png = await makeDocPng(page);
  return buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "doc.png", bytes: png }] }] });
}

interface Mocks {
  usage?: unknown;
  ai?: (route: Route, body: Record<string, unknown>) => Promise<void> | void;
  aiBodies: Record<string, unknown>[];
}
async function mockAi(page: Page, opts: Partial<Mocks> = {}): Promise<Mocks> {
  const mocks: Mocks = { aiBodies: [], ...opts };
  await page.route("**/api/ai/usage", (route) => route.fulfill({ json: mocks.usage ?? USAGE_OK }));
  await page.route("**/api/ai/pptx-text", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    mocks.aiBodies.push(body);
    if (mocks.ai) return mocks.ai(route, body);
    await route.fulfill({ json: AI_RESULT });
  });
  return mocks;
}

test.describe("PowerPoint白黒反転: AIの判断で、きれいに反転する", () => {
  test("変換結果の画像は、大きく見える（小さなサムネイルではない）", async ({ page }) => {
    await mockAi(page);
    await open(page);
    await pickAndConvert(page, await deckWithDocImage(page));
    const row = page.getByTestId("pptx-image-row").first();
    const items = row.getByTestId("image-compare-item");
    await expect(items).toHaveCount(2);
    for (const label of ["変換前", "変換後"]) {
      const img = row.getByAltText(label);
      await expect(img).toBeVisible();
      // 画像の元の大きさは 1000×700。ポップアップの幅いっぱいに近い大きさで見える
      await expect.poll(async () => (await img.boundingBox())?.width ?? 0).toBeGreaterThan(250);
    }
    await expect(row.getByRole("link", { name: "大きく見る" })).toHaveCount(2);
  });

  test("画像を確認して同意しないと実行できない。AIが判断した範囲で反転し、通常の変換と並べて見られ、ダウンロードできる", async ({ page }) => {
    const mocks = await mockAi(page);
    await open(page);
    await pickAndConvert(page, await deckWithDocImage(page));

    const panel = page.getByTestId("pptx-ai");
    await expect(panel).toBeVisible();
    // 文字を本物の文字に書き換える機能は、ない（AIは判断だけ）
    await expect(panel).toContainText("文字の書き換えや、画像の作り直しはしません");
    await expect(panel).not.toContainText("本物の文字");
    await expect(page.getByTestId("pptx-ai-apply")).toHaveCount(0);
    // 送る画像の確認
    await expect(page.getByTestId("pptx-ai-send-count")).toContainText("1枚");
    await expect(panel.getByAltText(/AIに送る画像/)).toHaveCount(1);
    // 同意するまで押せない
    const run = page.getByTestId("pptx-ai-run");
    await expect(run).toBeDisabled();
    expect(mocks.aiBodies).toHaveLength(0);
    await page.getByTestId("pptx-ai-consent").check();
    await expect(run).toBeEnabled();
    await run.click();

    // 送った内容: 同意の版・画像1枚（縮小したJPEG）。元のファイルそのものは送っていない
    const result = page.getByTestId("pptx-ai-result");
    await expect(result).toBeVisible({ timeout: 30_000 });
    expect(mocks.aiBodies).toHaveLength(1);
    const sent = mocks.aiBodies[0] as { consent: { accepted: boolean; version: string }; images: { mediaType: string; base64: string }[]; model: string };
    expect(sent.consent).toEqual({ accepted: true, version: PPTX_TEXT_CONSENT_VERSION });
    expect(sent.model).toBe("standard");
    expect(sent.images).toHaveLength(1);
    expect(sent.images[0].mediaType).toBe("image/jpeg");
    expect(JSON.stringify(sent)).not.toContain("授業資料");
    // 同意は実行のたびに外れる
    await expect(page.getByTestId("pptx-ai-consent")).not.toBeChecked();

    // 結果: 文字・数式の行（確度が低い行は使わない）= 2か所。通常の変換と、AIの判断ありを、大きく並べて見られる
    await expect(result).toContainText("AIの判断を使って反転しました（1枚の画像・文字の行2か所）");
    const compare = page.getByTestId("pptx-ai-compare-row");
    await expect(compare).toHaveCount(1);
    for (const label of ["通常の変換", "AIの判断あり"]) {
      const img = compare.getByAltText(label);
      await expect(img).toBeVisible();
      await expect.poll(async () => (await img.boundingBox())?.width ?? 0).toBeGreaterThan(250);
    }

    // ダウンロード: 文字のテキストボックスは増えていない（画像のまま）。AIへの追加の送信もない
    expect(mocks.aiBodies).toHaveLength(1);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "AIの判断で反転したPowerPointをダウンロード" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain("_AI判断.pptx");
    const parts = readParts(new Uint8Array(fs.readFileSync((await download.path())!)));
    expect(strFromU8(parts["ppt/slides/slide1.xml"])).not.toContain("<a:t>∠Cが直角である");
    expect(parts["ppt/media/doc.png"]).toBeTruthy();
  });

  test("AIが文字の位置を見つけられなかったときは、通常の変換と同じ結果だと知らせる", async ({ page }) => {
    await mockAi(page, { ai: (route) => route.fulfill({ json: { ...AI_RESULT, lines: [] } }) });
    await open(page);
    await pickAndConvert(page, await deckWithDocImage(page));
    await page.getByTestId("pptx-ai-consent").check();
    await page.getByTestId("pptx-ai-run").click();
    await expect(page.getByTestId("pptx-ai-result")).toContainText("通常の変換と同じ結果です", { timeout: 30_000 });
    await expect(page.getByTestId("pptx-ai-compare-row")).toHaveCount(0);
  });

  test("プレミアムでない場合は、案内と「プレミアムプランを見る」リンクを出し、実行ボタンは出さない", async ({ page }) => {
    const mocks = await mockAi(page, { usage: { available: false, reason: "not_premium" } });
    await open(page);
    await pickAndConvert(page, await deckWithDocImage(page));
    await expect(page.getByTestId("ai-unavailable")).toContainText("プレミアムプラン");
    await expect(page.getByTestId("ai-upgrade-link")).toBeVisible();
    await expect(page.getByTestId("pptx-ai-run")).toBeDisabled();
    expect(mocks.aiBodies).toHaveLength(0);
  });

  test("AIがエラーを返したときは、メッセージを表示し、結果や出力は出さない", async ({ page }) => {
    await mockAi(page, { ai: (route) => route.fulfill({ status: 502, json: { error: "ai_unknown", message: "AIとの通信で問題が起きました。通常の読み取り結果はそのまま使えます。" } }) });
    await open(page);
    await pickAndConvert(page, await deckWithDocImage(page));
    await page.getByTestId("pptx-ai-consent").check();
    await page.getByTestId("pptx-ai-run").click();
    await expect(page.getByTestId("pptx-ai-error")).toContainText("AIとの通信で問題が起きました");
    await expect(page.getByTestId("pptx-ai-result")).toHaveCount(0);
    // 通常の変換結果のダウンロードは、そのまま使える
    await expect(page.getByRole("button", { name: "PowerPointファイルをダウンロード" })).toBeVisible();
  });

  test("文字を読み取れる画像（白地に黒文字の大きな画像）がないときは、そのことを知らせる", async ({ page }) => {
    await mockAi(page);
    await open(page);
    // 画像のないpptx
    await pickAndConvert(page, buildPptx({ slides: [{ shapes: "" }] }));
    await expect(page.getByTestId("pptx-ai-none")).toBeVisible();
    await expect(page.getByTestId("pptx-ai-run")).toHaveCount(0);
  });
});
