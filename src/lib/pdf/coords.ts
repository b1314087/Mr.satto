/**
 * PDFページ座標 ⇔ 画面(Canvas)ピクセル座標の共通変換ヘルパー（Phase 18）。
 *
 * PDFページ座標系: 原点は左下、上方向がy正（pdfjs-dist / pdf-lib と同じ）。
 * 画面(Canvas)座標系: 原点は左上、下方向がy正（通常のCSS/DOM座標）。
 * scale は「PDF 1pt あたりの画面ピクセル数」（現在の表示倍率・DPRを反映した
 * ページ描画スケール）を表す。
 *
 * この変換式自体は Phase 15 の PDF記入・注釈ツール
 * （src/components/tools/implementations/pdf-fill-annotate-tool.tsx）で
 * 検証済みのものと同一の考え方だが、そちらはコンポーネント内ローカル関数として
 * 実装されているため、ツールをまたいで再利用するために本モジュールへ
 * 切り出した（Phase 18: 記入されたPDF→Excel テンプレートモードの、
 * テンプレート編集キャンバス上での入力枠の描画・移動・リサイズに使用する）。
 * 既存のPDF記入・注釈ツール自体は、動作中のツールへの不要な変更を避けるため
 * 今回は変更していない。
 */

export function pdfToScreenX(pdfX: number, scale: number): number {
  return pdfX * scale;
}

export function pdfToScreenY(pdfY: number, height: number, pageHeight: number, scale: number): number {
  return (pageHeight - pdfY - height) * scale;
}

export function screenToPdfX(screenX: number, scale: number): number {
  return screenX / scale;
}

export function screenToPdfY(screenY: number, height: number, pageHeight: number, scale: number): number {
  return pageHeight - screenY / scale - height;
}

/** 値を[min, max]の範囲へ収める（枠のドラッグ・リサイズがページ範囲外へ大きく外れないようにする） */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Phase 18.2 A-3〜A-8: ズーム操作で入力枠がPDF上の位置からずれる不具合の修正。
 *
 * 上記の pdfToScreenX/Y・screenToPdfX/Y は「scale（＝PDF 1ptあたりの画面px数）
 * を毎回自分で計算し、自分で pageHeight - y - height のような式を組み立てる」
 * 独自実装であり、開発指示書A-6が明示的に避けるよう求めているパターン
 * （「単純な x/zoom のような独自計算だけに依存しないこと」）。
 * 呼び出し側（テンプレート編集キャンバス）でscaleの元になる値がズーム変更の
 * 前後で一致しなくなると、そのまま位置ずれになってしまう。
 *
 * 以下の関数群は、PDF.js自身が生成する viewport（page.getViewport({scale})）が
 * 持つ convertToViewportPoint / convertToPdfPoint という正規の変換メソッドを
 * 使うことで、scaleそのものを呼び出し側が再計算しなくても、その viewport の
 * 責務としてPDF実座標⇔画面座標の変換が常に一致することを保証する
 * （viewportはズームが変わるたびに作り直され、以後の変換は常にその
 * viewportを経由するため、取り違えようがない）。回転(rotation)付きの
 * viewportに対しても同じ変換メソッドがそのまま正しく機能する（A-8）。
 */
export interface PdfViewportLike {
  convertToViewportPoint(x: number, y: number): number[];
  convertToPdfPoint(x: number, y: number): number[];
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * PDF実座標系の矩形（x, y は左下基準）を、現在のviewportに基づく画面矩形
 * （left, top は左上基準のCSS px）へ変換する。矩形の対角2点をそれぞれ
 * viewport.convertToViewportPoint() で変換してから外接矩形を取ることで、
 * 回転しているviewportでも正しく軸に沿った表示矩形になる。
 */
export function pdfRectToScreenRect(rect: PdfRect, viewport: PdfViewportLike): ScreenRect {
  const [x1, y1] = viewport.convertToViewportPoint(rect.x, rect.y);
  const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** pdfRectToScreenRect の逆変換。画面矩形からPDF実座標の矩形を求める */
export function screenRectToPdfRect(rect: ScreenRect, viewport: PdfViewportLike): PdfRect {
  const [x1, y1] = viewport.convertToPdfPoint(rect.left, rect.top);
  const [x2, y2] = viewport.convertToPdfPoint(rect.left + rect.width, rect.top + rect.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** PDF実座標の1点を、現在のviewportに基づく画面座標(CSS px)へ変換する */
export function pdfPointToScreen(x: number, y: number, viewport: PdfViewportLike): { x: number; y: number } {
  const [sx, sy] = viewport.convertToViewportPoint(x, y);
  return { x: sx, y: sy };
}

/** 画面座標(CSS px)の1点を、現在のviewportに基づくPDF実座標へ変換する */
export function screenPointToPdf(x: number, y: number, viewport: PdfViewportLike): { x: number; y: number } {
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return { x: px, y: py };
}
