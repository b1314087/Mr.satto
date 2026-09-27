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
