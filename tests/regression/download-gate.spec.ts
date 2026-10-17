import crypto from "node:crypto";
import fs from "node:fs";
import { devices } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { setDevPlanOverride, setDevAdOutcome, clearDevOverrides } from "../helpers/dev-plan";
import type { DevAdOutcome } from "../helpers/dev-plan";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { fixtures } from "../fixtures/paths";

/**
 * ダウンロード時の広告ゲート（Phase 1-13）の回帰テスト。
 *
 * 実際のAd Manager・AdSense・Stripe・Supabaseには一切触れない。開発専用Cookie
 * （mrsatto-dev-plan-override / mrsatto-dev-ad-outcome、NODE_ENV=development限定）で
 * プランと広告の結果（疑似広告）を切り替える。
 *
 * 【重要】ここで検証するのは「疑似広告」での動作。本物のGoogleリワード広告
 * （GPTの実際のイベント・表示・5秒視聴など）は、広告ユニットの設定後に
 * 本番またはテスト広告で手動確認する必要がある。
 */

const TEMP_COOKIE = "mrsatto_temp_access";

async function processImage(page: Page) {
  await page.goto("/tools/image-resize");
  await uploadFixture(page, fixtures.png);
  await page.getByRole("button", { name: "リサイズする" }).click();
  await waitForSuccess(page, "完了");
}

async function readTempCookie(context: BrowserContext): Promise<string | null> {
  const cookie = (await context.cookies()).find((c) => c.name === TEMP_COOKIE);
  return cookie ? cookie.value : null;
}

/** v2.<expiresAtMs>.<kind>.<signature> の種別部分 */
function tokenKind(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(".");
  return parts.length === 4 ? parts[2] : null;
}

const dialogOf = (page: Page) => page.getByTestId("download-gate-dialog");

test.describe("Free: ダウンロード時の広告ゲート", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("ツールを開いただけでは広告を要求せず、ダウンロード時に広告を見る案内が出る", async ({ page }) => {
    await page.goto("/tools/image-resize");

    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByTestId("download-ad-notice")).toBeVisible();
    await expect(dialogOf(page)).toHaveCount(0);
    // 入口の広告ボタンは無い
    await expect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
  });

  test("利用権がない場合、ダウンロードで広告確認画面が出て、キャンセルしても処理済みファイルは残る", async ({ page }) => {
    let downloads = 0;
    page.on("download", () => downloads++);
    await processImage(page);

    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
    await expect(dialogOf(page).getByText("ダウンロードの前に広告をご覧ください")).toBeVisible();

    await dialogOf(page).getByRole("button", { name: "キャンセル" }).click();
    await expect(dialogOf(page)).toHaveCount(0);
    expect(downloads).toBe(0);

    // 処理結果は失われておらず、もう一度ダウンロード操作ができる
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
  });

  test("報酬付与後に1時間の利用権(種別: 広告視聴)が付与され、広告後もファイルが失われずダウンロードできる", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "granted", baseURL!);
    await processImage(page);

    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    await expect(dialogOf(page).getByText(/広告の視聴が完了しました/)).toBeVisible();

    // 広告視聴による付与として記録されている（代替付与ではない）
    expect(tokenKind(await readTempCookie(context))).toBe("ad");

    // 広告の後、ユーザー自身のクリックで保存される（保留していたBlobが失われていない）
    const downloadPromise = page.waitForEvent("download");
    await dialogOf(page).getByRole("button", { name: /ダウンロードする/ }).click();
    const download = await downloadPromise;
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    await expect(dialogOf(page)).toHaveCount(0);

    // 有効期間中は、再びダウンロードしても広告確認は出ない
    const second = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(second, { format: "png", minBytes: 10 });
    await expect(dialogOf(page)).toHaveCount(0);

    // 他のツールでも、広告なしで最後までダウンロードできる
    await page.goto("/tools/csv-format");
    await page.locator("textarea").first().fill(fs.readFileSync(fixtures.csv, "utf8"));
    await page.getByRole("button", { name: "整形する" }).click();
    await waitForSuccess(page, "完了");
    const csvDownload = await clickAndDownload(page, "CSVとしてダウンロード");
    await assertDownloadedFile(csvDownload, { minBytes: 1 });
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(page.getByText(/無料利用中：あと(\d+時間(\d+分)?|\d+分)/)).toBeVisible();
  });

  test("二重クリック・二重イベントでも、利用権付与は1回・ダウンロードも1回だけ", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "granted-twice", baseURL!);
    let downloads = 0;
    page.on("download", () => downloads++);
    const serverActionPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.headers()["next-action"]) serverActionPosts.push(request.url());
    });

    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();

    // 「広告を見てダウンロード」を同じ瞬間に2回押す
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[data-testid="download-gate-dialog"] button')).find((b) =>
        b.textContent?.includes("広告を見てダウンロード")
      ) as HTMLButtonElement;
      button.click();
      button.click();
    });
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    expect(serverActionPosts.length, "利用権の付与(Server Action)が1回だけであること").toBe(1);

    // 「ダウンロードする」も同じ瞬間に2回押す
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[data-testid="download-gate-dialog"] button')).find((b) =>
        b.textContent?.includes("ダウンロードする")
      ) as HTMLButtonElement;
      button.click();
      button.click();
    });
    await page.waitForTimeout(1500);
    expect(downloads, "ダウンロードが1回だけであること").toBe(1);
  });

  test("広告を途中で閉じた(報酬イベントなし)場合は利用権が付与されず、再試行できる。代替付与もされない", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "denied", baseURL!);
    let downloads = 0;
    page.on("download", () => downloads++);
    await processImage(page);

    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "denied", { timeout: 15_000 });
    await expect(dialogOf(page).getByText(/広告を最後まで視聴できなかったため、利用権は付与されませんでした/)).toBeVisible();
    expect(await readTempCookie(context), "利用権(Cookie)が付与されていないこと").toBeNull();
    expect(downloads).toBe(0);

    // 今度は最後まで視聴できた場合に、同じ画面から付与される（処理済みファイルは残っている）
    await setDevAdOutcome(context, "granted", baseURL!);
    await dialogOf(page).getByRole("button", { name: "もう一度試す" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    expect(tokenKind(await readTempCookie(context))).toBe("ad");
  });

  for (const outcome of ["unavailable", "sdk-failed", "timeout", "display-failed"] as const satisfies DevAdOutcome[]) {
    test(`広告が配信されない(${outcome})場合、代替の1時間の利用権(種別: 代替付与)が付与され、その旨が伝わる`, async ({
      page,
      context,
      baseURL,
    }) => {
      await setDevAdOutcome(context, outcome, baseURL!);
      await processImage(page);

      await page.getByRole("button", { name: "ダウンロード" }).click();
      await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
      await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });

      // 広告を表示できなかったことが利用者に分かる。広告を視聴したとは表示しない
      await expect(dialogOf(page).getByText(/広告を表示できませんでした/)).toBeVisible();
      await expect(dialogOf(page).getByText(/広告の視聴が完了しました/)).toHaveCount(0);

      // 内部では「代替付与」として区別されている（広告視聴("ad")とは別）
      expect(tokenKind(await readTempCookie(context))).toBe("fallback");

      const downloadPromise = page.waitForEvent("download");
      await dialogOf(page).getByRole("button", { name: /ダウンロードする/ }).click();
      await assertDownloadedFile(await downloadPromise, { format: "png", minBytes: 10 });
    });
  }

  test("広告ユニット未設定(not-configured)の場合は、代替付与も広告視聴扱いもされない", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "not-configured", baseURL!);
    let downloads = 0;
    page.on("download", () => downloads++);
    await processImage(page);

    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unavailable", { timeout: 15_000 });
    expect(await readTempCookie(context)).toBeNull();
    expect(downloads).toBe(0);
  });

  test("利用権の期限が切れた後は、再び広告確認が表示される", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "granted", baseURL!);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    await dialogOf(page).getByRole("button", { name: "閉じる" }).click();

    // 利用権を期限切れの状態にして、ページを開き直す
    await context.addCookies([
      { name: TEMP_COOKIE, value: `v2.${Date.now() - 60_000}.ad.expired`, url: baseURL! },
    ]);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
  });

  test("個別の保存経路: 保存を保留している間、Blobへの参照が保持されたままキャンセルできる", async ({ page }) => {
    // キャンセルで操作が破棄され、二重にダウンロードされないこと
    let downloads = 0;
    page.on("download", () => downloads++);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await page.keyboard.press("Escape");
    await expect(dialogOf(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
  });
});

test.describe("Standard / Premium: 広告なしでダウンロードできる", () => {
  for (const plan of ["standard", "premium"] as const) {
    test(`${plan}では広告確認が出ず、すぐにダウンロードできる`, async ({ page, context, baseURL }) => {
      await setDevPlanOverride(context, plan, baseURL!);
      await processImage(page);

      await expect(page.getByTestId("download-ad-notice")).toHaveCount(0);
      const download = await clickAndDownload(page, "ダウンロード");
      await assertDownloadedFile(download, { format: "png", minBytes: 10 });
      await expect(dialogOf(page)).toHaveCount(0);
      expect(await readTempCookie(context), "有料会員に利用権(Cookie)は付与されない").toBeNull();
    });
  }
});

test.describe("利用権トークン: 旧形式(v1)との互換と署名の検証", () => {
  const secret = process.env.TEMP_ACCESS_SECRET;
  test.skip(!secret, "TEMP_ACCESS_SECRET（テスト用ダミー値）をテストと開発サーバーの両方に設定した場合のみ実行");

  const sign = (payload: string) => crypto.createHmac("sha256", secret!).update(payload).digest("base64url");

  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("旧形式(v1)の有効なトークンは引き続き有効で、広告なしでダウンロードできる", async ({ page, context, baseURL }) => {
    const exp = Date.now() + 30 * 60_000;
    await context.addCookies([{ name: TEMP_COOKIE, value: `v1.${exp}.${sign(`v1.${exp}`)}`, url: baseURL! }]);
    await processImage(page);

    await expect(page.getByText(/無料利用中：あと/)).toBeVisible();
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    await expect(dialogOf(page)).toHaveCount(0);
  });

  test("v2(代替付与)の有効なトークンもサーバーに受け入れられ、広告なしでダウンロードできる", async ({
    page,
    context,
    baseURL,
  }) => {
    const exp = Date.now() + 30 * 60_000;
    await context.addCookies([
      { name: TEMP_COOKIE, value: `v2.${exp}.fallback.${sign(`v2.${exp}.fallback`)}`, url: baseURL! },
    ]);
    await processImage(page);

    await expect(page.getByText(/無料利用中：あと/)).toBeVisible();
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  });

  test("種別(kind)を書き換えたトークンは、サーバーが無効と判定する", async ({ page, context, baseURL }) => {
    const exp = Date.now() + 30 * 60_000;
    // 「ad」で署名されたトークンの種別だけを「fallback」へ書き換えた偽造
    await context.addCookies([
      { name: TEMP_COOKIE, value: `v2.${exp}.fallback.${sign(`v2.${exp}.ad`)}`, url: baseURL! },
    ]);
    await page.goto("/tools/image-resize");
    await expect(page.getByTestId("download-ad-notice")).toBeVisible();
    await expect(page.getByText(/無料利用中：あと/)).toHaveCount(0);
  });

  test("期限切れのv1トークンは無効で、再び広告確認が表示される", async ({ page, context, baseURL }) => {
    const exp = Date.now() - 60_000;
    await context.addCookies([{ name: TEMP_COOKIE, value: `v1.${exp}.${sign(`v1.${exp}`)}`, url: baseURL! }]);
    await processImage(page);

    await expect(page.getByText(/無料利用中：あと/)).toHaveCount(0);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
  });
});

test.describe("記入済みPDF→Excel: 共通のダウンロード広告ゲートの対象外", () => {
  test("Freeでも共通の広告案内・確認画面は出ない（独自の利用制限のまま）", async ({ page, context }) => {
    await clearDevOverrides(context);
    await page.goto("/tools/filled-pdf-to-excel");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByTestId("download-ad-notice")).toHaveCount(0);
    await expect(dialogOf(page)).toHaveCount(0);
  });
});

test.describe("プライバシー: 広告ゲートを通ってもファイル内容はサーバー・外部へ送られない", () => {
  test("代替付与を含む一連の流れの間、入力内容が自社API・外部へ送信されず、通信は利用権の発行のみ", async ({
    page,
    context,
    baseURL,
  }) => {
    await clearDevOverrides(context);
    await setDevAdOutcome(context, "unavailable", baseURL!);
    const recorder = new NetworkRecorder(page);

    const marker = "テスト商品A";
    const csvContent = fs.readFileSync(fixtures.csv, "utf8");
    expect(csvContent).toContain(marker);

    await page.goto("/tools/csv-format");
    await page.locator("textarea").first().fill(csvContent);
    await page.getByRole("button", { name: "整形する" }).click();
    await waitForSuccess(page, "完了");

    await page.getByRole("button", { name: "CSVとしてダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    const downloadPromise = page.waitForEvent("download");
    await dialogOf(page).getByRole("button", { name: /ダウンロードする/ }).click();
    await downloadPromise;

    const origin = new URL(baseURL!).origin;
    const leaked = findLeakedRequests(recorder, marker).filter((r) => !r.url.startsWith(origin) || r.method !== "GET");
    expect(leaked, `入力内容の漏えいが疑われるリクエスト: ${JSON.stringify(leaked)}`).toEqual([]);
    expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);

    // Server Action（利用権の発行）へ送られるのは短い文字列のみ（ファイル内容・Blobではない）
    // （next dev が開発中だけ使う内部エンドポイント /__nextjs_* は、本番には存在しないため対象外）
    const posts = recorder.requests.filter(
      (r) => r.method === "POST" && r.url.startsWith(origin) && !new URL(r.url).pathname.startsWith("/__nextjs_")
    );
    expect(posts.length, "利用権の発行(Server Action)のPOSTが行われていること").toBeGreaterThan(0);
    for (const post of posts) {
      expect(post.bodySize, `POSTボディが大きすぎます: ${post.url}`).toBeLessThan(512);
    }
  });
});

test.describe("スマートフォン表示（Chromiumのモバイルエミュレーション）", () => {
  // describe内ではブラウザの種類(defaultBrowserType)を変える設定を使えないため、
  // 端末の画面・タッチ関連の設定だけを取り出して使う。
  const { defaultBrowserType: _ignored, ...pixel7 } = devices["Pixel 7"];
  void _ignored;
  test.use(pixel7);

  test("広告確認画面が画面内に収まり、操作して保存できる", async ({ page, context, baseURL }) => {
    await clearDevOverrides(context);
    await setDevAdOutcome(context, "granted", baseURL!);
    await processImage(page);

    await page.getByRole("button", { name: "ダウンロード" }).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);

    await dialog.getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialog).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /ダウンロードする/ }).click();
    await assertDownloadedFile(await downloadPromise, { format: "png", minBytes: 10 });
  });
});
