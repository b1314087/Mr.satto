import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clearDevOverrides } from "../helpers/dev-plan";
import { fixtures } from "../fixtures/paths";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { uploadFixture as rawUpload, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import type { Page } from "@playwright/test";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { siteConfig } from "@/lib/config/site";
import { getListedTools, getMergedTools, getToolById, getFeaturedTools, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import { EXCEL_CSV_MODES, EXCEL_CSV_TOOL_ID } from "@/lib/tools/excel-csv-modes";
import sitemap from "@/app/sitemap";

/**
 * Excel・CSV変換の総合ツール化（excel-csv-convert）のテスト。
 *  - Excel→CSV: excel-to-csv / CSV→Excel: csv-to-excel → excel-csv-convert に統合（個別URLは維持）
 * 両方向の基本のダウンロードは既存の csv-excel.spec.ts が旧URLで検証している。ここでは
 * 登録・一覧・検索・旧URL・SEO・切り替え・変換内容（複数シート・日付・特殊文字・往復）・エラー・
 * 広告ゲート・ローカル処理を確認する。
 */

const HUB = EXCEL_CSV_TOOL_ID;
const MEMBERS = ["excel-to-csv", "csv-to-excel"];
const MEMBER_NAMES = ["Excel→CSV", "CSV→Excel"];
const SEARCHES = [
  "Excel",
  "CSV",
  "Excel CSV",
  "CSV Excel",
  "エクセル CSV変換",
  "CSVをExcelに変換",
  "ExcelをCSVに変換",
  "Excel・CSV変換",
  "csv→excel",
  "excel→csv",
  "xlsx",
  "エクセル",
];

/** ファイル入力欄の準備（hydration）が終わってから選択する（準備前の選択は無視されることがあるため） */
async function uploadFixture(page: Page, files: string | string[]) {
  await waitForFileInputHydrated(page);
  await rawUpload(page, files);
}

/** 向きを切り替える。画面の準備（hydration）前のクリックは無視されることがあるため、押された状態になるまで確認する */
async function switchMode(page: Page, mode: string) {
  await waitForFileInputHydrated(page);
  await expect(async () => {
    await page.getByTestId(`excel-csv-mode-${mode}`).click();
    await expect(page.getByTestId(`excel-csv-mode-${mode}`)).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

// 注意: 日本語名の出力ファイル名のテストは、OSのロケールがUTF-8でない環境（LANG未設定のLinuxなど）では
// Chromiumが名前を "download" に置き換えるため失敗する。実行時は LANG=C.UTF-8 を付ける。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "excel-csv-"));
function tmpFile(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// 1. 登録・検索・関連・おすすめ・sitemap・SEO（ブラウザ不要）
// ---------------------------------------------------------------------------
plainTest.describe("Excel・CSV変換の統合: 登録と一覧・検索・SEO", () => {
  plainTest("総合ツールが登録され、旧2ツールが統合済みになっている", () => {
    const hub = getToolById(HUB);
    plainExpect(hub?.name).toBe("Excel・CSV変換");
    plainExpect(hub?.status).toBe("available");
    plainExpect(hub?.category).toBe("csv-excel");
    plainExpect(hub?.requiredPlan).toBe("standard");
    plainExpect(hub?.processor).toBe("browser");
    plainExpect(hub?.mergedInto).toBeUndefined();
    plainExpect(getMergedTools(HUB).map((t) => t.id).sort()).toEqual([...MEMBERS].sort());
    MEMBERS.forEach((id, i) => {
      const t = getToolById(id);
      plainExpect(t?.name, id).toBe(MEMBER_NAMES[i]);
      plainExpect(t?.status, id).toBe("available");
      plainExpect(t?.requiredPlan, id).toBe("standard");
    });
    // 画面の切り替え定義と登録が一致している
    plainExpect(EXCEL_CSV_MODES.map((m) => m.toolId).sort()).toEqual([...MEMBERS].sort());
  });

  for (const q of SEARCHES) {
    plainTest(`検索「${q}」で総合ツールが見つかり、旧ツールは重複して出ない`, () => {
      const result = searchTools(getListedTools(), q);
      plainExpect(result.some((t) => t.id === HUB), `${HUB}がヒットしない`).toBe(true);
      plainExpect(result.filter((t) => t.mergedInto).map((t) => t.id)).toEqual([]);
    });
  }

  plainTest("検索「CSV」「Excel」: 他のCSV・Excelツールのヒットは従来どおり残る", () => {
    const csv = searchTools(getListedTools(), "CSV").map((t) => t.id);
    for (const id of ["csv-format", "csv-merge", "csv-dedupe", "csv-replace", "csv-json-convert"]) plainExpect(csv, id).toContain(id);
    const excel = searchTools(getListedTools(), "Excel").map((t) => t.id);
    for (const id of ["excel-transpose", "excel-replace", "excel-to-pdf"]) plainExpect(excel, id).toContain(id);
  });

  plainTest("ツール一覧の対象: 総合ツール1件だけが並び、旧2件は外れ、他のCSV・Excelツールは減っていない", () => {
    const ids = new Set(getListedTools().map((t) => t.id));
    plainExpect(ids.has(HUB)).toBe(true);
    for (const m of MEMBERS) plainExpect(ids.has(m), `${m}が一覧に残っている`).toBe(false);
    for (const id of ["csv-format", "csv-merge", "csv-dedupe", "csv-replace", "csv-json-convert", "excel-transpose", "excel-replace", "excel-to-pdf", "pdf-to-excel"]) {
      plainExpect(ids.has(id), `${id}が一覧から消えている`).toBe(true);
    }
    plainExpect(getListedTools().length).toBe(tools.filter((t) => !t.mergedInto).length);
  });

  plainTest("関連ツール・おすすめに、統合済みの旧ツールは出ない", () => {
    for (const id of [HUB, ...MEMBERS, "csv-format", "csv-merge", "csv-replace", "excel-transpose"]) {
      const { related } = getRelatedTools(getToolById(id)!);
      plainExpect(related.filter((t) => t.mergedInto).map((t) => t.id), `${id}の関連ツール`).toEqual([]);
    }
    plainExpect(getFeaturedTools().filter((t) => t.mergedInto).map((t) => t.id)).toEqual([]);
  });

  plainTest("3つの個別URL・SEO文・sitemapが維持され、旧ツールのタイトルは変わっていない", () => {
    const urls = new Set(sitemap().map((e) => e.url));
    for (const id of [HUB, ...MEMBERS]) {
      plainExpect(AVAILABLE_TOOL_IDS.includes(id), `${id}が利用可能ツールに無い`).toBe(true);
      plainExpect(urls.has(`${siteConfig.url}/tools/${id}`), `${id}がsitemapに無い`).toBe(true);
      const seo = toolSeoContent[id];
      plainExpect(seo?.metaTitle, `${id}のメタタイトル`).toBeTruthy();
      plainExpect(seo?.metaDescription, `${id}のメタ説明`).toBeTruthy();
      plainExpect(seo.howTo.length, `${id}の使い方`).toBeGreaterThan(0);
      plainExpect(seo.faq.length, `${id}のFAQ`).toBeGreaterThan(0);
    }
    plainExpect(toolSeoContent["csv-to-excel"].metaTitle).toBe("CSV→Excel変換｜CSVファイルをExcel形式(.xlsx)に変換");
    plainExpect(toolSeoContent["excel-to-csv"].metaTitle).toBe("Excel→CSV変換｜ExcelファイルをCSV形式に変換");
  });

  plainTest("SEO文は実装と食い違わない: CSV→Excelは文字コードの自動判定をうたっていない", () => {
    const text = JSON.stringify(toolSeoContent["csv-to-excel"]) + JSON.stringify(toolSeoContent[HUB]);
    plainExpect(text).not.toContain("自動判定");
  });
});

// ---------------------------------------------------------------------------
// 2. 画面: 一覧・カテゴリ・旧URL・内部リンク・切り替え
// ---------------------------------------------------------------------------
const card = (page: import("@playwright/test").Page, id: string) => page.locator("main").locator(`a[href="/tools/${id}"]`);
const modeBtn = (page: import("@playwright/test").Page, mode: string) => page.getByTestId(`excel-csv-mode-${mode}`);

test.describe("Excel・CSV変換の統合: 一覧・カテゴリ・旧URL", () => {
  test("全ツール一覧・CSV/Excelカテゴリに、総合ツールが1つだけ出て、旧ツールのカードは出ない", async ({ page }) => {
    for (const url of ["/tools", "/tools?category=csv-excel", "/tools/csv-excel"]) {
      await page.goto(url);
      await expect(card(page, HUB), `${url}: 総合ツール`).toHaveCount(1);
      for (const m of MEMBERS) await expect(card(page, m), `${url}: ${m}`).toHaveCount(0);
      await expect(card(page, "csv-merge"), `${url}: CSV結合`).toHaveCount(1);
    }
  });

  for (const q of ["Excel", "CSV", "Excel CSV", "CSVをExcelに変換", "ExcelをCSVに変換", "エクセル CSV変換"]) {
    test(`ツール一覧の検索「${q}」: 総合ツールが出て、旧ツールは重複して出ない`, async ({ page }) => {
      await page.goto(`/tools?q=${encodeURIComponent(q)}`);
      await expect(card(page, HUB)).toHaveCount(1);
      for (const m of MEMBERS) await expect(card(page, m), `${m}のカード`).toHaveCount(0);
    });
  }

  const initial: Record<string, string> = { [HUB]: "excel-to-csv", "excel-to-csv": "excel-to-csv", "csv-to-excel": "csv-to-excel" };
  for (const id of [HUB, ...MEMBERS]) {
    test(`/tools/${id}: 開け、自分自身のcanonical・タイトルのまま、同じ画面の各ページへのリンクと正しい初期の向きがある`, async ({ page }) => {
      await page.goto(`/tools/${id}`);
      await expect(page.locator("h1")).toHaveText(getToolById(id)!.name);
      await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
      expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(new RegExp(`/tools/${id}$`));
      expect(await page.title()).toContain(toolSeoContent[id].metaTitle);

      // 初期の向き
      const other = initial[id] === "excel-to-csv" ? "csv-to-excel" : "excel-to-csv";
      await expect(modeBtn(page, initial[id])).toHaveAttribute("aria-pressed", "true");
      await expect(modeBtn(page, other)).toHaveAttribute("aria-pressed", "false");

      // 内部リンク
      const nav = page.getByRole("navigation", { name: "同じ画面で使える各ページ" });
      await expect(nav).toBeVisible();
      const expected = [HUB, ...MEMBERS].filter((x) => x !== id);
      for (const o of expected) await expect(nav.locator(`a[href="/tools/${o}"]`), `${o}へのリンク`).toHaveCount(1);
      await expect(nav.locator(`a[href="/tools/${id}"]`), "自分自身へのリンク").toHaveCount(0);
      expect(await nav.locator("a").count()).toBe(expected.length);
    });
  }

  test("向きを切り替えられる: 切り替えると前の向きのファイル・結果はリセットされる", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await uploadFixture(page, fixtures.xlsx);
    await expect(page.getByText("sample.xlsx").first()).toBeVisible();
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toBeVisible();

    await switchMode(page, "csv-to-excel");
    await expect(modeBtn(page, "csv-to-excel")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("sample.xlsx")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSVに変換する" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Excelに変換する" })).toHaveCount(0); // ファイルを選ぶまで出ない

    await uploadFixture(page, fixtures.csv);
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await waitForSuccess(page, "Excelへの変換が完了しました");

    await switchMode(page, "excel-to-csv");
    await expect(page.getByText("sample.csv")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Excelに変換する" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 変換内容（既存機能の維持）
// ---------------------------------------------------------------------------
test.describe("Excel・CSV変換の統合: 変換内容", () => {
  test("Excel→CSV: 複数シートは書き出すシートを選べ、ファイル名にシート名が付き、BOM付きUTF-8になる", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await uploadFixture(page, fixtures.xlsxMultiSheet);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");

    await expect(page.getByText("ダウンロードするシートを選択")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sheet1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sheet2", exact: true }).click();
    await expect(page.getByText("「Sheet2」・2行")).toBeVisible();

    const download = await clickAndDownload(page, "CSVでダウンロード");
    expect(download.suggestedFilename()).toBe("xlsx-multi-sheet-Sheet2.csv");
    const { path: p } = await assertDownloadedFile(download, { minBytes: 1 });
    const buf = fs.readFileSync(p);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.toString("utf8").replace(/^﻿/, "");
    expect(text).toContain("S2_A1");
    expect(text).toContain("S2_B2");
    expect(text).not.toContain("S1_A1");
  });

  test("Excel→CSV: 1シートのファイルはファイル名が元のファイル名.csvで、日付は年-月-日になる", async ({ page }) => {
    await page.goto("/tools/excel-to-csv");
    await uploadFixture(page, fixtures.xlsxDates);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText("ダウンロードするシートを選択")).toHaveCount(0);
    const download = await clickAndDownload(page, "CSVでダウンロード");
    expect(download.suggestedFilename()).toBe("xlsx-dates.csv");
    const { path: p } = await assertDownloadedFile(download, { minBytes: 1 });
    const text = fs.readFileSync(p, "utf8");
    expect(text).toContain("2026-10-01");
    expect(text).toContain("12345");
    expect(text).toContain("not a date");
  });

  test("CSV→Excel: 日本語・カンマ・引用符・セル内改行・空行を含むCSVが、内容どおりのExcelになる", async ({ page }) => {
    const csv = tmpFile("special.csv", '名前,メモ\n"山田, 太郎","1行目\n2行目 ""引用"""\n\n鈴木,通常\n');
    await page.goto("/tools/csv-to-excel");
    await uploadFixture(page, csv);
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await waitForSuccess(page, "Excelへの変換が完了しました");
    const download = await clickAndDownload(page, "ダウンロード");
    expect(download.suggestedFilename()).toBe("special.xlsx");
    const { path: p } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
    const { headers, rows } = await readXlsxSheet(p);
    expect(headers).toEqual(["名前", "メモ"]);
    expect(rows).toEqual([
      ["山田, 太郎", '1行目\n2行目 "引用"'],
      ["鈴木", "通常"],
    ]);
  });

  test("日本語のファイル名: 出力ファイル名は元の名前を引き継ぐ（両方向）", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await waitForFileInputHydrated(page);
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "売上データ.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: fs.readFileSync(fixtures.xlsx),
    });
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    expect((await clickAndDownload(page, "CSVでダウンロード")).suggestedFilename()).toBe("売上データ.csv");

    await switchMode(page, "csv-to-excel");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "売上データ.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("品名,数量\nりんご,3\n", "utf8"),
    });
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await waitForSuccess(page, "Excelへの変換が完了しました");
    expect((await clickAndDownload(page, "ダウンロード")).suggestedFilename()).toBe("売上データ.xlsx");
  });

  test("往復: CSV→Excelで作ったExcelを、同じ画面でExcel→CSVに戻すと、元のCSVの内容に戻る", async ({ page }) => {
    const original = "id,name,note\n1,テスト商品A,\"a,b\"\n2,テスト商品B,\"x\"\"y\"\n";
    const csv = tmpFile("roundtrip.csv", original);
    await page.goto(`/tools/${HUB}`);
    await switchMode(page, "csv-to-excel");
    await uploadFixture(page, csv);
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await waitForSuccess(page, "Excelへの変換が完了しました");
    const xlsx = (await assertDownloadedFile(await clickAndDownload(page, "ダウンロード"), { format: "zip", minBytes: 10 })).path;
    const xlsxCopy = path.join(tmpDir, "roundtrip.xlsx");
    fs.copyFileSync(xlsx, xlsxCopy);

    await switchMode(page, "excel-to-csv");
    await uploadFixture(page, xlsxCopy);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const back = await clickAndDownload(page, "CSVでダウンロード");
    expect(back.suggestedFilename()).toBe("roundtrip.csv");
    const { path: p } = await assertDownloadedFile(back, { minBytes: 1 });
    const text = fs.readFileSync(p, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
    expect(text.trimEnd()).toBe(original.trimEnd());
  });

  test("エラー: 空のCSV・壊れたExcelは、分かりやすいエラーを表示し、ダウンロードできない", async ({ page }) => {
    await page.goto("/tools/csv-to-excel");
    await uploadFixture(page, tmpFile("empty.csv", "\n\n\n"));
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await expect(page.getByText("CSVの内容が空です", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "ダウンロード" })).toHaveCount(0);

    await page.goto("/tools/excel-to-csv");
    await uploadFixture(page, tmpFile("broken.xlsx", "これはExcelではありません"));
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await expect(page.getByText("読み込みに失敗しました", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toHaveCount(0);
  });

  test("ファイルを選び直すと、前のファイルの結果は消える（古い結果をダウンロードさせない）", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await uploadFixture(page, fixtures.xlsx);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toBeVisible();
    await uploadFixture(page, fixtures.xlsxMultiSheet);
    await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "CSVに変換する" })).toBeVisible();
  });

  test("ファイルの中身は自社API・外部へ送信されない（両方向）", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    const marker = "ユニーク識別子XYZ12345";
    const csv = tmpFile("leak.csv", `id,name\n1,${marker}\n`);
    await page.goto(`/tools/${HUB}`);
    await switchMode(page, "csv-to-excel");
    await uploadFixture(page, csv);
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await waitForSuccess(page, "Excelへの変換が完了しました");
    await switchMode(page, "excel-to-csv");
    await uploadFixture(page, fixtures.xlsxMultiSheet);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");

    const origin = new URL(baseURL!).origin;
    expect(findLeakedRequests(recorder, marker)).toEqual([]);
    expect(findLeakedRequests(recorder, "S2_A1")).toEqual([]);
    expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 広告ゲート（Freeプラン）
// ---------------------------------------------------------------------------
plainTest.describe("Excel・CSV変換の統合: 広告ゲート（Freeプラン）", () => {
  plainTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  plainTest("Excel→CSV: 広告なしで開け、ダウンロードで広告確認画面が出る（総合・旧URLとも）", async ({ page }) => {
    for (const id of [HUB, "excel-to-csv"]) {
      await page.goto(`/tools/${id}`);
      await plainExpect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
      await plainExpect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
      await uploadFixture(page, fixtures.xlsx);
      await page.getByRole("button", { name: "CSVに変換する" }).click();
      await waitForSuccess(page, "変換が完了しました");
      await page.getByRole("button", { name: "CSVでダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    }
  });

  plainTest("CSV→Excel: 広告なしで開け、ダウンロードで広告確認画面が出る（総合・旧URLとも）", async ({ page }) => {
    for (const id of [HUB, "csv-to-excel"]) {
      await page.goto(`/tools/${id}`);
      await plainExpect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
      if (id === HUB) {
        await waitForFileInputHydrated(page);
        await page.getByTestId("excel-csv-mode-csv-to-excel").click();
        await plainExpect(page.getByTestId("excel-csv-mode-csv-to-excel")).toHaveAttribute("aria-pressed", "true");
      }
      await uploadFixture(page, fixtures.csv);
      await page.getByRole("button", { name: "Excelに変換する" }).click();
      await waitForSuccess(page, "Excelへの変換が完了しました");
      await page.getByRole("button", { name: "ダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    }
  });
});
