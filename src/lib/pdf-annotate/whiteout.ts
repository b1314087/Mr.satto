import type { AnnotationColor, AnnotationObject, RectangleShapeObject } from "./types";

/**
 * 白消し（工程12）。PDF上に白い塗りつぶしの四角形を重ねて、見た目だけ隠す。
 *
 * 重要：これは元の文字を「消す」機能ではない。元の文字情報はPDFの内部に残るため、
 * コピー・検索・文字抽出で読み取れる場合がある。個人情報などを確実に隠す機能（黒塗り）ではない。
 * 画面の表示は、この前提（WHITEOUT_NOTICE）から外れないようにすること。
 */

/** 白消しに使う色（ページの白と同じ） */
export const WHITEOUT_COLOR: AnnotationColor = { r: 1, g: 1, b: 1 };

/** クリックで置く白消しの初期サイズ（pt）。文字1行ぶんを隠せる横長にしている */
export const WHITEOUT_DEFAULT_WIDTH = 160;
export const WHITEOUT_DEFAULT_HEIGHT = 24;

/** 白消しの注意書き（画面に必ず表示する） */
export const WHITEOUT_NOTICE = {
  title: "白消しは、見た目上の文字を隠すための機能です。",
  body: "元の文字情報がファイル内に残る場合があり、コピー・検索・文字抽出で読み取れることがあります。個人情報などの機密情報を完全に削除する機能ではありません。",
} as const;

/** 白消し（白で塗りつぶした矩形）か。色と塗りつぶしだけで判定するので、手で色を変えた矩形は対象外になる */
export function isWhiteoutObject(obj: AnnotationObject): obj is RectangleShapeObject {
  return (
    obj.type === "shape" &&
    obj.shapeKind === "rectangle" &&
    obj.fill &&
    obj.color.r === WHITEOUT_COLOR.r &&
    obj.color.g === WHITEOUT_COLOR.g &&
    obj.color.b === WHITEOUT_COLOR.b
  );
}

/**
 * 新しい白消しを置く位置（配列の添字）。同じ配列にある白消し以外のオブジェクトより前に置き、
 * 後から置いた白消しが、すでに書いた文字・図形を隠してしまわないようにする
 * （PDFでは配列の後ろにあるものほど手前に描かれる）。
 */
export function whiteoutInsertIndex(objects: AnnotationObject[]): number {
  const firstNonWhiteout = objects.findIndex((o) => !isWhiteoutObject(o));
  return firstNonWhiteout === -1 ? objects.length : firstNonWhiteout;
}
