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
  await page.goto("/tools/image-compress?mode=resize");
  await uploadFixture(page, fixtures.png);
  await page.getByRole("button", { name: "リサイズする" }).click();
  await waitForSuccess(page, "完了");
}

async function readTempCookie(context: BrowserContext): Promise<string | null> {
  const cookie = (await context.cookies()).find((c) => c.name === TEMP_COOKIE);
  return cookie ? cookie.value : null;
}

const dialogOf = (page: Page) => page.getByTestId("download-gate-dialog");

test.describe("Free: ダウンロード時の広告ゲート", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("ツールを開いただけでは広告を要求せず、ダウンロード時に広告を見る案内が出る", async ({ page }) => {
    await page.goto("/tools/image-compress?mode=resize");

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

  test("2026-11 毎回広告：広告を見ると、そのダウンロードだけができ、次のダウンロードではまた広告確認が出る（時間制の利用権は残らない）", async ({
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
    await expect(dialogOf(page).getByText(/1時間/)).toHaveCount(0);

    // 時間制の利用権（Cookie）は発行しない
    expect(await readTempCookie(context)).toBeNull();

    // 広告の後、ユーザー自身のクリックで保存される（保留していたBlobが失われていない）
    const downloadPromise = page.waitForEvent("download");
    await dialogOf(page).getByRole("button", { name: /ダウンロードする/ }).click();
    const download = await downloadPromise;
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    await expect(dialogOf(page)).toHaveCount(0);

    // 次のダウンロードでは、また広告確認が出る（同じ操作の続きとみなす数秒を過ぎたあと）
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
    await expect(page.getByText(/無料利用中：あと/)).toHaveCount(0);
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
    expect(await readTempCookie(context), "毎回広告では利用権(Cookie)を残さない").toBeNull();
  });

  for (const outcome of ["unavailable", "sdk-failed", "timeout", "display-failed"] as const satisfies DevAdOutcome[]) {
    test(`広告が配信されない(${outcome})場合、今回は広告なしでダウンロードでき、その旨が伝わる`, async ({
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

      // 毎回広告では、時間制の利用権（Cookie）は残さない
      expect(await readTempCookie(context)).toBeNull();

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

  test("2026-11 毎回広告：以前の時間制の有効なトークン(v1)が残っていても使わず、広告確認が出る", async ({ page, context, baseURL }) => {
    const exp = Date.now() + 30 * 60_000;
    await context.addCookies([{ name: TEMP_COOKIE, value: `v1.${exp}.${sign(`v1.${exp}`)}`, url: baseURL! }]);
    await processImage(page);

    await expect(page.getByText(/無料利用中：あと/)).toHaveCount(0);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
  });

  test("2026-11 毎回広告：以前の時間制の有効なトークン(v2)が残っていても使わず、広告確認が出る", async ({
    page,
    context,
    baseURL,
  }) => {
    const exp = Date.now() + 30 * 60_000;
    await context.addCookies([
      { name: TEMP_COOKIE, value: `v2.${exp}.fallback.${sign(`v2.${exp}.fallback`)}`, url: baseURL! },
    ]);
    await processImage(page);

    await expect(page.getByText(/無料利用中：あと/)).toHaveCount(0);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "prompt");
  });

  test("種別(kind)を書き換えたトークンは、サーバーが無効と判定する", async ({ page, context, baseURL }) => {
    const exp = Date.now() + 30 * 60_000;
    // 「ad」で署名されたトークンの種別だけを「fallback」へ書き換えた偽造
    await context.addCookies([
      { name: TEMP_COOKIE, value: `v2.${exp}.fallback.${sign(`v2.${exp}.ad`)}`, url: baseURL! },
    ]);
    await page.goto("/tools/image-compress?mode=resize");
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

test.describe("2026-11 広告が出ないときの救済（1日1回）", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("救済は1日1回：2回目は広告なしで保存させず、広告の再読み込みを案内する（処理済みファイルは残る）", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "sdk-failed", baseURL!);
    let downloads = 0;
    page.on("download", () => downloads++);
    await processImage(page);

    // 1回目：救済で保存できる
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    await expect(dialogOf(page).getByText(/1日1回までです/)).toBeVisible();
    await dialogOf(page).getByRole("button", { name: /ダウンロードする/ }).click();
    await expect.poll(() => downloads).toBe(1);
    // 今日使った印は、ブラウザから読めない（httpOnly）
    const mark = (await context.cookies()).find((c) => c.name === "mrsatto_ad_fallback");
    expect(mark?.httpOnly).toBe(true);

    // 2回目（数秒後）：救済は使用済み
    await page.waitForTimeout(3500);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "fallback-used", { timeout: 15_000 });
    await expect(dialogOf(page).getByText(/今日はすでに使われています/)).toBeVisible();
    await expect(dialogOf(page).getByRole("button", { name: /ダウンロードする/ })).toHaveCount(0);
    expect(downloads).toBe(1);

    // 広告が出るようになれば（広告ブロッカーを止めた等）、同じ画面から広告を見て保存できる
    await setDevAdOutcome(context, "granted", baseURL!);
    await dialogOf(page).getByRole("button", { name: "もう一度試す" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    await dialogOf(page).getByRole("button", { name: /ダウンロードする/ }).click();
    await expect.poll(() => downloads).toBe(2);
  });

  test("別のタブでも、同じ日の2回目の救済は受けられない", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "timeout", baseURL!);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });

    const other = await context.newPage();
    await processImage(other);
    await other.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(other).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(other)).toHaveAttribute("data-phase", "fallback-used", { timeout: 15_000 });
  });

  test("連打しても救済は1回分：広告の準備中はダウンロードできず、保存も1回だけ", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "display-failed", baseURL!);
    let downloads = 0;
    page.on("download", () => downloads++);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    const watch = dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" });
    await watch.click();
    await watch.click({ timeout: 1000 }).catch(() => {});
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    expect(downloads).toBe(0);
    const save = dialogOf(page).getByRole("button", { name: /ダウンロードする/ });
    await save.click();
    await save.click({ timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(800);
    expect(downloads).toBe(1);
  });

  test("救済を受けたあと保存せずに閉じても、その1回分は、このページの次のダウンロードで使える", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "unavailable", baseURL!);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    await dialogOf(page).getByRole("button", { name: "閉じる" }).click();
    await expect(dialogOf(page)).toHaveCount(0);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await assertDownloadedFile(await downloadPromise, { format: "png", minBytes: 10 });
    await expect(dialogOf(page)).toHaveCount(0);
  });

  test("広告を途中で閉じた場合は、救済の対象にしない（救済の回数も使わない）", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "denied", baseURL!);
    await processImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await dialogOf(page).getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "denied", { timeout: 15_000 });
    expect((await context.cookies()).find((c) => c.name === "mrsatto_ad_fallback")).toBeUndefined();

    // その後、広告が出ないときは、まだ救済を受けられる
    await setDevAdOutcome(context, "sdk-failed", baseURL!);
    await dialogOf(page).getByRole("button", { name: "もう一度試す" }).click();
    await expect(dialogOf(page)).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
  });
});
