import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clearDevOverrides } from "../helpers/dev-plan";
import { fixtures } from "../fixtures/paths";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { uploadFixture as rawUpload, waitForSuccess, clickAndDownload, assertDownloadedFile, closeResultPopup } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { siteConfig } from "@/lib/config/site";
import { getListedTools, getMergedTools, getToolById, getFeaturedTools, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import { CSV_JSON_MODES, CSV_JSON_TOOL_ID } from "@/lib/tools/csv-json-modes";
import sitemap from "@/app/sitemap";

/**
 * CSV・JSON変換の総合ツール化（csv-json-convert）のテスト。
 *  - CSV→JSON: csv-to-json / JSON→CSV: json-to-csv → csv-json-convert に統合（個別URLは維持）
 * この2ツールには専用のE2Eがなかったため、登録・一覧・検索・旧URL・SEOに加えて、
 * 両方向の変換内容・エラー・切り替え・広告ゲート・ローカル処理もここで確認する。
 */

const HUB = CSV_JSON_TOOL_ID;
const MEMBERS = ["csv-to-json", "json-to-csv"];
const MEMBER_NAMES = ["CSV→JSON", "JSON→CSV"];
const SEARCHES = [
  "CSV",
  "JSON",
  "CSV JSON",
  "JSON CSV",
  "CSVからJSON",
  "JSONからCSV",
  "CSVをJSONに変換",
  "JSONをCSVに変換",
  "csv→json",
  "json→csv",
  "csv to json",
  "CSV・JSON変換",
];

/** ファイル入力欄の準備（hydration）が終わってから選択する（準備前の選択は無視されることがあるため） */
async function uploadFixture(page: Page, files: string | string[]) {
  await waitForFileInputHydrated(page);
  await rawUpload(page, files);
}

/** 向きを切り替える。画面の準備（hydration）前のクリックは無視されることがあるため、押された状態になるまで確認する */
async function switchMode(page: Page, mode: string) {
  await waitForFileInputHydrated(page).catch(() => undefined);
  await expect(async () => {
    await closeResultPopup(page);
    await page.getByTestId(`csv-json-mode-${mode}`).click();
    await expect(page.getByTestId(`csv-json-mode-${mode}`)).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

const modeBtn = (page: Page, mode: string) => page.getByTestId(`csv-json-mode-${mode}`);
const card = (page: Page, id: string) => page.locator("main").locator(`a[href="/tools/${id}"]`);
const resultBox = (page: Page) => page.getByRole("textbox", { name: /変換結果/ });
/** JSON→CSVの入力欄（画面にはテキストエリアが1つだけ出る） */
const jsonInput = (page: Page) => page.getByRole("textbox", { name: /入力/ });

/** JSON→CSV画面に入力欄が出て、操作できる状態になるまで待つ */
async function waitForJsonInput(page: Page) {
  await expect(jsonInput(page)).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await jsonInput(page).fill("x");
    await expect(jsonInput(page)).toHaveValue("x", { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await jsonInput(page).fill("");
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-json-"));
function tmpFile(name: string, content: string | Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}
const normalize = (text: string) => text.replace(/^﻿/, "").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// 1. 登録・検索・関連・おすすめ・sitemap・SEO（ブラウザ不要）
// ---------------------------------------------------------------------------
plainTest.describe("CSV・JSON変換の統合: 登録と一覧・検索・SEO", () => {
  plainTest("総合ツールが登録され、旧2ツールが統合済みになっている", () => {
    const hub = getToolById(HUB);
    plainExpect(hub?.name).toBe("CSV・JSON変換");
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
    plainExpect(CSV_JSON_MODES.map((m) => m.toolId).sort()).toEqual([...MEMBERS].sort());
  });

  for (const q of SEARCHES) {
    plainTest(`検索「${q}」で総合ツールが見つかり、旧ツールは重複して出ない`, () => {
      const result = searchTools(getListedTools(), q);
      plainExpect(result.some((t) => t.id === HUB), `${HUB}がヒットしない`).toBe(true);
      plainExpect(result.filter((t) => t.mergedInto).map((t) => t.id)).toEqual([]);
    });
  }

  plainTest("検索「CSV」「JSON」: 他のツールのヒットは従来どおり残る", () => {
    const csv = searchTools(getListedTools(), "CSV").map((t) => t.id);
    for (const id of ["csv-format", "csv-merge", "csv-dedupe", "csv-replace", "excel-csv-convert"]) plainExpect(csv, id).toContain(id);
    const json = searchTools(getListedTools(), "JSON").map((t) => t.id);
    plainExpect(json).toContain(HUB);
  });

  plainTest("ツール一覧の対象: 総合ツール1件だけが並び、旧2件は外れ、他のCSV・Excelツールは減っていない", () => {
    const ids = new Set(getListedTools().map((t) => t.id));
    plainExpect(ids.has(HUB)).toBe(true);
    for (const m of MEMBERS) plainExpect(ids.has(m), `${m}が一覧に残っている`).toBe(false);
    for (const id of ["csv-format", "csv-merge", "csv-dedupe", "csv-replace", "excel-csv-convert", "excel-transpose", "excel-replace", "excel-to-pdf"]) {
      plainExpect(ids.has(id), `${id}が一覧から消えている`).toBe(true);
    }
    plainExpect(getListedTools().length).toBe(tools.filter((t) => !t.mergedInto).length);
  });

  plainTest("関連ツール・おすすめに、統合済みの旧ツールは出ない", () => {
    for (const id of [HUB, ...MEMBERS, "csv-format", "csv-merge", "csv-replace", "excel-csv-convert"]) {
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
    plainExpect(toolSeoContent["csv-to-json"].metaTitle).toBe("CSV→JSON変換｜CSVファイルをJSON配列に変換");
    plainExpect(toolSeoContent["json-to-csv"].metaTitle).toBe("JSON→CSV変換｜オブジェクトの配列をCSVに変換");
  });

  plainTest("SEO文は実装と食い違わない: 総合ページは文字列出力・UTF-8・ネスト非対応を説明している", () => {
    const text = JSON.stringify(toolSeoContent[HUB]);
    plainExpect(text).toContain("文字列");
    plainExpect(text).toContain("UTF-8");
    plainExpect(text).toContain("入れ子");
    plainExpect(text).not.toContain("自動判定");
  });
});

// ---------------------------------------------------------------------------
// 2. 画面: 一覧・カテゴリ・旧URL・内部リンク・切り替え
// ---------------------------------------------------------------------------
test.describe("CSV・JSON変換の統合: 一覧・カテゴリ・旧URL", () => {
  test("全ツール一覧・CSV/Excelカテゴリに、総合ツールが1つだけ出て、旧ツールのカードは出ない", async ({ page }) => {
    for (const url of ["/tools", "/tools?category=csv-excel", "/tools/csv-excel"]) {
      await page.goto(url);
      await expect(card(page, HUB), `${url}: 総合ツール`).toHaveCount(1);
      for (const m of MEMBERS) await expect(card(page, m), `${url}: ${m}`).toHaveCount(0);
      await expect(card(page, "csv-merge"), `${url}: CSV結合`).toHaveCount(1);
    }
  });

  for (const q of ["JSON", "CSV JSON", "CSVからJSON", "JSONをCSVに変換"]) {
    test(`ツール一覧の検索「${q}」: 総合ツールが出て、旧ツールは重複して出ない`, async ({ page }) => {
      await page.goto(`/tools?q=${encodeURIComponent(q)}`);
      await expect(card(page, HUB)).toHaveCount(1);
      for (const m of MEMBERS) await expect(card(page, m), `${m}のカード`).toHaveCount(0);
    });
  }

  const initial: Record<string, string> = { [HUB]: "csv-to-json", "csv-to-json": "csv-to-json", "json-to-csv": "json-to-csv" };
  for (const id of [HUB, ...MEMBERS]) {
    test(`/tools/${id}: 開け、自分自身のcanonical・タイトルのまま、同じ画面の各ページへのリンクと正しい初期の向きがある`, async ({ page }) => {
      await page.goto(`/tools/${id}`);
      await expect(page.locator("h1")).toHaveText(getToolById(id)!.name);
      await expect(page.getByTestId("csv-json-modes")).toBeVisible({ timeout: 30_000 });
      expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(new RegExp(`/tools/${id}$`));
      expect(await page.title()).toContain(toolSeoContent[id].metaTitle);

      const other = initial[id] === "csv-to-json" ? "json-to-csv" : "csv-to-json";
      await expect(modeBtn(page, initial[id])).toHaveAttribute("aria-pressed", "true");
      await expect(modeBtn(page, other)).toHaveAttribute("aria-pressed", "false");

      const nav = page.getByRole("navigation", { name: "同じ画面で使える各ページ" });
      await expect(nav).toBeVisible();
      const expected = [HUB, ...MEMBERS].filter((x) => x !== id);
      for (const o of expected) await expect(nav.locator(`a[href="/tools/${o}"]`), `${o}へのリンク`).toHaveCount(1);
      await expect(nav.locator(`a[href="/tools/${id}"]`), "自分自身へのリンク").toHaveCount(0);
      expect(await nav.locator("a").count()).toBe(expected.length);
    });
  }

  test("CSV→JSONで変換した後に向きを切り替えると結果が消え、戻っても前のファイル・結果は残らない", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await uploadFixture(page, fixtures.csv);
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(resultBox(page)).toBeVisible();
    await expect(page.getByRole("button", { name: ".jsonをダウンロード" })).toBeVisible();

    await switchMode(page, "json-to-csv");
    await expect(page.getByText("sample.csv")).toHaveCount(0);
    await expect(resultBox(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: ".jsonをダウンロード" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "JSONに変換する" })).toHaveCount(0);
    await expect(jsonInput(page)).toHaveValue("");

    await switchMode(page, "csv-to-json");
    await expect(page.getByText("sample.csv")).toHaveCount(0);
    await expect(resultBox(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: ".jsonをダウンロード" })).toHaveCount(0);
  });

  test("JSON→CSVで変換した後に向きを切り替えると、入力も結果も消える", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await switchMode(page, "json-to-csv");
    await jsonInput(page).fill('[{"a":1}]');
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toBeVisible();

    await switchMode(page, "csv-to-json");
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);
    await switchMode(page, "json-to-csv");
    await expect(jsonInput(page)).toHaveValue("");
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);
    await expect(resultBox(page)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 変換内容（既存仕様の確認）
// ---------------------------------------------------------------------------
test.describe("CSV・JSON変換の統合: CSV → JSON の変換内容", () => {
  test("サンプルCSV: 1行目が見出しになり、値はすべて文字列のJSONになる。ファイル名は元の名前.json", async ({ page }) => {
    await page.goto("/tools/csv-to-json");
    await uploadFixture(page, fixtures.csv);
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText("変換結果（3件）")).toBeVisible();

    const download = await clickAndDownload(page, ".jsonをダウンロード");
    expect(download.suggestedFilename()).toBe("sample.json");
    const { path: p } = await assertDownloadedFile(download, { minBytes: 1 });
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(json).toEqual([
      { id: "1", name: "テスト商品A", quantity: "2", price: "1000" },
      { id: "2", name: "テスト商品B", quantity: "5", price: "2500" },
      { id: "3", name: "テスト商品C", quantity: "1", price: "500" },
    ]);
    // 画面に表示される結果も、ダウンロードと同じ内容
    expect(JSON.parse(await resultBox(page).inputValue())).toEqual(json);
  });

  test("カンマ・引用符・セル内改行・空行・先頭ゼロ・BOMを含むCSVが、内容どおりのJSONになる", async ({ page }) => {
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('name,memo,zip\n"山田, 太郎","1行目\n2行目 ""引用""",0123\n\n鈴木,通常,\n', "utf8"),
    ]);
    await page.goto("/tools/csv-to-json");
    await uploadFixture(page, tmpFile("special.csv", csv));
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const { path: p } = await assertDownloadedFile(await clickAndDownload(page, ".jsonをダウンロード"), { minBytes: 1 });
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual([
      { name: "山田, 太郎", memo: '1行目\n2行目 "引用"', zip: "0123" },
      { name: "鈴木", memo: "通常", zip: "" },
    ]);
  });

  const csvErrors: [string, string, RegExp][] = [
    ["空のCSV", "\n\n\n", /CSVの内容が空です/],
    ["空欄の見出し", "a,,c\n1,2,3\n", /1行目（ヘッダー）の2列目が空です/],
    ["重複した見出し", "a,a\n1,2\n", /ヘッダーに同じ名前が重複しています（a）/],
    ["列数の不一致", "a,b\n1,2,3\n", /2行目の列数がヘッダー（2列）と一致しません（3列）/],
  ];
  for (const [label, content, message] of csvErrors) {
    test(`エラー: ${label}は、分かりやすいエラーを表示し、ダウンロードできない`, async ({ page }) => {
      await page.goto("/tools/csv-to-json");
      await uploadFixture(page, tmpFile("bad.csv", content));
      await page.getByRole("button", { name: "JSONに変換する" }).click();
      await expect(page.getByText(message).first()).toBeVisible();
      await expect(page.getByRole("button", { name: ".jsonをダウンロード" })).toHaveCount(0);
      await expect(resultBox(page)).toHaveCount(0);
    });
  }

  test("ファイルを選び直しても、エラー後は正しいCSVで変換できる", async ({ page }) => {
    await page.goto("/tools/csv-to-json");
    await uploadFixture(page, tmpFile("bad2.csv", "a,a\n1,2\n"));
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await expect(page.getByText("同じ名前が重複しています").first()).toBeVisible();
    await uploadFixture(page, fixtures.csv);
    await expect(page.getByText("同じ名前が重複しています")).toHaveCount(0);
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText("変換結果（3件）")).toBeVisible();
  });
});

test.describe("CSV・JSON変換の統合: JSON → CSV の変換内容", () => {
  test("オブジェクトごとにキーが違っても全キーが見出しになり、欠けた値は空欄・BOM付きUTF-8で出力される", async ({ page }) => {
    await page.goto("/tools/json-to-csv");
    await waitForJsonInput(page);
    await jsonInput(page).fill('[{"name":"田中","age":20,"note":"a,b"},{"name":"佐藤","extra":"x\\"y","age":null,"ok":true}]');
    await expect(page.getByRole("button", { name: "CSVに変換する" })).toBeEnabled();
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText("変換結果（2行 × 5列）")).toBeVisible();

    const download = await clickAndDownload(page, ".csvをダウンロード");
    expect(download.suggestedFilename()).toBe("output.csv");
    const { path: p } = await assertDownloadedFile(download, { minBytes: 1 });
    const buf = fs.readFileSync(p);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(normalize(buf.toString("utf8")).trimEnd()).toBe(
      ["name,age,note,extra,ok", "田中,20,\"a,b\",,", '佐藤,,,"x""y",true'].join("\n")
    );
    // 画面に表示される結果も、ダウンロードと同じ内容
    expect(normalize(await resultBox(page).inputValue()).trimEnd()).toBe(normalize(buf.toString("utf8")).trimEnd());
  });

  test("入力が空のあいだは変換ボタンが押せない", async ({ page }) => {
    await page.goto("/tools/json-to-csv");
    await waitForJsonInput(page);
    await expect(page.getByRole("button", { name: "CSVに変換する" })).toBeDisabled();
    await jsonInput(page).fill("   ");
    await expect(page.getByRole("button", { name: "CSVに変換する" })).toBeDisabled();
  });

  const jsonErrors: [string, string, RegExp][] = [
    ["構文が正しくないJSON", "{bad", /JSONの形式が正しくありません/],
    ["配列ではないJSON", '{"a":1}', /JSONの配列.*を入力してください/],
    ["空の配列", "[]", /配列の中身が空です/],
    ["オブジェクトではない要素", "[1,2]", /1番目の要素がオブジェクトではありません/],
    ["入れ子のJSON", '[{"a":{"b":1}}]', /ネストしたオブジェクト\/配列のため、表形式に変換できません/],
  ];
  for (const [label, input, message] of jsonErrors) {
    test(`エラー: ${label}は、分かりやすいエラーを表示し、ダウンロードできない`, async ({ page }) => {
      await page.goto("/tools/json-to-csv");
      await waitForJsonInput(page);
      await jsonInput(page).fill(input);
      await page.getByRole("button", { name: "CSVに変換する" }).click();
      await expect(page.getByText(message).first()).toBeVisible();
      await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);
      await expect(resultBox(page)).toHaveCount(0);
    });
  }
});

test.describe("CSV・JSON変換の統合: JSON → CSV で入力を変えたら古い結果を残さない", () => {
  test("入力を変更すると結果とダウンロードが消え、不正なJSONに変えても前の結果は残らず、再変換後は新しい入力のCSVが出る", async ({ page }) => {
    await page.goto("/tools/json-to-csv");
    await waitForJsonInput(page);

    // 1. 変換すると結果が出る
    await jsonInput(page).fill('[{"name":"古い","age":1}]');
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(resultBox(page)).toBeVisible();
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toBeVisible();

    // 2・3. 入力を変更すると、前の結果もダウンロードも消える
    await jsonInput(page).fill('[{"name":"新しい","age":2}]');
    await expect(resultBox(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);
    await expect(page.getByText("変換が完了しました")).toHaveCount(0);

    // 4. 不正なJSONに変えても、前の成功結果は残らない（再変換でエラーになっても同じ）
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await jsonInput(page).fill("{bad");
    await expect(resultBox(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await expect(page.getByText("JSONの形式が正しくありません").first()).toBeVisible();
    await expect(resultBox(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);

    // 入力を直すと、エラー表示も消える
    await jsonInput(page).fill('[{"name":"最後","age":3}]');
    await expect(page.getByText("JSONの形式が正しくありません")).toHaveCount(0);

    // 5. 再変換後は、新しい入力に対応したCSVをダウンロードできる
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const { path: p } = await assertDownloadedFile(await clickAndDownload(page, ".csvをダウンロード"), { minBytes: 1 });
    const text = normalize(fs.readFileSync(p, "utf8"));
    expect(text).toContain("最後");
    expect(text).not.toContain("古い");
    expect(text).not.toContain("新しい");
  });

  test("総合ページでも同じ（入力を変えると結果が消える）。CSV→JSONの動作には影響しない", async ({ page }) => {
    await page.goto(`/tools/${HUB}`);
    await switchMode(page, "json-to-csv");
    await jsonInput(page).fill('[{"a":1}]');
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await jsonInput(page).fill('[{"a":2}]');
    await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toHaveCount(0);

    // 6. CSV→JSON は従来どおり（変換後に結果が残り、ダウンロードできる）
    await switchMode(page, "csv-to-json");
    await uploadFixture(page, fixtures.csv);
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText("変換結果（3件）")).toBeVisible();
    await expect(page.getByRole("button", { name: ".jsonをダウンロード" })).toBeVisible();
  });
});

test.describe("CSV・JSON変換の統合: 往復とローカル処理", () => {
  test("往復: CSV→JSONの結果を、同じ画面でJSON→CSVに入れると、元のCSVの内容に戻る", async ({ page }) => {
    const original = 'id,name,note\n1,テスト商品A,"a,b"\n2,テスト商品B,"x""y"\n3,テスト商品C,\n';
    await page.goto(`/tools/${HUB}`);
    await uploadFixture(page, tmpFile("roundtrip.csv", original));
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const json = await resultBox(page).inputValue();

    await switchMode(page, "json-to-csv");
    await jsonInput(page).fill(json);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const { path: p } = await assertDownloadedFile(await clickAndDownload(page, ".csvをダウンロード"), { minBytes: 1 });
    expect(normalize(fs.readFileSync(p, "utf8")).trimEnd()).toBe(original.trimEnd());
  });

  test("CSV・JSONの内容は自社API・外部へ送信されない（両方向）", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    const marker1 = "ユニーク識別子CSV12345";
    const marker2 = "ユニーク識別子JSON67890";
    await page.goto(`/tools/${HUB}`);
    await uploadFixture(page, tmpFile("leak.csv", `id,name\n1,${marker1}\n`));
    await page.getByRole("button", { name: "JSONに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await switchMode(page, "json-to-csv");
    await jsonInput(page).fill(`[{"id":1,"name":"${marker2}"}]`);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await waitForSuccess(page, "変換が完了しました");

    const origin = new URL(baseURL!).origin;
    expect(findLeakedRequests(recorder, marker1)).toEqual([]);
    expect(findLeakedRequests(recorder, marker2)).toEqual([]);
    expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. 広告ゲート（Freeプラン）
// ---------------------------------------------------------------------------
plainTest.describe("CSV・JSON変換の統合: 広告ゲート（Freeプラン）", () => {
  plainTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  plainTest("CSV→JSON: 広告なしで開け、ダウンロードで広告確認画面が出る（総合・旧URLとも）", async ({ page }) => {
    for (const id of [HUB, "csv-to-json"]) {
      await page.goto(`/tools/${id}`);
      await plainExpect(page.getByTestId("csv-json-modes")).toBeVisible({ timeout: 30_000 });
      await plainExpect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
      await uploadFixture(page, fixtures.csv);
      await page.getByRole("button", { name: "JSONに変換する" }).click();
      await waitForSuccess(page, "変換が完了しました");
      await page.getByRole("button", { name: ".jsonをダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    }
  });

  plainTest("JSON→CSV: 広告なしで開け、ダウンロードで広告確認画面が出る（総合・旧URLとも）", async ({ page }) => {
    for (const id of [HUB, "json-to-csv"]) {
      await page.goto(`/tools/${id}`);
      await plainExpect(page.getByTestId("csv-json-modes")).toBeVisible({ timeout: 30_000 });
      await plainExpect(page.getByRole("button", { name: "広告を見て1時間無料で使う" })).toHaveCount(0);
      if (id === HUB) await switchMode(page, "json-to-csv");
      await waitForJsonInput(page);
      await jsonInput(page).fill('[{"a":1,"b":"x"}]');
      await page.getByRole("button", { name: "CSVに変換する" }).click();
      await waitForSuccess(page, "変換が完了しました");
      await page.getByRole("button", { name: ".csvをダウンロード" }).click();
      const dialog = page.getByTestId("download-gate-dialog");
      await plainExpect(dialog).toBeVisible();
      await plainExpect(dialog.getByRole("button", { name: "広告を見てダウンロード" })).toBeVisible();
    }
  });
});
