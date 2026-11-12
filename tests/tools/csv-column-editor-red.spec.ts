import fs from "node:fs";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * CSV・Excel行列編集（総合改修 19）：削除する行・列が、編集前の表に赤い印（削除される）で出る。
 * 以前は、編集前の表にも先に行の削除を当てていたため、削除する行が表から消え、赤くならなかった。
 */

const removedCells = (page: import("@playwright/test").Page) => page.getByTestId("tool-preview").locator("td.line-through");

test("行を外すと、編集前の表のその行が赤く（取り消し線）なり、編集後の表には出ない。戻すと赤が消える", async ({ page }) => {
  const src = test.info().outputPath("rows.csv");
  const lines = ["名前,点数"];
  for (let i = 1; i <= 15; i++) lines.push(`生徒${i},${i * 5}`);
  fs.writeFileSync(src, lines.join("\n") + "\n");
  await page.goto("/tools/csv-column-editor");
  await uploadFixture(page, src);
  await page.getByTestId("column-editor-target-rows").click();
  await expect(removedCells(page)).toHaveCount(0);

  // 13行目（生徒12）は、先頭10行より後ろ。外しても編集前の表に出て、赤くなる
  await page.getByLabel("13行目を含める", { exact: true }).uncheck();
  await page.getByLabel("3行目を含める", { exact: true }).uncheck();
  const before = page.getByTestId("tool-preview").locator("table").first();
  await expect(before.locator("td.line-through", { hasText: "生徒12" })).toHaveCount(1);
  await expect(before.locator("td.line-through", { hasText: "生徒2" }).first()).toBeVisible();
  await expect(before.locator("th", { hasText: "13" })).toBeVisible(); // 元の行番号
  // 編集後の表には、外した行が無い
  const after = page.getByTestId("tool-preview").locator("table").nth(1);
  await expect(after).not.toContainText("生徒12");
  await expect(after.locator("td", { hasText: /^生徒2$/ })).toHaveCount(0);
  // 戻すと、赤い印が消える（表示が残らない）
  await page.getByLabel("13行目を含める", { exact: true }).check();
  await page.getByLabel("3行目を含める", { exact: true }).check();
  await expect(removedCells(page)).toHaveCount(0);
});

test("列を外すと、編集前の表のその列が赤くなる（行と列の両方で正しく出る）", async ({ page }) => {
  const src = test.info().outputPath("cols.csv");
  fs.writeFileSync(src, "名前,点数,クラス\n山田,80,A\n佐藤,70,B\n");
  await page.goto("/tools/csv-column-editor");
  await uploadFixture(page, src);
  await page.getByTestId("column-editor-target-columns").click();
  await page.getByLabel("クラスを含める").uncheck();
  const before = page.getByTestId("tool-preview").locator("table").first();
  await expect(before.locator("td.line-through")).toHaveCount(3); // 見出し＋2行のクラスの列
  await page.getByTestId("column-editor-target-rows").click();
  await page.getByLabel("2行目を含める", { exact: true }).uncheck();
  // 列（クラスの3セル）＋ 行（山田の名前・点数の2セル）
  await expect(before.locator("td.line-through")).toHaveCount(5);
});
