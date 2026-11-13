import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { detectPrefecture, formatZip, normalizeAddress, normalizeZip, zipInputError } from "@/lib/postal/postal-search";
import { clickAndDownload } from "../helpers/tool-runner";
import { PLAN_LIMITS } from "@/lib/plans/tool-limits";
/** ページを開き、画面の部品が動き出す（ハイドレーションが終わる）まで待つ。終わる前に押した操作は反映されないため */
async function openPostal(page: import("@playwright/test").Page) {
  await page.goto("/tools/postal-search");
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="postal-search"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
}


/**
 * 郵便番号・住所検索（総合改修 17）。
 * - 入力の整え方（全角・ハイフン・〒）と、都道府県名の読み取り
 * - 画面：郵便番号→住所、住所→郵便番号、コピー、外部へ送らない（同じサイトの住所データだけを読む）
 */

plainTest("郵便番号の入力：全角・ハイフン・〒を取り除き、3〜7桁の数字だけを受け付ける", () => {
  plainExpect(normalizeZip("〒１００－０００１")).toBe("1000001");
  plainExpect(formatZip("1000001")).toBe("100-0001");
  plainExpect(zipInputError("")).toContain("入れてください");
  plainExpect(zipInputError("10")).toContain("3桁以上");
  plainExpect(zipInputError("12345678")).toContain("7桁");
  plainExpect(zipInputError("abc")).toContain("数字");
  plainExpect(zipInputError("100")).toBeNull();
});

plainTest("住所：都道府県名を読み取る（「京都市」のような市の名前は残す）。表記ゆれをそろえる", () => {
  plainExpect(detectPrefecture("東京都千代田区丸の内")).toEqual({ code: 13, rest: "千代田区丸の内" });
  plainExpect(detectPrefecture("京都府京都市中京区")?.code).toBe(26);
  plainExpect(detectPrefecture("北海道札幌市")?.rest).toBe("札幌市");
  plainExpect(detectPrefecture("千代田区")).toBeNull();
  plainExpect(normalizeAddress("霞ヶ関 １丁目")).toBe(normalizeAddress("霞が関1丁目"));
});

test.describe("郵便番号・住所検索の画面", () => {
  test("郵便番号から住所：100-0001 → 東京都千代田区千代田。全角で入れても探せる。コピーできる", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const external: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["localhost", "127.0.0.1"].includes(u.hostname) && u.pathname.includes("postal")) external.push(r.url());
    });
    await openPostal(page);
    await page.getByTestId("postal-zip-input").fill("１００－０００１");
    await page.getByTestId("postal-search").click();
    await expect(page.getByTestId("postal-result-count")).toHaveText("1件");
    await expect(page.getByTestId("postal-result-zip")).toHaveText("〒100-0001");
    await expect(page.getByTestId("postal-result-address")).toHaveText("東京都千代田区千代田");
    await page.getByTestId("postal-copy-address").click();
    await expect(page.getByTestId("postal-copy-address")).toHaveText("コピーしました");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("東京都千代田区千代田");
    await page.getByTestId("postal-copy-zip").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("100-0001");
    await expect(page.getByTestId("postal-data-note")).toContainText("日本郵便");
    await expect(page.getByTestId("postal-data-note")).toContainText("時点");
    expect(external).toEqual([]);
  });

  test("上3桁だけでも候補が出る。見つからない番号・誤った入力は理由を出す", async ({ page }) => {
    await openPostal(page);
    await page.getByTestId("postal-zip-input").fill("100");
    await page.getByTestId("postal-search").click();
    await expect(page.getByTestId("postal-result").first()).toContainText("東京都千代田区");
    await page.getByTestId("postal-zip-input").fill("0000000");
    await page.getByTestId("postal-search").click();
    await expect(page.getByTestId("postal-result-count")).toHaveText("見つかりませんでした。");
    await page.getByTestId("postal-zip-input").fill("12");
    await page.getByTestId("postal-search").click();
    await expect(page.getByText("郵便番号は3桁以上入れてください")).toBeVisible();
  });

  test("住所から郵便番号：都道府県を選んで町域を入れる／先頭に都道府県名・番地まで入れても探せる", async ({ page }) => {
    await openPostal(page);
    await page.getByTestId("postal-mode").getByRole("radio", { name: "住所から郵便番号" }).click();
    await page.getByTestId("postal-pref").selectOption({ label: "東京都" });
    await page.getByTestId("postal-address-input").fill("千代田区千代田");
    await page.getByTestId("postal-search").click();
    await expect(page.getByTestId("postal-result-zip").first()).toHaveText("〒100-0001");

    await page.getByTestId("postal-pref").selectOption({ value: "0" });
    await page.getByTestId("postal-address-input").fill("東京都千代田区丸の内１－１－１");
    await page.getByTestId("postal-search").click();
    await expect(page.getByTestId("postal-pref")).toHaveValue("13");
    await expect(page.getByTestId("postal-result-address").first()).toContainText("東京都千代田区丸の内");

    await page.getByTestId("postal-pref").selectOption({ value: "0" });
    await page.getByTestId("postal-address-input").fill("丸の内");
    await page.getByTestId("postal-search").click();
    await expect(page.getByText("都道府県を選ぶか、住所の先頭に都道府県名を入れてください。")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// まとめて調べる（プレミアム）
// ---------------------------------------------------------------------------

test.describe("まとめて調べる（プレミアム）", () => {
  test("郵便番号の一覧を貼り付けると、住所をまとめて調べる。先頭の0が消えた6けたは補い、見つからない・形の違う行は理由を出す", async ({ page }) => {
    await openPostal(page);
    const bulk = page.getByTestId("postal-bulk");
    // 途中の空行は「空欄」として数え、末尾の空行は数えない
    await bulk.getByTestId("postal-bulk-text").fill(["100-0001", "６５０－０００１", "600001", "0000000", "12a", "", "100-0001"].join("\n") + "\n\n");
    await expect(bulk.getByTestId("postal-bulk-run")).toHaveText("7件をまとめて調べる");
    await bulk.getByTestId("postal-bulk-run").click();
    const rows = bulk.getByTestId("postal-bulk-row");
    await expect(rows).toHaveCount(7);
    await expect(rows.nth(0).getByTestId("postal-bulk-value")).toHaveText("東京都千代田区千代田");
    await expect(rows.nth(6).getByTestId("postal-bulk-value")).toHaveText("東京都千代田区千代田"); // 同じ入力も、それぞれの行に結果を出す
    await expect(rows.nth(1).getByTestId("postal-bulk-value")).toContainText("兵庫県神戸市中央区");
    await expect(rows.nth(2)).toHaveAttribute("data-status", "ok"); // 060-0001
    await expect(rows.nth(2)).toContainText("先頭の0を補いました");
    await expect(rows.nth(2).getByTestId("postal-bulk-value")).toContainText("北海道札幌市中央区");
    await expect(rows.nth(3)).toHaveAttribute("data-status", "not-found");
    await expect(rows.nth(4)).toHaveAttribute("data-status", "invalid");
    await expect(rows.nth(5)).toHaveAttribute("data-status", "empty");
    await expect(bulk.getByTestId("postal-bulk-summary")).toContainText("7件中、見つかった4件");
    const dl = await clickAndDownload(page, "CSVで保存");
    expect(dl.suggestedFilename()).toBe("郵便番号・住所の検索結果-住所付き.csv");
    const csv = (await import("node:fs")).readFileSync((await dl.path())!, "utf8");
    expect(csv.split("\r\n")[0]).toBe("﻿郵便番号（入力）,住所（検索結果）,検索の状態,備考");
    expect(csv).toContain("100-0001,東京都千代田区千代田,見つかりました,");
  });

  test("住所の一覧から郵便番号をまとめて調べる。候補が複数・都道府県が無い行は、状態と理由を出す", async ({ page }) => {
    await openPostal(page);
    await page.getByTestId("postal-mode").getByRole("radio", { name: "住所から郵便番号" }).click();
    const bulk = page.getByTestId("postal-bulk");
    await bulk.getByTestId("postal-bulk-text").fill(["東京都千代田区千代田1-1", "東京都千代田区", "千代田区千代田"].join("\n"));
    await bulk.getByTestId("postal-bulk-run").click();
    const rows = bulk.getByTestId("postal-bulk-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute("data-status", "ok");
    await expect(rows.nth(0).getByTestId("postal-bulk-value")).toHaveText("100-0001");
    // 同じ町域に会社などあての個別番号（100-8111）もあるため、番号の小さい一般の番号を入れ、備考で知らせる
    await expect(rows.nth(0)).toContainText("ほかに1件の郵便番号があります");
    await expect(rows.nth(1)).toHaveAttribute("data-status", "multiple"); // 「千代田区」だけ：町域が違う候補が多数
    await expect(rows.nth(1)).toContainText("候補が");
    await expect(rows.nth(2)).toHaveAttribute("data-status", "invalid");
    await expect(rows.nth(2)).toContainText("都道府県");
  });

  test("Excelを読み込み、住所が分かれた列をつなげて調べ、元の表の右に結果の列を足したExcelで保存する（郵便番号は文字のまま）", async ({ page }) => {
    test.setTimeout(120_000);
    const { execFileSync } = await import("node:child_process");
    const src = test.info().outputPath("meibo.xlsx");
    execFileSync("python3", [
      "-c",
      "import sys\nfrom openpyxl import Workbook\nwb=Workbook();ws=wb.active\nws.append(['氏名','都道府県','住所1','電話'])\nws.append(['山田','東京都','千代田区千代田1-1','03-0000-0000'])\nws.append(['佐藤','北海道','札幌市中央区北一条西','011-000-0000'])\nwb.save(sys.argv[1])",
      src,
    ]);
    await openPostal(page);
    await page.getByTestId("postal-mode").getByRole("radio", { name: "住所から郵便番号" }).click();
    const bulk = page.getByTestId("postal-bulk");
    await bulk.getByTestId("postal-bulk-source").getByRole("radio", { name: "Excel・CSVを読み込む" }).click();
    await bulk.locator("input[type=file]").setInputFiles(src);
    await expect(bulk.getByTestId("postal-bulk-file-info")).toContainText("2行を読み込みました");
    // 見出しから、住所の列（都道府県・住所1）を選んでおく
    await expect(bulk.getByTestId("postal-bulk-col-1")).toBeChecked();
    await expect(bulk.getByTestId("postal-bulk-col-2")).toBeChecked();
    await expect(bulk.getByTestId("postal-bulk-col-0")).not.toBeChecked();
    await bulk.getByTestId("postal-bulk-run").click();
    const rows = bulk.getByTestId("postal-bulk-row");
    await expect(rows.nth(0).getByTestId("postal-bulk-value")).toHaveText("100-0001");
    await expect(rows.nth(1).getByTestId("postal-bulk-value")).toHaveText("060-0001");
    const dl = await clickAndDownload(page, "Excelで保存");
    expect(dl.suggestedFilename()).toBe("meibo-郵便番号付き.xlsx");
    const out = test.info().outputPath("out.xlsx");
    await dl.saveAs(out);
    const json = execFileSync("python3", [
      "-c",
      "import sys,json\nfrom openpyxl import load_workbook\nws=load_workbook(sys.argv[1]).active\nprint(json.dumps([[c.value for c in r] for r in ws.iter_rows()],ensure_ascii=False))",
      out,
    ]).toString();
    const sheet = JSON.parse(json);
    expect(sheet[0]).toEqual(["氏名", "都道府県", "住所1", "電話", "郵便番号（検索結果）", "検索の状態", "備考"]);
    expect(sheet[1].slice(0, 6)).toEqual(["山田", "東京都", "千代田区千代田1-1", "03-0000-0000", "100-0001", "見つかりました"]);
    expect(sheet[2][4]).toBe("060-0001"); // 先頭の0が消えない
  });
});

// 2026-11 料金プランの見直し：まとめて調べる件数は、無料1件（使えない）・旧スタンダード10件・プレミアム10,000件
test("まとめて調べる：無料では、プレミアムの機能と案内し、入力欄を出さない（1件ずつの検索は使える）", async ({ page, context, baseURL }) => {
  const { setDevPlanOverride } = await import("../helpers/dev-plan");
  await setDevPlanOverride(context, "free", baseURL!);
  await openPostal(page);
  await expect(page.getByTestId("postal-bulk-premium-note")).toBeVisible();
  await expect(page.getByTestId("postal-bulk-text")).toHaveCount(0);
  await page.getByTestId("postal-zip-input").fill("1000001");
  await page.getByTestId("postal-search").click();
  await expect(page.getByTestId("postal-result-address")).toHaveText("東京都千代田区千代田");
});

test("まとめて調べる：旧スタンダードでは、入力欄が出て、上限の件数を案内する", async ({ page, context, baseURL }) => {
  const { setDevPlanOverride } = await import("../helpers/dev-plan");
  await setDevPlanOverride(context, "standard", baseURL!);
  await openPostal(page);
  await expect(page.getByTestId("postal-bulk-premium-note")).toHaveCount(0);
  await expect(page.getByTestId("plan-limit-hint")).toContainText(`${PLAN_LIMITS["postal-bulk"].standard}件まで`);
});
