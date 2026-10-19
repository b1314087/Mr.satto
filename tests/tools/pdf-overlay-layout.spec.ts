import { test, expect } from "@playwright/test";
import { getJapaneseMeasure, getHelveticaMeasure } from "../helpers/pdf-page-quality";
import { LAYOUT_TOL, boxCorners, extentOf, makeToDisplay, maxFitFontSize, type Pt } from "../helpers/overlay-oracle";
import {
  MIN_WATERMARK_FONT_SIZE,
  pageNumberLayout,
  watermarkLayout,
  type PageNumberPosition,
  type WatermarkPosition,
} from "@/lib/pdf/overlay-layout";

/**
 * ページ番号・透かしの配置計算（src/lib/pdf/overlay-layout.ts）の網羅テスト（工程9）。
 *
 * ブラウザを使わず、ページの大きさ・/Rotate・位置・文字・大きさ・角度の組み合わせを広く試し、
 * 計算結果を「表示されたページ」の上で確かめる。期待値は、実装の計算を呼ばずに、この
 * ファイルで次の仕様から独立して求める。
 *   - 表示上の座標: /Rotate（時計回り）の回転行列でページの四隅を回し、左下が原点になるよう
 *     そろえて求める（実装の場合分けとは別の方法）。
 *   - 回転後の文字の枠: 文字の枠（幅×［ベースラインの下 descent 〜 上 ascent］）の四隅を回して求める。
 *   - 収まる最大の大きさ: 大きさを変えながら二分探索で求める（実装の式とは別の方法）。
 * 余白（ページ番号24pt・透かし32pt）や色などの仕様値は、overlay-layout.ts から読まず書き直している。
 */

const PN_MARGIN = 24;
const PN_BASELINE_Y = PN_MARGIN * 0.6;
const WM_MARGIN = 32;
const TOL = LAYOUT_TOL;

/**
 * 組み合わせが数千通りあるため、1件ごとに expect を呼ぶと非常に遅い。条件が崩れた組み合わせだけを
 * 記録しておき、最後にまとめて expect で報告する（失敗した組み合わせと値は、メッセージに残る）。
 */
function makeChecker() {
  const failures: string[] = [];
  return {
    failures,
    ok(cond: boolean, message: string) {
      if (!cond && failures.length < 30) failures.push(message);
    },
    near(actual: number, expected: number, tol: number, message: string) {
      if (!(Math.abs(actual - expected) <= tol) && failures.length < 30) {
        failures.push(`${message}（実測 ${actual} / 期待 ${expected}）`);
      }
    },
  };
}

const PAGES: { name: string; width: number; height: number }[] = [
  { name: "A4", width: 595.28, height: 841.89 },
  { name: "A5", width: 419.53, height: 595.28 },
  { name: "A6", width: 297.64, height: 419.53 },
  { name: "Letter", width: 612, height: 792 },
  { name: "300x400", width: 300, height: 400 },
  { name: "200x300", width: 200, height: 300 },
  { name: "120x200", width: 120, height: 200 },
  { name: "A4横", width: 841.89, height: 595.28 },
  { name: "400x300", width: 400, height: 300 },
];
const ROTATIONS = [0, 90, 180, 270];

test.describe("overlay-layout: ページ番号の配置（表示されたページ基準）", () => {
  const POSITIONS: PageNumberPosition[] = ["bottom-left", "bottom-center", "bottom-right"];
  const LABELS = ["1", "12", "99999", "100001"];
  const SIZES = [6, 10, 24, 72];

  test("すべてのページサイズ・/Rotate・位置で、表示上は下端の余白24pt・読める向きの位置になる", async () => {
    const helvetica = await getHelveticaMeasure();
    const c = makeChecker();
    let checked = 0;
    for (const page of PAGES) {
      for (const rot of ROTATIONS) {
        const display = makeToDisplay(page.width, page.height, rot);
        for (const position of POSITIONS) {
          for (const label of LABELS) {
            for (const size of SIZES) {
              const textWidth = helvetica.widthOfTextAtSize(label, size);
              const out = pageNumberLayout(page.width, page.height, rot, textWidth, position);
              const where = `${page.name} /Rotate=${rot} ${position} "${label}" ${size}pt`;

              const [u, v] = display.point(out.x, out.y);
              const expectedU =
                position === "bottom-left"
                  ? PN_MARGIN
                  : position === "bottom-right"
                    ? display.displayWidth - PN_MARGIN - textWidth
                    : (display.displayWidth - textWidth) / 2;
              c.near(u, expectedU, TOL, `${where}: 表示上のx`);
              c.near(v, PN_BASELINE_Y, TOL, `${where}: 表示上のy`);
              // 表示上の文字の向き（反時計回り）= ページ本来の角度 - /Rotate。0なら、読める向き
              const displayAngle = (((out.angle - rot) % 360) + 540) % 360 - 180;
              c.near(displayAngle, 0, TOL, `${where}: 表示上の向き`);
              checked++;
            }
          }
        }
      }
    }
    expect(c.failures, "条件を満たさなかった組み合わせ").toEqual([]);
    expect(checked).toBe(PAGES.length * ROTATIONS.length * POSITIONS.length * LABELS.length * SIZES.length);
  });

  test("/Rotate がないページ・90の倍数でない値のページは、従来どおり（回転0・ページ本来の座標のまま）", async () => {
    const helvetica = await getHelveticaMeasure();
    const textWidth = helvetica.widthOfTextAtSize("12", 10);
    for (const rot of [0, 45, 100, -1, NaN]) {
      const out = pageNumberLayout(595.28, 841.89, rot, textWidth, "bottom-right");
      expect(out.x).toBeCloseTo(595.28 - PN_MARGIN - textWidth, 9);
      expect(out.y).toBeCloseTo(PN_BASELINE_Y, 9);
      expect(out.angle).toBe(0);
    }
    // 負の値や360を超える値は、同じ向きの 0/90/180/270 として扱う
    const a = pageNumberLayout(595.28, 841.89, -90, textWidth, "bottom-left");
    const b = pageNumberLayout(595.28, 841.89, 270, textWidth, "bottom-left");
    const c = pageNumberLayout(595.28, 841.89, 630, textWidth, "bottom-left");
    expect(a).toEqual(b);
    expect(c).toEqual(b);
  });
});

test.describe("overlay-layout: 透かしの配置（向き・位置・収まり）", () => {
  const POSITIONS: WatermarkPosition[] = ["center", "top-left", "top-right", "bottom-left", "bottom-right"];
  const TEXTS = ["CONFIDENTIAL", "社外秘", "CONFIDENTIAL - 社外秘 - DO NOT COPY - 複製禁止"];
  const SIZES = [12, 48, 120];
  const ANGLES = [-90, -45, 0, 30, 90];

  test("すべての組み合わせで、文字全体がページ内に収まり、指定の向き・位置になる（収まらない場合の挙動も仕様どおり）", async () => {
    test.setTimeout(180_000);
    const jp = await getJapaneseMeasure();
    const counts = { none: 0, moved: 0, shrunk: 0, notFit: 0 };
    const c = makeChecker();

    for (const page of PAGES) {
      for (const rot of ROTATIONS) {
        const display = makeToDisplay(page.width, page.height, rot);
        const Wd = display.displayWidth;
        const Hd = display.displayHeight;
        for (const position of POSITIONS) {
          for (const text of TEXTS) {
            for (const size of SIZES) {
              for (const angle of ANGLES) {
                const width = jp.widthOfTextAtSize(text, size);
                const height = jp.heightAtSize(size);
                const ascent = jp.heightAtSize(size, { descender: false });
                const descent = height - ascent;
                const where = `${page.name} /Rotate=${rot} ${position} 「${text.slice(0, 12)}」 ${size}pt ${angle}°`;

                const out = watermarkLayout({
                  pageWidth: page.width,
                  pageHeight: page.height,
                  pageRotation: rot,
                  position,
                  fontSize: size,
                  rotation: angle,
                  textWidth: width,
                  textHeight: height,
                  textDescent: descent,
                });
                c.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.fontSize), `${where}: 数値でない`);

                // --- 仕様から求めた期待値 ---
                // 従来の配置（表示上の、文字列の左端・ベースライン）
                const anchor: Pt = {
                  center: [(Wd - width) / 2, (Hd - height) / 2],
                  "top-left": [WM_MARGIN, Hd - WM_MARGIN - height],
                  "top-right": [Wd - WM_MARGIN - width, Hd - WM_MARGIN - height],
                  "bottom-left": [WM_MARGIN, WM_MARGIN],
                  "bottom-right": [Wd - WM_MARGIN - width, WM_MARGIN],
                }[position] as Pt;
                const anchoredBox = extentOf(boxCorners(anchor, angle, width, ascent, descent));
                const anchoredFits =
                  anchoredBox.minX >= -TOL && anchoredBox.maxX <= Wd + TOL && anchoredBox.minY >= -TOL && anchoredBox.maxY <= Hd + TOL;

                // 回したあとの文字の枠の大きさが、ページに収まる最大の大きさ（二分探索）
                const metrics = { width, ascent, descent };
                const maxFitSize = maxFitFontSize(size, metrics, angle, Wd, Hd);
                // 下限（6pt）の境界に近い組み合わせは、0.01pt単位の切り捨てで判定が分かれるため対象外にする
                if (Math.abs(maxFitSize - MIN_WATERMARK_FONT_SIZE) < 0.05 && maxFitSize < size) continue;

                // --- 検証 ---
                if (anchoredFits) {
                  // 収まるなら、大きさ・角度・位置は従来どおり
                  c.ok(out.adjustment === "none", `${where}: 収まるので変更なしのはず（${out.adjustment}）`);
                  c.ok(out.fontSize === size, `${where}: 大きさは指定どおりのはず（${out.fontSize}）`);
                  const [u, v] = display.point(out.x, out.y);
                  c.near(u, anchor[0], TOL, `${where}: 従来の配置の表示上のx`);
                  c.near(v, anchor[1], TOL, `${where}: 従来の配置の表示上のy`);
                  counts.none++;
                } else if (maxFitSize < MIN_WATERMARK_FONT_SIZE) {
                  c.ok(out.fits === false, `${where}: 6ptまで縮めても収まらないので fits=false のはず`);
                  counts.notFit++;
                  continue;
                } else {
                  c.ok(out.fits === true, `${where}: 収められるので fits=true のはず（最大 ${maxFitSize}pt）`);
                  if (maxFitSize === size) {
                    c.ok(out.adjustment === "moved", `${where}: 大きさは変えず位置だけ調整のはず（${out.adjustment}）`);
                    c.ok(out.fontSize === size, `${where}: 大きさは指定どおりのはず（${out.fontSize}）`);
                    counts.moved++;
                  } else {
                    c.ok(out.adjustment === "shrunk", `${where}: 大きさも縮めるはず（${out.adjustment}）`);
                    c.ok(out.fontSize <= maxFitSize + TOL, `${where}: 収まる最大の大きさ ${maxFitSize} 以下のはず（${out.fontSize}）`);
                    c.ok(out.fontSize > maxFitSize - 0.011, `${where}: 収まる最大の大きさ ${maxFitSize} に近いはず（${out.fontSize}）`);
                    c.ok(out.fontSize <= size, `${where}: 指定より大きくしない`);
                    counts.shrunk++;
                  }
                }

                // 文字全体がページ内に収まっている（表示上の座標で、四隅を確認）
                const k = out.fontSize / size;
                const [pu, pv] = display.point(out.x, out.y);
                const displayAngle = out.angle - rot; // 反時計回り（表示上）
                const box = extentOf(boxCorners([pu, pv], displayAngle, width * k, ascent * k, descent * k));
                c.ok(box.minX >= -TOL, `${where}: 枠の左端がページ内のはず（${box.minX}）`);
                c.ok(box.maxX <= Wd + TOL, `${where}: 枠の右端がページ内のはず（${box.maxX} / ${Wd}）`);
                c.ok(box.minY >= -TOL, `${where}: 枠の下端がページ内のはず（${box.minY}）`);
                c.ok(box.maxY <= Hd + TOL, `${where}: 枠の上端がページ内のはず（${box.maxY} / ${Hd}）`);

                // 指定した回転角度は、表示上の向きとして保たれる（ページの /Rotate は含まれない）
                const angleGap = Math.abs((((displayAngle - angle) % 360) + 540) % 360 - 180);
                c.ok(angleGap < TOL, `${where}: 表示上の向きが指定どおりのはず（${displayAngle}° / 指定 ${angle}°）`);

                // 位置を調整・縮小した場合は、回したあとの枠を指定の位置に寄せる
                if (out.adjustment !== "none") {
                  const w = box.maxX - box.minX;
                  const h = box.maxY - box.minY;
                  const left = position.endsWith("left");
                  const right = position.endsWith("right");
                  const top = position.startsWith("top");
                  const bottom = position.startsWith("bottom");
                  if (left) c.near(box.minX, Math.min(WM_MARGIN, Wd - w), 1e-5, `${where}: 左の余白`);
                  else if (right) c.near(Wd - box.maxX, Math.min(WM_MARGIN, Wd - w), 1e-5, `${where}: 右の余白`);
                  else c.near((box.minX + box.maxX) / 2, Wd / 2, 1e-5, `${where}: 左右の中央`);
                  if (bottom) c.near(box.minY, Math.min(WM_MARGIN, Hd - h), 1e-5, `${where}: 下の余白`);
                  else if (top) c.near(Hd - box.maxY, Math.min(WM_MARGIN, Hd - h), 1e-5, `${where}: 上の余白`);
                  else c.near((box.minY + box.maxY) / 2, Hd / 2, 1e-5, `${where}: 上下の中央`);
                }
              }
            }
          }
        }
      }
    }
    expect(c.failures, "条件を満たさなかった組み合わせ").toEqual([]);
    // 4つの区分がすべて試されていること（テストが一部の経路しか通らない状態を防ぐ）
    expect(counts.none, "従来どおりの配置を試した数").toBeGreaterThan(500);
    expect(counts.moved, "位置だけ調整した数").toBeGreaterThan(200);
    expect(counts.shrunk, "縮めた数").toBeGreaterThan(200);
    expect(counts.notFit, "収められなかった数").toBeGreaterThan(10);
  });

  test("通常のページ（A4・A5・Letter）の既定設定（CONFIDENTIAL・中央・48pt・-45°）は、従来と同じ配置で、大きさも変わらない", async () => {
    const jp = await getJapaneseMeasure();
    const width = jp.widthOfTextAtSize("CONFIDENTIAL", 48);
    const height = jp.heightAtSize(48);
    const descent = height - jp.heightAtSize(48, { descender: false });
    for (const page of PAGES.filter((p) => ["A4", "A5", "Letter"].includes(p.name))) {
      const out = watermarkLayout({
        pageWidth: page.width, pageHeight: page.height, pageRotation: 0, position: "center",
        fontSize: 48, rotation: -45, textWidth: width, textHeight: height, textDescent: descent,
      });
      expect(out.adjustment, page.name).toBe("none");
      expect(out.fontSize, page.name).toBe(48);
      expect(out.angle, page.name).toBe(-45);
      expect(out.x, page.name).toBeCloseTo((page.width - width) / 2, 9);
      expect(out.y, page.name).toBeCloseTo((page.height - height) / 2, 9);
    }
  });

  test("小さいページ（A6・300x400）の既定設定は、大きさ・角度はそのままで位置だけ調整され、ページ内に収まる", async () => {
    const jp = await getJapaneseMeasure();
    const width = jp.widthOfTextAtSize("CONFIDENTIAL", 48);
    const height = jp.heightAtSize(48);
    const descent = height - jp.heightAtSize(48, { descender: false });
    for (const page of PAGES.filter((p) => ["A6", "300x400"].includes(p.name))) {
      const out = watermarkLayout({
        pageWidth: page.width, pageHeight: page.height, pageRotation: 0, position: "center",
        fontSize: 48, rotation: -45, textWidth: width, textHeight: height, textDescent: descent,
      });
      expect(out.adjustment, page.name).toBe("moved");
      expect(out.fontSize, page.name).toBe(48);
      expect(out.angle, page.name).toBe(-45);
    }
  });

  test("極端に小さいページ（30x30）では、収められないため fits=false になる", async () => {
    const jp = await getJapaneseMeasure();
    const width = jp.widthOfTextAtSize("CONFIDENTIAL", 48);
    const height = jp.heightAtSize(48);
    const descent = height - jp.heightAtSize(48, { descender: false });
    const out = watermarkLayout({
      pageWidth: 30, pageHeight: 30, pageRotation: 0, position: "center",
      fontSize: 48, rotation: -45, textWidth: width, textHeight: height, textDescent: descent,
    });
    expect(out.fits).toBe(false);
    expect(out.fontSize).toBeLessThan(MIN_WATERMARK_FONT_SIZE);
  });
});
