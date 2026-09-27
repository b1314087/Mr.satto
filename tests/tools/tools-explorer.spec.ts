import { test, expect } from "@playwright/test";
import { NetworkRecorder, findLeakedRequests } from "../helpers/network-guard";
import { tools } from "@/lib/tools/data";

/**
 * ツール一覧ページ（/tools）の検索・カテゴリ絞り込みE2E（Phase 19）。
 *
 * 開発指示書Phase 19 4〜10章の要件を検証する:
 *   - 検索（ツール名・説明・カテゴリを対象、複数語のAND検索）
 *   - カテゴリ絞り込み（Registryが唯一の情報源）
 *   - 検索とカテゴリの組み合わせ
 *   - 0件時のメッセージ表示
 *   - 件数表示の動的更新
 *   - 絞り込み解除
 *   - Coming Soonツールが検索結果・一覧で実装済みツールと混同されないこと
 *
 * このページはクライアント側の状態（React state + URLクエリの同期）のみで
 * 完結しており、ファイルアップロードを伴わないため、既存のuploadFixture系
 * ヘルパーではなく、テキスト入力→表示内容の確認という流れで検証する。
 *
 * 注意: グローバルヘッダーにも同じaria-label（"ツールを検索"）を持つ
 * 小さな検索ボックス（HeaderSearch）が常時存在するため、strict modeの
 * 誤爆を避けるべく、このページ本体（<main>）の中に限定してロケートする。
 */

test("一覧ページが表示され、件数がRegistry上の実装済みツール数と一致する", async ({ page }) => {
  const expectedAvailable = tools.filter((t) => t.status === "available").length;
  const expectedComingSoon = tools.filter((t) => t.status === "coming-soon").length;

  await page.goto("/tools");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "ツール一覧" })).toBeVisible();

  await expect(main.getByText(`${expectedAvailable}件のツール`, { exact: true })).toBeVisible();
  // 絞り込みなしの初期表示では、準備中のツールも（別セクションとして）全件表示される
  await expect(
    main.getByRole("heading", { name: `準備中のツール（${expectedComingSoon}件）` })
  ).toBeVisible();
});

test("キーワード検索: 単一語（PDF）で絞り込める", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("PDF");

  await expect(main.getByRole("heading", { name: "PDF結合" })).toBeVisible();
  const countText = await main.getByText(/件のツール$/).first().innerText();
  expect(Number(countText.replace("件のツール", ""))).toBeGreaterThan(0);
});

test("キーワード検索: 複数語（画像 圧縮）でAND検索できる", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("画像 圧縮");

  // 「画像圧縮」はどちらの語も名前に含むため必ずヒットする
  await expect(main.getByRole("heading", { name: "画像圧縮", exact: true })).toBeVisible();

  // 単語ごとの一致ではなく「両方」を満たすツールのみに絞られていること
  // （動画圧縮は「圧縮」は満たすが「画像」は満たさないため出ない）
  await expect(main.getByRole("heading", { name: "動画圧縮", exact: true })).toHaveCount(0);
});

test("キーワード検索: カテゴリ名（学生）でそのカテゴリのツールがヒットする", async ({ page }) => {
  // ポモドーロタイマーの説明・キーワードには「学生」という文字列自体は含まれないため、
  // カテゴリ表示名（学生向け）が検索対象に含まれていることの直接的な回帰テスト。
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("学生");

  await expect(main.getByRole("heading", { name: "ポモドーロタイマー" })).toBeVisible();
});

test("カテゴリ絞り込み: カテゴリボタンでそのカテゴリのツールのみになる", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("button", { name: "動画", exact: true }).click();

  await expect(main.getByRole("heading", { name: "動画圧縮" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "PDF結合" })).toHaveCount(0);
});

test("検索とカテゴリ絞り込みを組み合わせられる", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("button", { name: "動画", exact: true }).click();
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("圧縮");

  await expect(main.getByRole("heading", { name: "動画圧縮" })).toBeVisible();
  // 画像カテゴリの「画像圧縮」は、動画カテゴリに絞っているため出ない
  await expect(main.getByRole("heading", { name: "画像圧縮", exact: true })).toHaveCount(0);
});

test("該当なしの場合は明示的なメッセージが表示される", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("該当しないはずのキーワードxyz123");

  await expect(main.getByText("該当するツールが見つかりませんでした")).toBeVisible();
});

test("絞り込みを解除ボタンで検索語・カテゴリの両方がクリアされる", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  const totalCountText = await main.getByText(/件のツール$/).first().innerText();
  const totalCount = Number(totalCountText.replace("件のツール", ""));

  await main.getByRole("button", { name: "動画", exact: true }).click();
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("圧縮");

  const clearButton = main.getByRole("button", { name: "絞り込みを解除" });
  await expect(clearButton).toBeVisible();
  await clearButton.click();

  await expect(main.getByRole("searchbox", { name: "ツールを検索" })).toHaveValue("");
  await expect(main.getByRole("button", { name: "絞り込みを解除" })).toHaveCount(0);

  const countTextAfter = await main.getByText(/件のツール$/).first().innerText();
  expect(Number(countTextAfter.replace("件のツール", ""))).toBe(totalCount);
});

test("絞り込み前は「絞り込みを解除」ボタンが表示されない", async ({ page }) => {
  await page.goto("/tools");
  await expect(page.locator("main").getByRole("button", { name: "絞り込みを解除" })).toHaveCount(0);
});

test("準備中(Coming Soon)ツールは実装済みツールと別セクションに分けて表示される", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");
  // pdf-password-protect は準備中のPDFツール（他に一致するツールがない語で検索する）
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("パスワード保護");

  await expect(main.getByRole("heading", { name: "準備中のツール（1件）" })).toBeVisible();
  await expect(main.getByText("準備中").first()).toBeVisible();
  // メインの件数表示（実装済みツール数）は0のまま
  await expect(main.getByText("0件のツール", { exact: true })).toBeVisible();
});

test("Coming Soonカードのアクセシブルな名前が実装済みツールと明確に区別される", async ({ page }) => {
  // Phase 19 10章: 実装済みツールと同じクリック体験にしない。
  // カード自体のaria-labelで「準備中・まだ利用できません」であることが
  // スクリーンリーダー利用者にも伝わることを確認する。
  await page.goto("/tools");
  const main = page.locator("main");
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("パスワード保護");

  const comingSoonLink = main.getByRole("link", { name: "PDFパスワード保護（準備中・まだ利用できません）" });
  await expect(comingSoonLink).toBeVisible();
});

test("料金区分バッジ: 実装済みツールカードにスタンダード/プレミアムが表示される", async ({ page }) => {
  await page.goto("/tools");
  const main = page.locator("main");

  // image-resize は requiredPlan: "standard"
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("画像リサイズ");
  const standardCard = main.getByRole("link", { name: "画像リサイズ" });
  await expect(standardCard.getByText("スタンダード", { exact: true })).toBeVisible();

  // ocr は requiredPlan: "premium"
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill("OCR");
  const premiumCard = main.getByRole("link", { name: "OCR" });
  await expect(premiumCard.getByText("プレミアム", { exact: true })).toBeVisible();
});

test("検索キーワードが外部ドメイン（Analytics等）へ送信されない", async ({ page, baseURL }) => {
  // Phase 19 30章: 検索・カテゴリ機能を追加しても、入力内容を外部へ送信しない。
  // 同一オリジンへのNext.js自体のナビゲーション用リクエスト（/tools?q=...等）は
  // URLバー自体に既に表示されている情報であり対象外とし、
  // 「検索語が外部（クロスオリジン）のリクエストに含まれていないこと」だけを確認する
  // （Phase 14の privacy-network.spec.ts と同じ findLeakedRequests を再利用）。
  await page.goto("/tools");
  const main = page.locator("main");
  const recorder = new NetworkRecorder(page);

  const needle = "ヒミツノケンサクキーワードXYZ12345";
  await main.getByRole("searchbox", { name: "ツールを検索" }).fill(needle);

  const leaked = findLeakedRequests(recorder, needle).filter((r) => !r.url.startsWith(baseURL!));
  expect(leaked, JSON.stringify(leaked)).toEqual([]);
});
