/**
 * PDF記入・注釈ツール（Phase 17）の回転・座標計算ヘルパー。
 *
 * 「回転中心とPDF出力時の座標計算が一致すること」（開発指示書）を満たすため、
 * 画面表示側（CSSのtransform: rotate()、要素の中心を軸に回転）とPDF書き出し側
 * （pdf-libのdrawRectangle/drawImage/drawEllipse）の両方から、このファイルの
 * 関数だけを使って計算する。ロジックを1箇所に集約することで、画面と出力の
 * ズレ（ドリフト）を防ぐ。
 *
 * pdf-lib（PDF-native座標系、原点は左下・上方向が正・反時計回りが正の角度）を
 * 基準に、すべて「度数法・反時計回りが正」の回転角で統一する。
 *
 * ---- pdf-libの回転の仕様（node_modules/pdf-lib調査済み） ----
 * - drawRectangle(x,y,width,height,rotate): (x,y)を中心にではなく、
 *   「(x,y)を原点として平行移動→そこを軸に回転→ローカル(0,0)-(width,height)の
 *   矩形を描画」という順で処理される。つまり回転の軸は矩形の左下角（回転前の
 *   ローカル原点）であり、矩形の中心ではない。
 * - drawImage(x,y,width,height,rotate)も同様に、(x,y)が回転の軸になる
 *   （単位正方形をwidth,heightでスケールしてから軸(x,y)を中心に回転）。
 * - drawEllipse(x,y,xScale,yScale,rotate)は、(x,y)自体が楕円の「中心座標」
 *   として定義されており、回転もその中心を軸に行われる（構造がそもそも
 *   中心基準なので補正不要）。
 * - drawLineにはrotateオプションが存在しない。直線は始点・終点の2点を
 *   直接その場で回転移動させ、回転後の座標をオブジェクトへ書き戻す方式を採る
 *   （手書き・移動と同じ「即座に座標へ反映する」設計）。
 *
 * このため、矩形・画像は「オブジェクトの中心を軸に回転させたい（UI上の
 * 直感的な回転操作）」という要求と、pdf-lib自体の「軸は左下角」という
 * 仕様との間にズレがあり、rectPivotForCenterRotation() で補正した上で
 * pdf-libへ渡す。画面側は、CSSのtransform-originが要素の中心（既定値）に
 * なることを利用し、回転前のx,y,width,heightで要素を配置してから
 * transform: rotate() を掛けるだけでよい（補正不要、常に中心軸で正しく回転する）。
 */

export interface Point {
  x: number;
  y: number;
}

/** 度数法→ラジアン */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * PDF-native座標系（反時計回りが正）で、点pをcenterを軸にangleDeg度回転させる。
 * ink・line図形のように「回転を即座に座標へ焼き込む」オブジェクト用。
 */
export function rotatePointAround(p: Point, center: Point, angleDeg: number): Point {
  const rad = degToRad(angleDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * 「回転前(rotation=0)の左下角(x,y)・幅width・高さheight」で定義された矩形/画像を、
 * その中心を軸にangleDeg度回転させてPDFへ描画するとき、pdf-libのdrawRectangle /
 * drawImageに渡すべき軸点(pivot x, pivot y)を計算する。
 *
 * pdf-libは「pivotを原点として回転してから、ローカル(0,0)-(width,height)の
 * 矩形/画像を描く」ため、中心を軸にした回転結果と一致させるには
 * pivot = center - Rot(angleDeg)・(width/2, height/2) を渡せばよい
 * （導出はこのファイル冒頭のコメント、および実装報告書を参照）。
 */
export function rectPivotForCenterRotation(
  x: number,
  y: number,
  width: number,
  height: number,
  angleDeg: number
): Point {
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  if (angleDeg % 360 === 0) return { x, y };
  const rad = degToRad(angleDeg);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = width / 2;
  const halfH = height / 2;
  const rotatedHalfX = halfW * cos - halfH * sin;
  const rotatedHalfY = halfW * sin + halfH * cos;
  return {
    x: centerX - rotatedHalfX,
    y: centerY - rotatedHalfY,
  };
}

// ---------------------------------------------------------------------------
// 工程4：ページの回転（/Rotate）・表示範囲（CropBox）を反映した座標の変換
// ---------------------------------------------------------------------------
//
// 画面は、pdf.js で「見た目のとおり」（ページの回転を反映し、CropBox の範囲だけ）にページを描き、
// 注釈もその見た目の座標（左下が原点・上が正、単位pt）で持つ。
// PDFに書き出すときは、ページ本来の座標（回転する前・MediaBox の原点）に直す必要がある。
// 直さないと、回転したページや、原点が(0,0)でないページで、注釈の位置・向きがずれる。

/** 見た目の座標(X, Y)を、ページ本来の座標へ移す行列 [a, b, c, d, e, f]（x' = aX + cY + e、y' = bX + dY + f） */
export type PdfMatrix = [number, number, number, number, number, number];

export function displayToPageMatrix(
  rotation: number,
  crop: { x: number; y: number; width: number; height: number }
): PdfMatrix {
  const r = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const { x: x0, y: y0, width: cw, height: ch } = crop;
  if (r === 90) return [0, 1, -1, 0, x0 + cw, y0];
  if (r === 180) return [-1, 0, 0, -1, x0 + cw, y0 + ch];
  if (r === 270) return [0, -1, 1, 0, x0, y0 + ch];
  return [1, 0, 0, 1, x0, y0];
}

export function isIdentityMatrix(m: PdfMatrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/**
 * 移動のとき、ずらす量(dx, dy)を、オブジェクトがページの中に収まる範囲に抑える（工程4）。
 * もともとページからはみ出している部分は、それ以上はみ出させない（ページの中へ戻す向きには動かせる）。
 */
export function clampMoveDelta(
  b: { minX: number; maxX: number; minY: number; maxY: number },
  dx: number,
  dy: number,
  page: { width: number; height: number }
): { dx: number; dy: number } {
  const lowX = Math.min(0, -b.minX);
  const highX = Math.max(0, page.width - b.maxX);
  const lowY = Math.min(0, -b.minY);
  const highY = Math.max(0, page.height - b.maxY);
  return { dx: Math.min(highX, Math.max(lowX, dx)), dy: Math.min(highY, Math.max(lowY, dy)) };
}
