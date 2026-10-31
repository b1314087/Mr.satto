import { test, expect } from "@playwright/test";
import { OCR_MAX_PIXELS, OCR_STRIP_HEIGHT, planOcr, planStrips } from "@/lib/accounting/receipt-image-plan";

/** OCR前の画像の倍率・切り分け位置を決める関数の確認（工程9）。ブラウザは使わない。 */

test("receipt-image-plan: 標準的な大きさの画像は、そのまま（倍率1）で切り分けない", () => {
  expect(planOcr(1200, 1600)).toEqual({ scale: 1, stripHeight: null });
  expect(planOcr(1000, 1000)).toEqual({ scale: 1, stripHeight: null });
});

test("receipt-image-plan: 小さい画像は、長辺が1000pxになるまで拡大し、最大2倍まで", () => {
  expect(planOcr(500, 800).scale).toBeCloseTo(1.25, 5);
  expect(planOcr(350, 600).scale).toBeCloseTo(1000 / 600, 5);
  expect(planOcr(200, 300).scale).toBe(2);
  expect(planOcr(350, 600).stripHeight).toBeNull();
});

test("receipt-image-plan: 大きい画像は、画素数と長辺の上限に収まるよう縮小する（拡大はしない）", () => {
  for (const [w, h] of [[4000, 3000], [3000, 4000], [6000, 6000], [7000, 5000], [2000, 1500]]) {
    const p = planOcr(w, h);
    expect(p.scale).toBeLessThanOrEqual(1);
    expect(w * p.scale * h * p.scale).toBeLessThanOrEqual(OCR_MAX_PIXELS * 1.001);
    expect(Math.max(w, h) * p.scale).toBeLessThanOrEqual(4000.001);
  }
});

test("receipt-image-plan: 細長く縮小すると文字が潰れる画像は、倍率を保って縦に切り分ける", () => {
  const p = planOcr(400, 9994);
  expect(p.stripHeight).toBe(OCR_STRIP_HEIGHT);
  expect(p.scale).toBe(1);
  // 幅が2000pxを超えるときは、幅だけを基準に縮小する
  const wide = planOcr(2400, 12000);
  expect(wide.stripHeight).toBe(OCR_STRIP_HEIGHT);
  expect(wide.scale).toBeCloseTo(2000 / 2400, 5);
});

test("receipt-image-plan: 少し縦長なだけの画像や、縮小がわずかな画像は切り分けない", () => {
  expect(planOcr(800, 3000).stripHeight).toBeNull();
  expect(planOcr(1000, 3900).stripHeight).toBeNull();
});

test("receipt-image-plan: 不正な大きさでも例外を出さない", () => {
  expect(planOcr(0, 100)).toEqual({ scale: 1, stripHeight: null });
  expect(planOcr(100, -1)).toEqual({ scale: 1, stripHeight: null });
});

test("receipt-image-plan: 切り分けは隙間なく重ならず、全体を覆う", () => {
  for (const h of [3001, 6000, 9994, 12345]) {
    const strips = planStrips(h, 3000, null, 250);
    expect(strips[0].top).toBe(0);
    for (let i = 1; i < strips.length; i++) expect(strips[i].top).toBe(strips[i - 1].top + strips[i - 1].height);
    const last = strips[strips.length - 1];
    expect(last.top + last.height).toBe(h);
    expect(strips.length).toBe(Math.ceil(h / 3000));
  }
  expect(planStrips(2000, 3000, null, 250)).toEqual([{ top: 0, height: 2000 }]);
  expect(planStrips(0, 3000, null, 250)).toEqual([]);
});

test("receipt-image-plan: 切り位置は、近くの文字が少ない行（空白）を選ぶ", () => {
  // 高さ6000、行は1px=1行。本来の切り位置は3000。2900〜3100 に文字が詰まり、2800 だけ空白。
  const activity: number[] = Array.from({ length: 6000 }, (_, i) => (i >= 2750 && i <= 3250 ? 50 : 40));
  activity[2800] = 0;
  const strips = planStrips(6000, 3000, activity, 250);
  expect(strips).toHaveLength(2);
  expect(strips[1].top).toBeGreaterThanOrEqual(2799);
  expect(strips[1].top).toBeLessThanOrEqual(2802);
});

test("receipt-image-plan: 探す範囲の外にある空白は選ばない", () => {
  const activity: number[] = Array.from({ length: 6000 }, () => 40);
  activity[1000] = 0;
  const strips = planStrips(6000, 3000, activity, 250);
  expect(strips[1].top).toBeGreaterThan(2700);
  expect(strips[1].top).toBeLessThan(3300);
});
