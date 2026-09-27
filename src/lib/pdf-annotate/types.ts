/**
 * PDF記入・注釈ツール（Phase 15）の注釈オブジェクト型定義。
 *
 * 「PDFフィールド（項目）」ではなく「PDF記入・注釈」という位置づけのため、
 * form-to-individual-pdfs（帳票エンジン）の FieldDefinition とはあえて
 * 型を分ける（あちらはCSV差し込み用の固定フォーマットの箱、こちらは
 * ユーザーがその場で自由に置く1つ1つの注釈オブジェクト）。
 *
 * 座標は既存のPDFツール（form-to-individual-pdfs等）と同じ、PDF-nativeの
 * 座標系（原点は左下、上方向が正、単位はpt）で保持する。画面のピクセル座標
 * との変換は常にツール側のUIコンポーネントで行い、この型自体は
 * ズーム率や画面サイズに依存しない。
 *
 * 日付は「テキストの一種」として扱う（開発指示書どおり、専用のツール・
 * 専用の型を作らない）。UI側で日付ピッカーの値を整形してテキストの
 * 内容として挿入するだけで、AnnotationObject側には専用のフィールドを
 * 増やさない。
 */

export type AnnotationObjectType = "text" | "checkbox" | "ink" | "image";

export interface AnnotationColor {
  r: number;
  g: number;
  b: number;
}

/** 手書き入力・チェックの既定色（黒に近い、印刷物のペンを想定した色） */
export const DEFAULT_INK_COLOR: AnnotationColor = { r: 0.1, g: 0.1, b: 0.12 };
export const DEFAULT_TEXT_COLOR: AnnotationColor = { r: 0.1, g: 0.1, b: 0.12 };

interface AnnotationObjectBase {
  id: string;
  /** 1始まりのページ番号 */
  page: number;
}

export interface TextAnnotationObject extends AnnotationObjectBase {
  type: "text";
  /** PDF-native座標。ベースライン左端（pdf-libのdrawTextのx,yと同じ意味） */
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: AnnotationColor;
  /** 太字用の日本語フォント資産(Bold)が存在しないため、疑似太字（二重描画）で表現する */
  bold: boolean;
}

export interface CheckboxAnnotationObject extends AnnotationObjectBase {
  type: "checkbox";
  /** PDF-native座標。四角形の左下端 */
  x: number;
  y: number;
  size: number;
  checked: boolean;
}

export interface InkPoint {
  x: number;
  y: number;
}

export interface InkAnnotationObject extends AnnotationObjectBase {
  type: "ink";
  /** PDF-native座標系で記録した、1画（ひとふで）分の点列 */
  points: InkPoint[];
  color: AnnotationColor;
  strokeWidth: number;
}

export interface ImageAnnotationObject extends AnnotationObjectBase {
  type: "image";
  /** PDF-native座標。画像の左下端 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 元画像のバイト列（PDF書き出し時にpdf-libへ渡す。サーバーへは送信しない） */
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  /** プレビュー表示用のObject URL。不要になったら必ずrevokeする */
  previewUrl: string;
  /** 縦横比（幅÷高さ）。リサイズ時に維持するために保持する */
  aspectRatio: number;
}

export type AnnotationObject =
  | TextAnnotationObject
  | CheckboxAnnotationObject
  | InkAnnotationObject
  | ImageAnnotationObject;

/**
 * 安全のための上限値（開発指示書：無制限Undoの禁止・暴走防止）。
 * 通常利用を不必要に制限しない範囲で、メモリ膨張・パフォーマンス劣化を防ぐ。
 */
export const PDF_FILL_ANNOTATE_LIMITS = {
  /** 1つのPDFに配置できる注釈オブジェクトの総数 */
  maxObjectsPerDocument: 300,
  /** 1画（ひとふでの手書き）あたりの最大点数 */
  maxInkPointsPerStroke: 4000,
  /** Undo履歴として保持する最大件数 */
  maxUndoHistory: 30,
  /** テキストオブジェクト1つあたりの最大文字数 */
  maxTextLength: 500,
  /** 画像1枚あたりの最大サイズ(MB) */
  maxImageSizeMB: 15,
} as const;

let idCounter = 0;
/** オブジェクトIDを発行する（表示中のタブ内で一意であればよいため、単純な連番+乱数で十分） */
export function createAnnotationId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}
