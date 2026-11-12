import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { detectPrefecture, formatZip, normalizeAddress, normalizeZip, zipInputError } from "@/lib/postal/postal-search";

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
    await page.goto("/tools/postal-search");
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
    await page.goto("/tools/postal-search");
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
    await page.goto("/tools/postal-search?mode=address-to-zip");
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
