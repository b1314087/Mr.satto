import { expect, type Page } from "@playwright/test";

/**
 * PDF修正の「やりたい操作」のボタンで、操作を選ぶ（新工程1。UI・UX改善でプルダウンからアイコン付きのボタンに変更）。
 * 以前の操作ボタンの表示名（テキスト・図形 など）から、操作の値を引く。
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
  const group = page.getByTestId("pdf-fix-operation");
  await expect(async () => {
    await page.getByTestId(`pdf-fix-op-${value}`).click();
    await expect(group).toHaveAttribute("data-value", value, { timeout: 1_000 });
    // 画面が操作を受け取ったこと（React の状態に入ったこと）を、属性ではなく表示の変化で確かめる
    await expect(page.getByTestId("pdf-fix-current-operation")).toHaveAttribute("data-operation", value, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * PDF修正のプレビュー（キャンバス）の、指定した位置を押す。
 * 「やりたい操作」のボタンの帯は、プレビューの上端にくっつく（sticky）ため、キャンバスの上端を画面の上端に合わせて
 * スクロールすると、押したい位置が帯の下に隠れることがある（画面の読み込み中など、スクロールの位置しだいで起きる）。
 * 押したい位置が画面（とプレビューの枠）の真ん中に来るようにスクロールしてから押す。
 */
export async function clickPdfCanvas(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('[data-testid="pdf-annotate-canvas"]');
  await expect(canvas).toBeVisible();
  // キャンバスはプレビューの列（PCでは、それ自体がスクロールする枠）の中にある。押したい位置に小さな目印を置き、
  // 目印が画面（と枠）の真ん中に来るように、画面と枠の両方をスクロールする
  await canvas.evaluate(
    (el, p) => {
      const mark = document.createElement("div");
      mark.style.cssText = `position:absolute;left:${p.x}px;top:${p.y}px;width:1px;height:1px;pointer-events:none`;
      el.appendChild(mark);
      mark.scrollIntoView({ block: "center", inline: "nearest" });
      mark.remove();
    },
    { x, y }
  );
  // locator.click は押す前に要素を自動でスクロールし直す（キャンバスの上端を合わせ直す）ため、測った位置をマウスで押す
  const box = await canvas.boundingBox();
  if (!box) throw new Error("PDFのプレビューが見つかりません");
  await page.mouse.click(box.x + x, box.y + y);
}
