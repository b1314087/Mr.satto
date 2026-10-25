import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { setDevPlanOverride, setDevAdOutcome, clearDevOverrides } from "../helpers/dev-plan";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";
import { tools } from "@/lib/tools/data";

/**
 * 現時点で「プレミアム限定」として扱われているツール。
 * src/lib/tools/data.ts の ALL_TOOLS_STANDARD スイッチが true の間（全ツールを一時的に
 * Standard扱いにしている間）は、プレミアム限定のツールが存在しないため、
 * プレミアム限定を前提とするテストはスキップする（スイッチを false に戻すと自動で再び実行される）。
 */
const premiumTool = tools.find((t) => t.status === "available" && t.requiredPlan === "premium");
const PREMIUM_SKIP_REASON = "ALL_TOOLS_STANDARD が true のため、プレミアム限定ツールが存在しない";

async function processFixtureImage(page: Page) {
  await page.goto("/tools/image-resize");
  await uploadFixture(page, fixtures.png);
  await page.getByRole("button", { name: "リサイズする" }).click();
  await waitForSuccess(page, "完了");
}

/**
 * Phase 20専用E2E回帰テスト（収益化導線・広告UX最終調整）。
 *
 * 実際のStripe/Supabase/AdSense/Ad Managerには一切触れず、Phase 11由来の
 * 開発専用Cookie（mrsatto-dev-plan-override / mrsatto-dev-ad-outcome、
 * NODE_ENV=development限定でのみ有効）だけを使い、Free/Standard/Premiumの
 * 各状態でのToolAccessGate・Rewarded Ad・Download Gate・AdSlot・Pricingの
 * 表示が開発指示書26章の要件を満たすことを確認する。
 *
 * requiredPlan: "standard" の代表として image-resize / image-compress、
 * requiredPlan: "premium" の代表として ocr を使う（Phase 19調査で確認済みの値）。
 */

test.describe("Free: Standardツールのアクセス条件表示とRewarded Ad導線", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("未ログインでもツール一覧・Pricingへアクセスでき、ログインを要求されない", async ({ page }) => {
    await page.goto("/tools");
    await expect(page.locator("main").getByRole("heading", { name: "ツール一覧" })).toBeVisible();

    await page.goto("/pricing");
    await expect(page.getByText("料金", { exact: false }).first()).toBeVisible();
    // ログインへ強制的に飛ばされていないこと
    expect(page.url()).not.toContain("/login");
  });

  test("Standard対象ツールは広告なしで開け、ダウンロード時に広告を見る案内が1画面で分かる", async ({ page }) => {
    await page.goto("/tools/image-resize");

    // ツール本体は広告なしで使える（入口の広告ボタンは無い）
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
    // ダウンロード時に広告を1回見る必要があること・1時間は広告なしになることが事前に分かる
    await expect(
      page.getByText("無料でご利用いただけます。ダウンロードの際に広告を1回ご覧いただくと、1時間は広告なしでご利用いただけます。")
    ).toBeVisible();
  });

  test("ダウンロード時の確認画面で、Premiumへの案内（料金プランへの導線）も分かる", async ({ page }) => {
    await processFixtureImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();

    const dialog = page.getByTestId("download-gate-dialog");
    await expect(dialog.getByText(/プレミアム（月額1,100円・税込）に加入すると、広告なしでご利用いただけます/)).toBeVisible();
    await expect(dialog.getByRole("link", { name: "料金プランを見る" })).toBeVisible();
  });

  test("Premium対象ツールでは、Standardではなくプレミアム加入が案内される", async ({ page }) => {
    test.skip(!premiumTool, PREMIUM_SKIP_REASON);
    await page.goto(`/tools/${premiumTool!.id}`);

    await expect(page.getByText("このツールはプレミアムプランで利用できます")).toBeVisible();
    await expect(page.getByText(/月額1,100円・広告なし・すべてのツールが利用可能/)).toBeVisible();
    await expect(page.getByRole("link", { name: "料金プランを見る" })).toBeVisible();
  });

  test("Freeは1時間の利用権があっても、Premium対象ツールを利用できない", async ({ page, context, baseURL }) => {
    test.skip(!premiumTool, PREMIUM_SKIP_REASON);
    // 先に通常のツールで広告視聴による利用権を得る
    await setDevAdOutcome(context, "granted", baseURL!);
    await processFixtureImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await page.getByTestId("download-gate-dialog").getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(page.getByTestId("download-gate-dialog")).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });

    await page.goto(`/tools/${premiumTool!.id}`);
    await expect(page.getByText("このツールはプレミアムプランで利用できます")).toBeVisible();
  });

  test("広告視聴で1時間の利用権が付与され、状態表示され、他のツールでも広告なしでダウンロードできる", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "granted", baseURL!);
    await processFixtureImage(page);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    const dialog = page.getByTestId("download-gate-dialog");
    await dialog.getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialog).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /ダウンロードする/ }).click();
    await assertDownloadedFile(await downloadPromise, { format: "png", minBytes: 10 });

    // 残り時間（サーバー発行の期限から計算）が分かる
    await expect(page.getByText(/無料利用中：あと(\d+時間(\d+分)?|\d+分)/)).toBeVisible();

    // 一時利用中は、別のツールへ移動してもダウンロード時に広告確認へ戻されない
    await page.goto("/tools/image-compress");
    await expect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByText(/無料利用中：あと(\d+時間(\d+分)?|\d+分)/)).toBeVisible();
  });

  test("ダウンロードの前後には通常の広告枠が出ない（Freeのまま）", async ({ page, context, baseURL }) => {
    await setDevAdOutcome(context, "granted", baseURL!);
    await processFixtureImage(page);

    // Free（広告ありプラン）でも、ダウンロードボタンの前後には広告枠を出さない
    // （ボタンの近くの広告は誤クリックを誘う配置としてAdSenseのポリシー違反になるおそれがあるため）。
    // リワード広告はユーザーが「広告を見る」を押した後に全画面で表示されるもので、通常の広告枠ではない。
    await expect(page.locator('[data-ad-placement="pre-download"]')).toHaveCount(0);
    await page.getByRole("button", { name: "ダウンロード" }).click();
    await expect(page.locator('[data-ad-placement="pre-download"]')).toHaveCount(0);
    await expect(page.locator('[data-ad-placement="post-download"]')).toHaveCount(0);
  });

  test("広告が失敗（denied/not-configured）してもエラーが分かり、再試行できる。処理済みファイルを失わない", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "denied", baseURL!);
    await processFixtureImage(page);

    await page.getByRole("button", { name: "ダウンロード" }).click();
    const dialog = page.getByTestId("download-gate-dialog");
    await dialog.getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(
      dialog.getByText(/広告を最後まで視聴できなかったため、利用権は付与されませんでした。もう一度お試しください。/)
    ).toBeVisible();
    // 再試行できる（ボタンが無効のまま固まらない）
    await expect(dialog.getByRole("button", { name: "もう一度試す" })).toBeEnabled();

    await setDevAdOutcome(context, "not-configured", baseURL!);
    await dialog.getByRole("button", { name: "もう一度試す" }).click();
    await expect(dialog.getByText(/現在、広告を表示できません。しばらくしてからもう一度お試しください。/)).toBeVisible();
  });
});

test.describe("Standard: 対象ツールに広告なしでアクセスできる", () => {
  test("Standardプランでは、Standard対象ツールへ広告なしで直接アクセスできる", async ({ page, context, baseURL }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
    await page.goto("/tools/image-resize");

    await expect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
    // Standard = 広告なし。ツールページ内の通常広告枠も表示されない
    await expect(page.locator('[data-ad-placement="tool-page"]')).toHaveCount(0);
  });

  test("Standardプランでは、Premium対象ツールはまだ使えずプレミアム案内が出る（回帰確認）", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!premiumTool, PREMIUM_SKIP_REASON);
    await setDevPlanOverride(context, "standard", baseURL!);
    await page.goto(`/tools/${premiumTool!.id}`);

    await expect(page.getByText("このツールはプレミアムプランで利用できます")).toBeVisible();
  });

  test("Standardプランでダウンロードまで完了しても、ダウンロード周りに広告枠が出ない", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
    await page.goto("/tools/image-resize");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");

    await expect(page.locator('[data-ad-placement="pre-download"]')).toHaveCount(0);
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    await expect(page.locator('[data-ad-placement="post-download"]')).toHaveCount(0);
  });
});

test.describe("Premium: Premium対象ツールに広告なしでアクセスできる", () => {
  test("Premiumプランでは、Premium対象ツールへ広告なしで直接アクセスできる", async ({ page, context, baseURL }) => {
    test.skip(!premiumTool, PREMIUM_SKIP_REASON);
    await setDevPlanOverride(context, "premium", baseURL!);
    await page.goto(`/tools/${premiumTool!.id}`);

    await expect(page.getByText("このツールはプレミアムプランで利用できます")).toHaveCount(0);
    await expect(page.locator('[data-ad-placement="tool-page"]')).toHaveCount(0);
  });

  test("Premiumプランでは、Standard対象ツールにも引き続き広告なしでアクセスできる", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevPlanOverride(context, "premium", baseURL!);
    await page.goto("/tools/image-resize");

    await expect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});

test.describe("Pricing: 表示が実際の料金・条件と一致する", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("Free/Premiumの料金・広告有無・対象範囲の説明が仕様どおり（Standardは出ない）", async ({ page }) => {
    await page.goto("/pricing");

    // Free: ¥0・広告あり・通常ツール
    await expect(page.getByText("0円", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/広告を見ると1時間、通常ツールを利用できます/)).toBeVisible();
    if (premiumTool) {
      // プレミアム限定のツールが実在する間は、無料は「通常ツール」、プレミアムは「すべてのツール」と書き分ける
      await expect(page.getByText("通常ツールを利用可能").first()).toBeVisible();
    } else {
      // 全ツールが標準扱いの間は、どちらのプランも同じ表示にし、実在しない「通常ツールのみ」の制限を示さない
      await expect(page.getByText("通常ツールを利用可能")).toHaveCount(0);
      await expect(page.getByText("すべてのツールを利用可能")).toHaveCount(2);
      await expect(page.getByText("プレミアム対象ツール")).toHaveCount(0);
    }

    // Premium: ¥1,100/月・広告なし・すべて対象・AI読み取り補助
    await expect(page.getByText("1,100円/月", { exact: false }).first()).toBeVisible();
    if (premiumTool) await expect(page.getByText("すべてのツールを利用可能")).toBeVisible();
    await expect(page.getByText(/「AIで読み取る」補助/)).toBeVisible();

    // 広告あり/なしの明示（Free=あり、Premium=なし）
    await expect(page.getByText("広告視聴あり")).toBeVisible();
    await expect(page.getByText("広告なし").first()).toBeVisible();

    // 旧プランは新規のプランとして出ない
    await expect(page.getByText(/スタンダード|550円/)).toHaveCount(0);
  });
});

test.describe("AdSlot: 広告未配信でもレイアウトが崩れず、アクセシブルに表示される", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("広告未配信時はプレースホルダーが役割・aria-label付きで表示され、ツール自体は使える", async ({ page }) => {
    // Freeユーザー（未ログイン・override無し）の状態で確認する。
    // Standard/Premiumではフッター広告自体が非表示になる仕様のため
    // （下の「Standard/Premiumではフッター広告が表示されない」テスト参照）、
    // 「広告枠が表示されている状態でのプレースホルダー表示」を確認するこの
    // テストはFreeで行う。
    await page.goto("/tools/image-resize");

    // フッター広告は準備中プレースホルダーとして、役割とラベルを持って表示される
    const footerAd = page.locator('[data-ad-placement="footer"]');
    await expect(footerAd).toBeVisible();
    await expect(footerAd).toHaveAttribute("role", "complementary");
    await expect(footerAd).toHaveAttribute("aria-label", "フッター広告");
    await expect(footerAd).toContainText("準備中");

    // 広告が未配信でも、ツール本体の操作（アップロード欄）は問題なく使える
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});

test.describe("フッター広告: 広告なしプランには表示されない(Phase 23で修正)", () => {
  // Phase 20時点ではフッターに広告なしプランの判定が一切接続されておらず、
  // Standard/Premiumユーザーにも常にフッター広告が表示され続けていた
  // （Phase 23監査で発見）。src/components/layout/footer-ad-slot.tsx が
  // クライアント側で開発専用Cookie（本番では無効）または実際のSupabase契約状態を
  // 見て判定する。ここでは開発専用CookieでFree/Standard/Premiumを切り替えて検証する。
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("Freeではフッター広告(プレースホルダー)が表示される", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await expect(page.locator('[data-ad-placement="footer"]')).toBeVisible();
  });

  test("Standardではフッター広告が表示されない", async ({ page, context, baseURL }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
    await page.goto("/tools/image-resize");
    await expect(page.locator('[data-ad-placement="footer"]')).toBeHidden();
  });

  test("Premiumではフッター広告が表示されない", async ({ page, context, baseURL }) => {
    await setDevPlanOverride(context, "premium", baseURL!);
    await page.goto("/tools/image-resize");
    await expect(page.locator('[data-ad-placement="footer"]')).toBeHidden();
  });
});
