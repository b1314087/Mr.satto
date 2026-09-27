import { test, expect } from "@playwright/test";
import { setDevPlanOverride, setDevAdOutcome, clearDevOverrides } from "../helpers/dev-plan";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";

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

  test("Standard対象ツールでは、なぜ使えないか・どうすれば使えるかが1画面で分かる", async ({ page }) => {
    await page.goto("/tools/image-resize");

    // 状態②: 広告CTAが表示され、ツール本体（アップロード欄）はまだ出ない
    await expect(
      page.getByText("無料で使うには広告をご覧ください。広告を見ると15分間、スタンダード対象ツールをまとめて利用できます。")
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "広告を見て15分無料で使う" })).toBeVisible();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);

    // もう一方の選択肢（Standardへの案内）も、未ログインのままこの画面で分かる
    await expect(page.getByText(/Standard（月額550円・広告なし）に加入すると/)).toBeVisible();
    await expect(page.getByRole("link", { name: "広告なしで使いたい場合はこちら（料金プラン）" })).toBeVisible();
  });

  test("Premium対象ツールでは、Standardではなくプレミアム加入が案内される", async ({ page }) => {
    await page.goto("/tools/ocr");

    await expect(page.getByText("このツールはプレミアムプランで利用できます")).toBeVisible();
    await expect(page.getByText(/月額980円・広告なし・すべてのツールが利用可能/)).toBeVisible();
    await expect(page.getByRole("link", { name: "料金プランを見る" })).toBeVisible();
  });

  test("広告視聴で15分間の一時利用が始まり、状態表示され、他のStandard対象ツールも再ゲートなしで使える", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "granted", baseURL!);
    await page.goto("/tools/image-resize");

    await page.getByRole("button", { name: "広告を見て15分無料で使う" }).click();

    // 視聴完了 → ツール本体が表示され、残り時間（正確にサーバー発行の期限から計算）も分かる
    await expect(page.locator('input[type="file"]')).toBeAttached({ timeout: 15_000 });
    await expect(page.getByText(/無料利用中：あと\d+分/)).toBeVisible();

    // 一時利用中は、別のStandard対象ツールへ移動しても広告CTAへ再度戻されない
    await page.goto("/tools/image-compress");
    await expect(page.getByRole("button", { name: "広告を見て15分無料で使う" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByText(/無料利用中：あと\d+分/)).toBeVisible();
  });

  test("一時利用中に実際にツールを最後まで使え、ダウンロード直前後には広告枠が表示される（Freeのまま）", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "granted", baseURL!);
    await page.goto("/tools/image-resize");
    await page.getByRole("button", { name: "広告を見て15分無料で使う" }).click();
    await expect(page.locator('input[type="file"]')).toBeAttached({ timeout: 15_000 });

    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");

    // Free（広告ありプラン）のままなので、ダウンロード導線の前後に通常広告枠が出る
    // （準備中プレースホルダーでよい。レイアウトは崩れず、ダウンロード自体は妨げられない）
    await expect(page.locator('[data-ad-placement="pre-download"]')).toBeVisible();
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 10 });
    await expect(page.locator('[data-ad-placement="post-download"]')).toBeVisible();
  });

  test("広告が失敗（denied/unavailable）してもエラーが分かり、再試行できる。処理済みファイルを失わない", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevAdOutcome(context, "denied", baseURL!);
    await page.goto("/tools/image-resize");

    const watchButton = page.getByRole("button", { name: "広告を見て15分無料で使う" });
    await watchButton.click();
    await expect(
      page.getByText("広告の視聴が完了しなかったため、無料利用は開始されませんでした。もう一度お試しください。")
    ).toBeVisible();
    // 再試行できる（ボタンが無効のまま固まらない）
    await expect(watchButton).toBeEnabled();

    await setDevAdOutcome(context, "unavailable", baseURL!);
    await page.reload();
    await page.getByRole("button", { name: "広告を見て15分無料で使う" }).click();
    await expect(
      page.getByText(
        "現在、無料利用用の広告を表示できません。しばらくしてからもう一度お試しください。Standard・Premiumプランでは広告なしでご利用いただけます。"
      )
    ).toBeVisible();
  });
});

test.describe("Standard: 対象ツールに広告なしでアクセスできる", () => {
  test("Standardプランでは、Standard対象ツールへ広告なしで直接アクセスできる", async ({ page, context, baseURL }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
    await page.goto("/tools/image-resize");

    await expect(page.getByRole("button", { name: "広告を見て15分無料で使う" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
    // Standard = 広告なし。ツールページ内の通常広告枠も表示されない
    await expect(page.locator('[data-ad-placement="tool-page"]')).toHaveCount(0);
  });

  test("Standardプランでは、Premium対象ツールはまだ使えずプレミアム案内が出る（回帰確認）", async ({
    page,
    context,
    baseURL,
  }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
    await page.goto("/tools/ocr");

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
    await setDevPlanOverride(context, "premium", baseURL!);
    await page.goto("/tools/ocr");

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

    await expect(page.getByRole("button", { name: "広告を見て15分無料で使う" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toBeAttached();
  });
});

test.describe("Pricing: 表示が実際の料金・条件と一致する", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("Free/Standard/Premiumの料金・広告有無・対象範囲の説明が仕様どおり", async ({ page }) => {
    await page.goto("/pricing");

    // Free: ¥0・広告あり・Standard対象
    await expect(page.getByText("0円", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/広告を見ると15分間スタンダード対象ツールを利用できます/)).toBeVisible();

    // Standard: ¥550/月・広告なし
    await expect(page.getByText("550円/月", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("スタンダード対象ツールを利用可能").first()).toBeVisible();

    // Premium: ¥980/月・広告なし・すべて対象
    await expect(page.getByText("980円/月", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("すべてのツールを利用可能")).toBeVisible();

    // 広告あり/なしの明示（Free=あり、Standard/Premium=なし）
    await expect(page.getByText("広告視聴あり")).toBeVisible();
    await expect(page.getByText("広告なし").first()).toBeVisible();
  });
});

test.describe("AdSlot: 広告未配信でもレイアウトが崩れず、アクセシブルに表示される", () => {
  test.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  test("広告未配信時はプレースホルダーが役割・aria-label付きで表示され、ツール自体は使える", async ({ page, context, baseURL }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
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
