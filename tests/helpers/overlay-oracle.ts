/**
 * ページ番号・透かしの配置テスト用の、仕様から独立した期待値の計算（工程9）。
 *
 * アプリ本体（src/lib/pdf/overlay-layout.ts）の関数は呼ばない。表示上の座標・回転後の文字の枠・
 * 収まる最大の大きさを、ここで別の方法（回転行列・四隅の計算・二分探索）で求める。
 * 単体テスト（pdf-overlay-layout.spec.ts）と出力PDFのテスト（pdf-overlay-quality.spec.ts）で共用する。
 */

export type Pt = [number, number];

/** 比較で許す誤差（pt）。浮動小数点の丸めだけを許容する */
export const LAYOUT_TOL = 1e-6;

/**
 * ページ本来の座標(x, y) → 表示上の座標(u, v)。/Rotate = rot（時計回り）で表示したときの座標。
 * ページの四隅を回転行列で回し、回したあとの全体の左下が原点になるようにそろえて求める。
 */
export function makeToDisplay(width: number, height: number, rot: number) {
  const th = (-rot * Math.PI) / 180; // 時計回りに rot 度 = 反時計回りに -rot 度
  const turn = ([x, y]: Pt): Pt => [x * Math.cos(th) - y * Math.sin(th), x * Math.sin(th) + y * Math.cos(th)];
  const corners = ([[0, 0], [width, 0], [width, height], [0, height]] as Pt[]).map(turn);
  const ox = Math.min(...corners.map((c) => c[0]));
  const oy = Math.min(...corners.map((c) => c[1]));
  return {
    point: (x: number, y: number): Pt => {
      const [a, b] = turn([x, y]);
      return [a - ox, b - oy];
    },
    displayWidth: Math.max(...corners.map((c) => c[0])) - ox,
    displayHeight: Math.max(...corners.map((c) => c[1])) - oy,
  };
}

/** 文字の枠（原点＝文字列の左端・ベースライン、幅×［下 descent 〜 上 ascent］）を angle度（反時計回り）回して pivot に置いたときの四隅 */
export function boxCorners(pivot: Pt, angleDeg: number, width: number, ascent: number, descent: number): Pt[] {
  const rad = (angleDeg * Math.PI) / 180;
  return ([[0, -descent], [width, -descent], [width, ascent], [0, ascent]] as Pt[]).map(([x, y]) => [
    pivot[0] + x * Math.cos(rad) - y * Math.sin(rad),
    pivot[1] + x * Math.sin(rad) + y * Math.cos(rad),
  ]);
}

export function extentOf(pts: Pt[]) {
  return {
    minX: Math.min(...pts.map((p) => p[0])),
    maxX: Math.max(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
}

/** 文字の測定値（ある大きさで測った値） */
export interface GlyphMetrics {
  width: number;
  ascent: number;
  descent: number;
}

/**
 * 回したあとの文字の枠が、表示上のページ（Wd × Hd）の大きさに収まる最大の文字サイズ。
 * requested のままで収まるなら requested を返す。大きさを変えながら二分探索で求める。
 */
export function maxFitFontSize(
  requested: number,
  metrics: GlyphMetrics,
  angleDeg: number,
  displayWidth: number,
  displayHeight: number
): number {
  const fitsAt = (size: number) => {
    const k = size / requested;
    const e = extentOf(boxCorners([0, 0], angleDeg, metrics.width * k, metrics.ascent * k, metrics.descent * k));
    return e.maxX - e.minX <= displayWidth + LAYOUT_TOL && e.maxY - e.minY <= displayHeight + LAYOUT_TOL;
  };
  if (fitsAt(requested)) return requested;
  let lo = 0;
  let hi = requested;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fitsAt(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export type OracleWatermarkPosition = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** 透かしの仕様値（overlay-layout.ts から読まず、ここに書き直したもの） */
export const SPEC_WATERMARK_MARGIN = 32;
export const SPEC_MIN_WATERMARK_FONT_SIZE = 6;

export interface ExpectedWatermark {
  /** 6ptまで縮めても収まらないとき false（出力はエラーになる） */
  fits: boolean;
  /** none: 従来どおり／moved: 位置だけ調整／shrunk: 大きさも縮めた */
  adjustment: "none" | "moved" | "shrunk";
  fontSize: number;
  /** 表示上の、文字列の左端・ベースライン（表示されたページの左下が原点） */
  pivot: Pt;
}

/**
 * 透かしの期待される位置と大きさ（表示上の座標）。仕様:
 *  1. 従来の配置（余白32pt・文字列の左端ベースライン基準）で、回したあとの文字全体がページ内に収まるなら、そのまま。
 *  2. 収まらないなら、大きさは変えずに、回したあとの文字の枠を指定位置（中央・四隅）へ寄せる（四隅は余白32pt。空けられなければ詰める）。
 *  3. 枠がページより大きいときだけ、収まる最大の大きさ（0.01pt単位）に縮める。6ptより小さくなるなら収められない。
 */
export function expectedWatermarkPlacement(input: {
  pageWidth: number;
  pageHeight: number;
  pageRotation: number;
  position: OracleWatermarkPosition;
  fontSize: number;
  angleDeg: number;
  /** fontSize で測った値 */
  metrics: GlyphMetrics;
}): ExpectedWatermark {
  const { displayWidth: Wd, displayHeight: Hd } = makeToDisplay(input.pageWidth, input.pageHeight, input.pageRotation);
  const { width, ascent, descent } = input.metrics;
  const height = ascent + descent;
  const M = SPEC_WATERMARK_MARGIN;
  const anchor: Pt = {
    center: [(Wd - width) / 2, (Hd - height) / 2],
    "top-left": [M, Hd - M - height],
    "top-right": [Wd - M - width, Hd - M - height],
    "bottom-left": [M, M],
    "bottom-right": [Wd - M - width, M],
  }[input.position] as Pt;

  const anchored = extentOf(boxCorners(anchor, input.angleDeg, width, ascent, descent));
  const eps = LAYOUT_TOL;
  if (anchored.minX >= -eps && anchored.maxX <= Wd + eps && anchored.minY >= -eps && anchored.maxY <= Hd + eps) {
    return { fits: true, adjustment: "none", fontSize: input.fontSize, pivot: anchor };
  }

  const maxFit = maxFitFontSize(input.fontSize, input.metrics, input.angleDeg, Wd, Hd);
  const shrunk = maxFit < input.fontSize;
  const fontSize = shrunk ? Math.floor(maxFit * 100) / 100 : input.fontSize;
  if (shrunk && fontSize < SPEC_MIN_WATERMARK_FONT_SIZE) {
    return { fits: false, adjustment: "shrunk", fontSize, pivot: anchor };
  }
  const k = fontSize / input.fontSize;
  const e = extentOf(boxCorners([0, 0], input.angleDeg, width * k, ascent * k, descent * k));
  const w = e.maxX - e.minX;
  const h = e.maxY - e.minY;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const p = input.position;
  const boxX = clamp(p.endsWith("left") ? M : p.endsWith("right") ? Wd - M - w : (Wd - w) / 2, Wd - w);
  const boxY = clamp(p.startsWith("bottom") ? M : p.startsWith("top") ? Hd - M - h : (Hd - h) / 2, Hd - h);
  return { fits: true, adjustment: shrunk ? "shrunk" : "moved", fontSize, pivot: [boxX - e.minX, boxY - e.minY] };
}
