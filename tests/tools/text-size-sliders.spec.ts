import { test, expect } from "../fixtures/premium-test";

/** 文字の大きさを変えられるツールは、スライダー＋数値入力で調整できる */
test("電子印鑑: 文字サイズがスライダー＋数値入力になっている", async ({ page }) => {
  await page.goto("/tools/electronic-stamp-generator");
  const slider = page.getByRole("slider", { name: "文字サイズ" });
  await expect(slider).toBeVisible();
  await expect(page.getByLabel("文字サイズの数値")).toBeVisible();
  await expect(async () => {
    await slider.fill("130");
    await expect(page.getByLabel("文字サイズの数値")).toHaveValue("130", { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
});

test("封筒宛名: 文字サイズ・X位置・Y位置がスライダーになっている", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  for (const name of ["宛名の文字サイズ", "宛名のX位置", "宛名のY位置"]) {
    await expect(page.getByRole("slider", { name })).toBeVisible();
  }
});
