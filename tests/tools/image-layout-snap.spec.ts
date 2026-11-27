import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";
import { snapLines, snapResizeEdges, toPlacement } from "../../src/lib/image-layout/snap";

/**
 * 画像ホワイトボードの吸い付き・整列（2026-11-27）。
 * 動画ホワイトボードと同じく、ドラッグでキャンバスの端に吸い付き、9か所の整列ボタン・いっぱいにするボタンが使える。
 */

test("snap: 左上の位置を中心の位置に変換できる", () => {
  expect(toPlacement({ x: 10, y: 20, width: 100, height: 50, rotation: 0 })).toEqual({ cx: 60, cy: 45, w: 100, h: 50, rotation: 0 });
});

test("snap: 大きさ変更で、動かしている辺だけがキャンバスの端に吸い付く", () => {
  const lines = snapLines([], { width: 1000, height: 800 });
  // 右下の角を動かして右端の近く（995）まで → 右端1000にぴったり。下辺（700）は遠いのでそのまま
  const r = snapResizeEdges({ x: 100, y: 100, width: 895, height: 600, rotation: 0 }, "se", lines, 8, 20);
  expect(r).toMatchObject({ x: 100, y: 100, width: 900, height: 600 });
  expect(r.guides).toEqual({ x: [1000], y: [] });
  // 左上の角を左端の近く（4）まで → 左端0にぴったり、右端の位置は変わらない
  const l = snapResizeEdges({ x: 4, y: 5, width: 296, height: 295, rotation: 0 }, "nw", lines, 8, 20);
  expect(l).toMatchObject({ x: 0, y: 0, width: 300, height: 300 });
  // 回転しているときは吸い付かない
  const rot = snapResizeEdges({ x: 100, y: 100, width: 895, height: 600, rotation: 30 }, "se", lines, 8, 20);
  expect(rot.width).toBe(895);
});

test("image-layout: 整列ボタンで端・真ん中に寄せられ、ドラッグで端に吸い付いて目安の線が出る（Altキーで吸い付かない）", async ({ page }) => {
  await page.goto("/tools/image-layout");
  await uploadFixture(page, [fixtures.png]);
  const item = page.getByTestId("whiteboard-image-item").first();
  const canvas = page.getByTestId("tool-preview");
  await item.scrollIntoViewIfNeeded();

  // 選ぶと整列パネルが出る（空いているところを押すと選択が外れて消える）
  const cv = (await canvas.boundingBox())!;
  const b0 = (await item.boundingBox())!;
  await page.mouse.click(cv.x + cv.width - 10, b0.y + b0.height / 2);
  await expect(page.getByTestId("whiteboard-align")).toHaveCount(0);
  await page.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2);
  await expect(page.getByTestId("whiteboard-align")).toBeVisible();
  await expect(page.getByTestId("whiteboard-align-top-left")).toBeVisible();

  // 左上へ寄せる
  await page.getByTestId("whiteboard-align-top-left").click();
  let c = (await canvas.boundingBox())!;
  let b = (await item.boundingBox())!;
  expect(Math.abs(b.x - c.x)).toBeLessThan(2.5);
  expect(Math.abs(b.y - c.y)).toBeLessThan(2.5);

  // 真ん中へ寄せる
  await page.getByTestId("whiteboard-align-center").click();
  b = (await item.boundingBox())!;
  expect(Math.abs(b.x + b.width / 2 - (c.x + c.width / 2))).toBeLessThan(2.5);
  expect(Math.abs(b.y + b.height / 2 - (c.y + c.height / 2))).toBeLessThan(2.5);

  // 横幅いっぱい
  await page.getByTestId("whiteboard-fill-width").click();
  b = (await item.boundingBox())!;
  expect(Math.abs(b.width - c.width)).toBeLessThan(3);

  // 元の大きさに戻すため、ページを読み直してやり直す
  await page.reload();
  await uploadFixture(page, [fixtures.png]);
  const it2 = page.getByTestId("whiteboard-image-item").first();
  await it2.scrollIntoViewIfNeeded();
  c = (await canvas.boundingBox())!;
  b = (await it2.boundingBox())!;
  // 左端から5px内側に来るようにドラッグ → 左端にぴったり吸い付き、線が出る
  const sx = b.x + 20;
  const sy = b.y + b.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + (c.x + 5 - b.x), sy + 3, { steps: 8 });
  await expect(page.getByTestId("whiteboard-guide").first()).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("whiteboard-guide")).toHaveCount(0);
  b = (await it2.boundingBox())!;
  expect(Math.abs(b.x - c.x)).toBeLessThan(1.5);

  // Altキーを押しながらだと、吸い付かずに5px内側で止まる
  const sx2 = b.x + 20;
  await page.keyboard.down("Alt");
  await page.mouse.move(sx2, sy);
  await page.mouse.down();
  await page.mouse.move(sx2 + 5, sy, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  b = (await it2.boundingBox())!;
  expect(b.x - c.x).toBeGreaterThan(3);
});
