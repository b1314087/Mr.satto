import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clearDevOverrides } from "../helpers/dev-plan";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { clickWhenReady, uploadWhenReady } from "../helpers/tool-ready";
import { inspectOutputPdf, writeSequentialPdf, type OutputPdfInfo } from "../helpers/pdf-page-quality";
import { siteConfig } from "@/lib/config/site";
import { getListedTools, getMergedTools, getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { PDF_EDIT_MODES, PDF_EDIT_TOOL_ID } from "@/lib/tools/pdf-edit-modes";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import sitemap from "@/app/sitemap";

/**
 * PDF編集の総合ツール化のテスト。
 *  - 前半: ツール登録・一覧・検索・関連ツール・sitemap・SEO（旧URLの維持）
 *  - 後半: 画面（旧URLごとの初期操作・操作の切り替え・PDFの引き継ぎ・古い結果の無効化・結合/回転の出力・広告ゲート）
 * 分割・削除・抽出・並び替えの出力内容の細かい検証は、既存の
 * pdf-page-ops-quality.spec.ts / pdf-page-ops-shared.spec.ts（旧URLで開く＝総合画面で動く）を再利用する。
 */

const OLD_IDS = PDF_EDIT_MODES.map((m) => m.toolId);

// ---------------------------------------------------------------------------
// 1. 登録・一覧・検索・関連ツール・sitemap・SEO
// ---------------------------------------------------------------------------
plainTest.describe("PDF編集: ツール登録と一覧・検索・SEO", () => {
  plainTest("総合ツールpdf-editが登録され、旧6ツールは統合済みとして対応表と一致する", () => {
    const hub = getToolById(PDF_EDIT_TOOL_ID);
    plainExpect(hub?.status).toBe("available");
    plainExpect(hub?.category).toBe("pdf");
    plainExpect(hub?.requiredPlan).toBe("standard");
    plainExpect(hub?.processor).toBe("browser");
    plainExpect(hub?.mergedInto).toBeUndefined();
    plainExpect(OLD_IDS.length).toBe(6);
    plainExpect(getMergedTools(PDF_EDIT_TOOL_ID).map((t) => t.id).sort()).toEqual([...OLD_IDS].sort());
    for (const id of OLD_IDS) {
      const t = getToolById(id);
      plainExpect(t?.status, id).toBe("available");
      plainExpect(t?.category, id).toBe("pdf");
      plainExpect(t?.requiredPlan, id).toBe("standard");
    }
  });

  plainTest("ツール一覧の対象から旧6ツールが外れ、総合ツールだけが並ぶ（他のPDFツールは残る）", () => {
    const ids = new Set(getListedTools().map((t) => t.id));
    plainExpect(ids.has(PDF_EDIT_TOOL_ID)).toBe(true);
    for (const id of OLD_IDS) plainExpect(ids.has(id), `${id}が一覧に残っている`).toBe(false);
    for (const id of ["pdf-compress", "pdf-to-text", "image-to-pdf", "pdf-add-page-numbers"]) {
      plainExpect(ids.has(id), `${id}が一覧から消えている`).toBe(true);
    }
    // 統合済み以外のツールは1つも減っていない（画像ツールなど、他の統合済みツールも一覧からは外れている）
    plainExpect(getListedTools().length).toBe(tools.filter((t) => !t.mergedInto).length);
    plainExpect(tools.filter((t) => t.mergedInto === PDF_EDIT_TOOL_ID).length).toBe(OLD_IDS.length);
  });

  const queries = ["PDF結合", "PDF分割", "ページ削除", "ページ抽出", "並び替え", "並べ替え", "回転", "merge", "split", "PDF編集"];
  for (const q of queries) {
    plainTest(`検索「${q}」: 総合ツールが見つかり、旧ツールのカードは重複して出ない`, () => {
      const result = searchTools(getListedTools(), q);
      plainExpect(result.some((t) => t.id === PDF_EDIT_TOOL_ID), "総合ツールがヒットしない").toBe(true);
      plainExpect(result.filter((t) => OLD_IDS.includes(t.id)).map((t) => t.id)).toEqual([]);
    });
  }

  plainTest("関連ツールのカードに、統合済みの旧ツールは出ない（旧ページ・総合ページとも）", () => {
    for (const id of [PDF_EDIT_TOOL_ID, ...OLD_IDS]) {
      const tool = getToolById(id)!;
      const { related } = getRelatedTools(tool);
      plainExpect(related.filter((t) => OLD_IDS.includes(t.id)).map((t) => t.id), `${id}の関連ツール`).toEqual([]);
    }
    // 他のPDFツールの関連ツールに、総合ツールは出うる（旧ツールの代わり）
    const compress = getRelatedTools(getToolById("pdf-compress")!).related;
    plainExpect(compress.filter((t) => OLD_IDS.includes(t.id))).toEqual([]);
  });

  plainTest("旧6ツールの個別URL・SEO文・sitemapは維持され、総合ツールもsitemap・SEO文を持つ", () => {
    const urls = new Set(sitemap().map((e) => e.url));
    for (const id of [PDF_EDIT_TOOL_ID, ...OLD_IDS]) {
      plainExpect(AVAILABLE_TOOL_IDS.includes(id), `${id}が利用可能ツールに無い`).toBe(true);
      plainExpect(urls.has(`${siteConfig.url}/tools/${id}`), `${id}がsitemapに無い`).toBe(true);
      const seo = toolSeoContent[id];
      plainExpect(seo?.metaTitle, `${id}のメタタイトル`).toBeTruthy();
      plainExpect(seo?.metaDescription, `${id}のメタ説明`).toBeTruthy();
      plainExpect(seo.howTo.length, `${id}の使い方`).toBeGreaterThan(0);
      plainExpect(seo.faq.length, `${id}のFAQ`).toBeGreaterThan(0);
    }
    // 旧ツールのタイトル・説明は変えていない
    plainExpect(toolSeoContent["pdf-merge"].metaTitle).toBe("PDF結合｜複数のPDFファイルを1つにまとめる");
    plainExpect(toolSeoContent["pdf-split"].metaTitle).toBe("PDF分割｜ページ単位でファイルを分ける");
    plainExpect(toolSeoContent["pdf-delete-pages"].metaTitle).toBe("PDFページ削除｜不要なページだけを取り除く");
    plainExpect(toolSeoContent["pdf-reorder-pages"].metaTitle).toBe("PDFページ並び替え｜ページの順序をドラッグで変更");
    plainExpect(toolSeoContent["pdf-rotate"].metaTitle).toBe("PDF回転｜ページの向きをまとめて回転");
    plainExpect(toolSeoContent["pdf-extract-pages"].metaTitle).toBe("PDFページ抽出｜必要なページだけを取り出す");
  });

  plainTest("各操作の対応表: 操作・ツールID・名前が重複せず、旧ツール名と一致する", () => {
    plainExpect(new Set(PDF_EDIT_MODES.map((m) => m.mode)).size).toBe(6);
    plainExpect(new Set(PDF_EDIT_MODES.map((m) => m.toolId)).size).toBe(6);
    for (const m of PDF_EDIT_MODES) plainExpect(getToolById(m.toolId)?.name, m.toolId).toBe(m.pageName);
  });
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------
let workDir = "";
plainTest.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfedit-"));
});
plainTest.afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
const workPath = (name: string) => path.join(workDir, name);

const modeButton = (page: Page, mode: string) => page.getByTestId(`pdf-edit-mode-${mode}`);
const downloadButton = (page: Page) => page.getByRole("button", { name: /ダウンロード/ });

async function downloadPdf(page: Page, name: string): Promise<OutputPdfInfo> {
  const download = await clickAndDownload(page, /^ダウンロード$/);
  const saved = workPath(name);
  await download.saveAs(saved);
  await assertDownloadedFile(download, { format: "pdf", minBytes: 100 });
  return inspectOutputPdf(saved);
}

/**
 * 開発サーバー(Turbopack)は、操作画面の部品を初めて読み込むときに、一瞬だけ読み込みに失敗することがある
 * （本番ビルドでは起きない。tests/helpers/tool-ready.ts のコメント参照）。操作を切り替えるテストでは、
 * 切り替え後に再読み込みすると選んだPDFが消えて検証できなくなるため、先に各操作の画面を1度ずつ開いて読み込んでおく。
 */
async function warmUp(page: Page, ids: string[] = OLD_IDS) {
  for (const id of ids) {
    await page.goto(`/tools/${id}`);
    const input = page.locator('input[type="file"]').first();
    if (!(await input.waitFor({ state: "attached", timeout: 20_000 }).then(() => true).catch(() => false))) {
      await page.reload();
      await expect(input).toBeAttached({ timeout: 30_000 });
    }
  }
}

/** 操作を切り替え、切り替え先の画面（ファイルを選ぶ欄）が表示されるまで待つ */
async function switchMode(page: Page, mode: string) {
  await clickWhenReady(modeButton(page, mode));
  await expect(modeButton(page, mode)).toHaveAttribute("aria-pressed", "true");
  const dropzoneLabel = mode === "merge" ? "PDFをドラッグ&ドロップ（複数可）" : "PDFをドラッグ&ドロップ";
  await expect(page.getByText(dropzoneLabel, { exact: true })).toBeVisible({ timeout: 25_000 });
}

async function openHub(page: Page, slug: string = PDF_EDIT_TOOL_ID) {
  await page.goto(`/tools/${slug}`);
  await expect(page.getByTestId("pdf-edit-modes")).toBeVisible({ timeout: 25_000 });
}

test.describe("PDF編集: 一覧・カテゴリ・旧URL", () => {
  test("ツール一覧に「PDF編集」だけが出て、旧ツールは独立したカードとして並ばない", async ({ page }) => {
    await page.goto("/tools?category=pdf");
    const main = page.locator("main");
    await expect(main.locator('a[href="/tools/pdf-edit"]')).toHaveCount(1);
    for (const id of OLD_IDS) await expect(main.locator(`a[href="/tools/${id}"]`), `${id}のカード`).toHaveCount(0);
    // 同じカテゴリの他のツールは今までどおり並ぶ
    await expect(main.locator('a[href="/tools/pdf-compress"]')).toHaveCount(1);
  });

  test("ツール一覧の検索「PDF結合」で、PDF編集だけが候補に出る", async ({ page }) => {
    await page.goto("/tools?q=PDF%E7%B5%90%E5%90%88");
    const main = page.locator("main");
    await expect(main.locator('a[href="/tools/pdf-edit"]')).toHaveCount(1);
    await expect(main.locator('a[href="/tools/pdf-merge"]')).toHaveCount(0);
  });

  test("PDFカテゴリのページにも、PDF編集だけが出て旧ツールのカードは出ない", async ({ page }) => {
    await page.goto("/tools/pdf");
    const main = page.locator("main");
    await expect(main.locator('a[href="/tools/pdf-edit"]')).toHaveCount(1);
    for (const id of OLD_IDS) await expect(main.locator(`a[href="/tools/${id}"]`), `${id}のカード`).toHaveCount(0);
  });

  for (const m of PDF_EDIT_MODES) {
    test(`旧URL /tools/${m.toolId}: 同じ名前の見出し・自分自身のcanonicalのまま、「${m.label}」が選ばれた総合画面で開く`, async ({ page }) => {
      await openHub(page, m.toolId);
      await expect(page.locator("h1")).toHaveText(m.pageName);
      await expect(modeButton(page, m.mode)).toHaveAttribute("aria-pressed", "true");
      for (const other of PDF_EDIT_MODES.filter((o) => o.mode !== m.mode)) {
        await expect(modeButton(page, other.mode)).toHaveAttribute("aria-pressed", "false");
      }
      await expect(page.getByTestId("pdf-edit-mode-description")).toHaveText(m.description);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toMatch(new RegExp(`/tools/${m.toolId}$`));
      expect(await page.title()).toContain(toolSeoContent[m.toolId].metaTitle);
    });
  }

  test("総合ページ /tools/pdf-edit: 見出し・canonical・6つの専用ページへのリンクがある", async ({ page }) => {
    await openHub(page);
    await expect(page.locator("h1")).toHaveText("PDF編集");
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(/\/tools\/pdf-edit$/);
    const nav = page.getByRole("navigation", { name: "同じ画面で使える各ページ" });
    for (const id of OLD_IDS) await expect(nav.locator(`a[href="/tools/${id}"]`), id).toHaveCount(1);
  });

  test("旧URLのページからは、総合ツールと他の操作の専用ページへリンクされ、自分自身へのリンクは出ない", async ({ page }) => {
    await openHub(page, "pdf-split");
    const nav = page.getByRole("navigation", { name: "同じ画面で使える各ページ" });
    await expect(nav.locator('a[href="/tools/pdf-edit"]')).toHaveCount(1);
    await expect(nav.locator('a[href="/tools/pdf-split"]')).toHaveCount(0);
    await expect(nav.locator('a[href="/tools/pdf-merge"]')).toHaveCount(1);
  });
});

test.describe("PDF編集: 操作の切り替えと古い結果の無効化", () => {
  test("PDFを選んだまま操作を切り替えられ、切り替えると前の結果は消え、各操作の出力が正しい", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 4);
    await warmUp(page);
    await openHub(page);

    // 分割 → ページ削除へ切り替えても、選んだPDFはそのまま使える
    await switchMode(page, "delete");
    await uploadWhenReady(page, input, page.getByText(/削除するページを選択/), { readyTimeoutMs: 25_000 });
    await switchMode(page, "split");
    await expect(page.getByText("このPDFは4ページです")).toBeVisible();
    await switchMode(page, "delete");
    await expect(page.getByText(/削除するページを選択/)).toBeVisible();

    // ページ削除（2ページ目）→ 結果を出す
    await clickWhenReady(page.getByRole("button", { name: /^2$/ }));
    await clickWhenReady(page.getByRole("button", { name: "1ページを削除する", exact: true }), {
      expectAfter: page.getByText("削除が完了しました"),
    });
    expect((await downloadPdf(page, "deleted.pdf")).originalOrder).toEqual([1, 3, 4]);

    // 回転へ切り替え → 前の結果（削除）はダウンロードできない。PDFは引き継がれる
    await switchMode(page, "rotate");
    await expect(page.getByText("削除が完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "回転する" })).toBeVisible();

    // 90°で回転 → 180°へ変更すると古い結果は消え、再実行すると180°の結果になる
    await clickWhenReady(page.getByRole("button", { name: "回転する" }), { expectAfter: page.getByText("回転が完了しました") });
    await expect(downloadButton(page)).toBeVisible();
    await clickWhenReady(page.getByRole("button", { name: "180°" }));
    await expect(page.getByText("回転が完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);
    await clickWhenReady(page.getByRole("button", { name: "回転する" }), { expectAfter: page.getByText("回転が完了しました") });
    const rotated = await downloadPdf(page, "rotated.pdf");
    expect(rotated.originalOrder).toEqual([1, 2, 3, 4]);
    expect(rotated.pages.map((p) => p.rotation)).toEqual([180, 180, 180, 180]);

    // ページ抽出へ切り替え → 同じPDFで、指定順に抽出できる
    await switchMode(page, "extract");
    const field = page.getByPlaceholder("例: 1,3,5-7");
    await expect(field).toBeVisible();
    await field.fill("4,1");
    await clickWhenReady(page.getByRole("button", { name: "ページを抽出する" }), { expectAfter: page.getByText("抽出が完了しました") });
    expect((await downloadPdf(page, "extracted.pdf")).originalOrder).toEqual([4, 1]);

    // 並び替えへ切り替え → 同じPDFを並び替える
    await switchMode(page, "reorder");
    await clickWhenReady(page.getByRole("button", { name: "4番目を上へ移動", exact: true }));
    await clickWhenReady(page.getByRole("button", { name: "並び替えを適用する" }), { expectAfter: page.getByText("並び替えが完了しました") });
    expect((await downloadPdf(page, "reordered.pdf")).originalOrder).toEqual([1, 2, 4, 3]);
  });

  test("結合: 複数PDFを並べた順に結合でき、順序・ファイル構成を変えると古い結果は消える。結合は他の操作とPDFを共有しない", async ({ page }) => {
    const a = workPath("a.pdf");
    const b = workPath("b.pdf");
    await writeSequentialPdf(a, 2);
    await writeSequentialPdf(b, 3);
    await warmUp(page, ["pdf-merge", "pdf-split"]);
    await openHub(page);

    const runButton = page.getByRole("button", { name: /件のPDFを結合する$/ });
    await uploadWhenReady(page, [a, b], runButton, { readyTimeoutMs: 25_000 });
    await clickWhenReady(runButton, { expectAfter: page.getByText("結合が完了しました") });
    expect((await downloadPdf(page, "merged1.pdf")).originalOrder).toEqual([1, 2, 1, 2, 3]);

    // 順序を入れ替える → 古い結果は消える。再実行すると新しい順序で出力される
    await clickWhenReady(page.getByRole("button", { name: "a.pdf を下へ移動" }));
    await expect(page.getByText("結合が完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);
    await clickWhenReady(runButton, { expectAfter: page.getByText("結合が完了しました") });
    expect((await downloadPdf(page, "merged2.pdf")).originalOrder).toEqual([1, 2, 3, 1, 2]);

    // ファイルを外す → 結合ボタンが出なくなり、古い結果も消える
    await clickWhenReady(page.getByRole("button", { name: "b.pdf を削除" }));
    await expect(downloadButton(page)).toHaveCount(0);
    await expect(page.getByText("結合が完了しました")).toHaveCount(0);

    // 結合 → 分割へ切り替え: 結合で選んだPDFは引き継がれない（分割は自分でPDFを選ぶ）
    await switchMode(page, "split");
    await expect(page.getByText("このPDFは")).toHaveCount(0);
  });

  test("壊れたファイルを選ぶと、操作を切り替えても安全にエラー表示され、結果は出ない", async ({ page }) => {
    const bad = workPath("broken.pdf");
    fs.writeFileSync(bad, "this is not a pdf");
    await openHub(page, "pdf-delete-pages");
    await uploadWhenReady(page, bad, page.getByRole("alert").filter({ hasText: "読み込みに失敗しました" }), { readyTimeoutMs: 25_000 });
    await switchMode(page, "rotate");
    await clickWhenReady(page.getByRole("button", { name: "回転する" }), {
      expectAfter: page.getByRole("alert").filter({ hasText: "読み込みに失敗しました" }),
    });
    await expect(downloadButton(page)).toHaveCount(0);
  });

  test("処理はブラウザ内で完結し、PDFの中身が自社API・外部APIへ送信されない（結合・回転）", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    await warmUp(page, ["pdf-merge", "pdf-rotate"]);
    await openHub(page);
    const runButton = page.getByRole("button", { name: /件のPDFを結合する$/ });
    await uploadWhenReady(page, [fixtures.singlePagePdf, fixtures.multiPagePdf], runButton, { readyTimeoutMs: 25_000 });
    await clickWhenReady(runButton, { expectAfter: page.getByText("結合が完了しました") });
    await switchMode(page, "rotate");
    await uploadWhenReady(page, fixtures.multiPagePdf, page.getByRole("button", { name: "回転する" }), { readyTimeoutMs: 25_000 });
    await clickWhenReady(page.getByRole("button", { name: "回転する" }), { expectAfter: page.getByText("回転が完了しました") });

    const origin = new URL(baseURL!).origin;
    const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
    const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
    expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
    expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. 広告ゲート・プラン（Free）
// ---------------------------------------------------------------------------
plainTest.describe("PDF編集: 広告ゲート（Freeプラン）", () => {
  plainTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  for (const slug of [PDF_EDIT_TOOL_ID, "pdf-rotate"]) {
    plainTest(`/tools/${slug}: 広告なしで開け、ダウンロード時に広告確認画面が出る（従来どおり）`, async ({ page }) => {
      await page.goto("/tools/pdf-rotate");
      await plainExpect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
      await page.goto(`/tools/${slug}`);
      await plainExpect(page.getByTestId("pdf-edit-modes")).toBeVisible({ timeout: 25_000 });
      await plainExpect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
      await plainExpect(
        page.getByText("無料でご利用いただけます。ダウンロードの際に広告を1回ご覧いただくと、1時間は広告なしでご利用いただけます。")
      ).toBeVisible();

      await page.getByTestId("pdf-edit-mode-rotate").click();
      await uploadWhenReady(page, fixtures.multiPagePdf, page.getByRole("button", { name: "回転する" }), { readyTimeoutMs: 25_000 });
      await page.getByRole("button", { name: "回転する" }).click();
      await plainExpect(page.getByText("回転が完了しました")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "ダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    });
  }
});

