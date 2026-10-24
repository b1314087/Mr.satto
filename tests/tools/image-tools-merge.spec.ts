import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clearDevOverrides } from "../helpers/dev-plan";
import { fixtures } from "../fixtures/paths";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { siteConfig } from "@/lib/config/site";
import { getListedTools, getMergedTools, getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import sitemap from "@/app/sitemap";

/**
 * 画像ツールの一覧統合（画像形式変換・画像回転・反転）のテスト。
 *  - 画像形式変換: image-jpg-convert / image-png-convert / image-webp-convert / image-batch-convert → image-format-convert
 *  - 画像回転・反転: image-rotate / image-flip → image-rotate-flip
 * 画面そのものの動作（変換・回転・反転・プレビュー・ZIP・古い結果の無効化）は、既存の
 * image-format-convert.spec.ts / image-rotate-flip.spec.ts（旧URLで開く＝共通画面）が検証しているため、ここでは
 * 一覧・検索・関連ツール・旧URL・SEO・広告ゲート・ローカル処理の確認に絞る。
 */

const GROUPS = [
  {
    hub: "image-format-convert",
    hubName: "画像形式変換",
    members: ["image-jpg-convert", "image-png-convert", "image-webp-convert", "image-batch-convert"],
    memberNames: ["JPG変換", "PNG変換", "WebP変換", "画像一括変換"],
    searches: ["JPG", "PNG", "WebP", "jpeg", "画像形式変換", "形式変換", "JPG変換", "PNG変換", "WebP変換", "画像一括変換", "一括変換", "透過", "zip"],
  },
  {
    hub: "image-rotate-flip",
    hubName: "画像回転・反転",
    members: ["image-rotate", "image-flip"],
    memberNames: ["画像回転", "画像反転"],
    searches: ["画像回転", "画像反転", "回転", "反転", "ミラー", "左右反転", "上下反転", "rotate", "flip", "画像回転・反転"],
  },
] as const;
const ALL_MEMBERS: string[] = GROUPS.flatMap((g) => [...g.members]);
const ALL_HUBS: string[] = GROUPS.map((g) => g.hub);

// ---------------------------------------------------------------------------
// 1. 登録・一覧・検索・関連ツール・sitemap・SEO
// ---------------------------------------------------------------------------
plainTest.describe("画像ツールの統合: 登録と一覧・検索・SEO", () => {
  for (const g of GROUPS) {
    plainTest(`${g.hubName}: 総合ツールが登録され、旧ツール${g.members.length}件が統合済みになっている`, () => {
      const hub = getToolById(g.hub);
      plainExpect(hub?.name).toBe(g.hubName);
      plainExpect(hub?.status).toBe("available");
      plainExpect(hub?.category).toBe("image");
      plainExpect(hub?.requiredPlan).toBe("standard");
      plainExpect(hub?.processor).toBe("browser");
      plainExpect(hub?.mergedInto).toBeUndefined();
      plainExpect(getMergedTools(g.hub).map((t) => t.id).sort()).toEqual([...g.members].sort());
      g.members.forEach((id, i) => {
        const t = getToolById(id);
        plainExpect(t?.name, id).toBe(g.memberNames[i]);
        plainExpect(t?.status, id).toBe("available");
        plainExpect(t?.requiredPlan, id).toBe("standard");
      });
    });

    for (const q of g.searches) {
      plainTest(`${g.hubName}: 検索「${q}」で総合ツールが見つかり、旧ツールは重複して出ない`, () => {
        const result = searchTools(getListedTools(), q);
        plainExpect(result.some((t) => t.id === g.hub), `${g.hub}がヒットしない`).toBe(true);
        plainExpect(result.filter((t) => t.mergedInto).map((t) => t.id)).toEqual([]);
      });
    }
  }

  plainTest("ツール一覧の対象: 画像の総合ツール2件だけが並び、旧6件は外れ、他の画像ツールは減っていない", () => {
    const ids = new Set(getListedTools().map((t) => t.id));
    for (const h of ALL_HUBS) plainExpect(ids.has(h), `${h}が一覧に無い`).toBe(true);
    for (const m of ALL_MEMBERS) plainExpect(ids.has(m), `${m}が一覧に残っている`).toBe(false);
    for (const id of ["image-resize", "image-compress", "image-compress-to-size", "image-crop", "image-sns-size", "pdf-to-image", "image-to-pdf"]) {
      plainExpect(ids.has(id), `${id}が一覧から消えている`).toBe(true);
    }
    plainExpect(getListedTools().length).toBe(tools.filter((t) => !t.mergedInto).length);
  });

  plainTest("関連ツールのカードに、統合済みの旧ツールは出ない（総合ページ・旧ページとも）", () => {
    for (const id of [...ALL_HUBS, ...ALL_MEMBERS, "image-resize", "image-crop"]) {
      const { related } = getRelatedTools(getToolById(id)!);
      plainExpect(related.filter((t) => t.mergedInto).map((t) => t.id), `${id}の関連ツール`).toEqual([]);
    }
  });

  plainTest("旧6ツールと総合2ツールの個別URL・SEO文・sitemapが維持され、旧ツールのタイトルは変わっていない", () => {
    const urls = new Set(sitemap().map((e) => e.url));
    for (const id of [...ALL_HUBS, ...ALL_MEMBERS]) {
      plainExpect(AVAILABLE_TOOL_IDS.includes(id), `${id}が利用可能ツールに無い`).toBe(true);
      plainExpect(urls.has(`${siteConfig.url}/tools/${id}`), `${id}がsitemapに無い`).toBe(true);
      const seo = toolSeoContent[id];
      plainExpect(seo?.metaTitle, `${id}のメタタイトル`).toBeTruthy();
      plainExpect(seo?.metaDescription, `${id}のメタ説明`).toBeTruthy();
      plainExpect(seo.howTo.length, `${id}の使い方`).toBeGreaterThan(0);
      plainExpect(seo.faq.length, `${id}のFAQ`).toBeGreaterThan(0);
    }
    plainExpect(toolSeoContent["image-jpg-convert"].metaTitle).toBe("JPG変換｜PNG・WebPなどの画像をJPG形式に変換");
    plainExpect(toolSeoContent["image-png-convert"].metaTitle).toBe("PNG変換｜JPG・WebPなどの画像をPNG形式に変換");
    plainExpect(toolSeoContent["image-batch-convert"].metaTitle).toBe("画像一括変換｜複数の画像をまとめてJPG・PNG・WebPに変換");
    plainExpect(toolSeoContent["image-rotate"].metaTitle).toBe("画像回転｜90度単位で回転・反転");
    plainExpect(toolSeoContent["image-flip"].metaTitle).toBe("画像反転｜写真を左右・上下にミラー反転");
  });
});

// ---------------------------------------------------------------------------
// 2. 画面: 一覧・カテゴリ・旧URL・内部リンク
// ---------------------------------------------------------------------------
const hubCard = (page: import("@playwright/test").Page, id: string) => page.locator("main").locator(`a[href="/tools/${id}"]`);

test.describe("画像ツールの統合: 一覧・カテゴリ・旧URL", () => {
  test("ツール一覧（画像）に、画像形式変換と画像回転・反転が1つずつだけ出て、旧ツールのカードは出ない", async ({ page }) => {
    await page.goto("/tools?category=image");
    for (const h of ALL_HUBS) await expect(hubCard(page, h), `${h}のカード`).toHaveCount(1);
    for (const m of ALL_MEMBERS) await expect(hubCard(page, m), `${m}のカード`).toHaveCount(0);
    await expect(hubCard(page, "image-resize")).toHaveCount(1);
    await expect(hubCard(page, "image-crop")).toHaveCount(1);
  });

  test("全ツール一覧にも、総合ツール2件だけが出る（旧ツールは出ない）", async ({ page }) => {
    await page.goto("/tools");
    for (const h of ALL_HUBS) await expect(hubCard(page, h), `${h}のカード`).toHaveCount(1);
    for (const m of ALL_MEMBERS) await expect(hubCard(page, m), `${m}のカード`).toHaveCount(0);
  });

  test("画像カテゴリのページにも、総合ツールだけが出て旧ツールのカードは出ない", async ({ page }) => {
    await page.goto("/tools/image");
    for (const h of ALL_HUBS) await expect(hubCard(page, h), `${h}のカード`).toHaveCount(1);
    for (const m of ALL_MEMBERS) await expect(hubCard(page, m), `${m}のカード`).toHaveCount(0);
  });

  for (const [q, hub] of [
    ["JPG", "image-format-convert"],
    ["WebP", "image-format-convert"],
    ["画像一括変換", "image-format-convert"],
    ["画像反転", "image-rotate-flip"],
    ["画像回転", "image-rotate-flip"],
  ] as const) {
    test(`ツール一覧の検索「${q}」: 総合ツールが出て、旧ツールは重複して出ない`, async ({ page }) => {
      await page.goto(`/tools?q=${encodeURIComponent(q)}`);
      await expect(hubCard(page, hub)).toHaveCount(1);
      for (const m of ALL_MEMBERS) await expect(hubCard(page, m), `${m}のカード`).toHaveCount(0);
    });
  }

  for (const g of GROUPS) {
    for (const id of [g.hub, ...g.members]) {
      test(`/tools/${id}: 開け、自分自身のcanonical・タイトルのまま、同じ画面の各ページへのリンクがある`, async ({ page }) => {
        await page.goto(`/tools/${id}`);
        await expect(page.locator("h1")).toHaveText(getToolById(id)!.name);
        await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
        const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
        expect(canonical).toMatch(new RegExp(`/tools/${id}$`));
        expect(await page.title()).toContain(toolSeoContent[id].metaTitle);

        const nav = page.getByRole("navigation", { name: "同じ画面で使える各ページ" });
        await expect(nav).toBeVisible();
        const expected = [g.hub, ...g.members].filter((x) => x !== id);
        for (const other of expected) await expect(nav.locator(`a[href="/tools/${other}"]`), `${other}へのリンク`).toHaveCount(1);
        await expect(nav.locator(`a[href="/tools/${id}"]`), "自分自身へのリンク").toHaveCount(0);
        expect(await nav.locator("a").count()).toBe(expected.length);
      });
    }
  }

  test("総合ツールの画面: 画像形式変換はJPGが初期選択、画像回転・反転は回転が初期選択で、実際に処理できる", async ({ page }) => {
    await page.goto("/tools/image-format-convert");
    await uploadFixture(page, fixtures.png);
    await expect(page.getByTestId("convert-format-jpg")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "1件をJPGに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await assertDownloadedFile(await clickAndDownload(page, "ダウンロード"), { format: "jpg", minBytes: 10 });

    await page.goto("/tools/image-rotate-flip");
    await uploadFixture(page, fixtures.png);
    await expect(page.getByTestId("transform-mode-rotate")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("transform-mode-flip")).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "回転する" }).click();
    await waitForSuccess(page, "回転が完了しました");
    await assertDownloadedFile(await clickAndDownload(page, "ダウンロード"), { format: "png", minBytes: 10 });
  });

  test("画像処理はブラウザ内で完結し、画像の中身が自社API・外部APIへ送信されない（総合ツール2件）", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    await page.goto("/tools/image-format-convert");
    await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg]);
    await page.getByRole("button", { name: "2件をJPGに変換する" }).click().catch(() => undefined);
    await page.getByTestId("convert-format-webp").click();
    await page.getByRole("button", { name: "2件をWebPに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");

    await page.goto("/tools/image-rotate-flip");
    await uploadFixture(page, fixtures.png);
    await page.getByTestId("transform-mode-flip").click();
    await page.getByRole("button", { name: "反転する" }).click();
    await waitForSuccess(page, "反転が完了しました");

    const origin = new URL(baseURL!).origin;
    const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
    const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
    expect(apiLeaks, `自社APIへの不審なアップロード: ${JSON.stringify(apiLeaks)}`).toEqual([]);
    expect(externalLeaks, `外部への不審なアップロード: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 広告ゲート（Freeプラン）
// ---------------------------------------------------------------------------
plainTest.describe("画像ツールの統合: 広告ゲート（Freeプラン）", () => {
  plainTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  plainTest("画像形式変換: 広告なしで開け、変換後のダウンロードで広告確認画面が出る（総合・旧URLとも）", async ({ page }) => {
    for (const id of ["image-format-convert", "image-png-convert"]) {
      await page.goto(`/tools/${id}`);
      await plainExpect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
      await plainExpect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
      await uploadFixture(page, id === "image-png-convert" ? fixtures.jpg : fixtures.png);
      await page.getByRole("button", { name: /^1件を.+に変換する$/ }).click();
      await waitForSuccess(page, "変換が完了しました");
      await page.getByRole("button", { name: "ダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    }
  });

  plainTest("画像回転・反転: 広告なしで開け、回転後のダウンロードで広告確認画面が出る（総合・旧URLとも）", async ({ page }) => {
    for (const id of ["image-rotate-flip", "image-flip"]) {
      await page.goto(`/tools/${id}`);
      await plainExpect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
      await plainExpect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
      await uploadFixture(page, fixtures.png);
      await page.getByRole("button", { name: /^(回転|反転)する$/ }).click();
      await waitForSuccess(page, "完了しました");
      await page.getByRole("button", { name: "ダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    }
  });
});
