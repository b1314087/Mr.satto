import { expect, type Page } from "@playwright/test";
import { waitForFileInputHydrated } from "./tool-runner";

/**
 * 画像リサイズ・圧縮（/tools/image-compress）で、「圧縮する」だけを選んだ状態にする（新工程1）。
 * 新工程1から、初期状態は「サイズを変更する」だけを選んだ状態になったため、圧縮を確かめるテストで使う。
 * 画面の準備（hydration）が終わる前に押すと元に戻ることがあるため、ファイル入力欄の準備を待ってから選ぶ。
 */
export async function chooseCompressOnly(page: Page): Promise<void> {
  await waitForFileInputHydrated(page);
  // 総合改修 27：「容量を圧縮」を選ぶと「サイズを変更」は自動で外れる（どちらか一方だけ）
  await page.getByTestId("image-op-compress").click();
  await expect(page.getByTestId("image-op-resize")).not.toBeChecked();
  await expect(page.getByTestId("image-op-compress")).toBeChecked();
}
