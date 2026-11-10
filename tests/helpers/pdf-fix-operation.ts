import { expect, type Page } from "@playwright/test";

/**
 * PDF修正の「やりたい操作」のプルダウンで、操作を選ぶ（新工程1）。
 * 以前の操作ボタンの表示名（テキスト・図形 など）から、プルダウンの値を引く。
 * 画面の準備（hydration）の前に選ぶと元に戻ることがあるため、選んだ操作が「いまの操作」に出るまで確かめる。
 */
export const PDF_FIX_OPERATION_BY_LABEL: Record<string, string> = {
  "選択・移動": "select",
  テキスト: "text",
  チェック: "checkbox",
  図形: "shape",
  白消し: "whiteout",
  "黒塗り（見た目だけ）": "blackout",
  手書き: "ink",
  画像: "image",
  印影: "stamp",
  ページ番号: "page-numbers",
  透かし: "watermark",
};

export async function choosePdfFixOperation(page: Page, label: string): Promise<void> {
  const value = PDF_FIX_OPERATION_BY_LABEL[label] ?? label;
  const select = page.getByTestId("pdf-fix-operation");
  await expect(async () => {
    await select.selectOption(value);
    await expect(select).toHaveValue(value, { timeout: 1_000 });
    // 画面が操作を受け取ったこと（React の状態に入ったこと）を、属性ではなく表示の変化で確かめる
    await expect(page.getByTestId("pdf-fix-current-operation")).toHaveAttribute("data-operation", value, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
