/**
 * PDF記入・注釈ツール（Phase 15で新規作成、Phase 17で拡張）の注釈オブジェクト型定義。
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
 *
 * ---- Phase 17での拡張 ----
 * Phase 17では「簡易PDFエディタ」への強化として、以下をPhase 15の型に
 * 追加した（既存のtext/checkbox/ink/imageの構造は壊さず、フィールドの
 * 追加とshape型の新設のみを行っている）。
 *
 * - image: rotation（回転角、度数法）を追加。電子印鑑生成（Phase 16）の
 *   印影PNGも「普通の画像オブジェクト」としてそのまま扱う（新しい印鑑
 *   専用エンジンは作らない）。isStamp はUI上のラベル表示専用のフラグで、
 *   処理・書き出しロジックには一切影響しない。
 * - text: width（テキストボックスの幅・任意）、align（左/中央/右揃え）を
 *   追加。text内の改行(\n)によって複数行に対応する（自動折り返しは行わず、
 *   ユーザーが改行を入力する方式。過剰な機能追加を避けるための意図的な
 *   スコープ判断）。回転は指示書の方針どおり見送り（必要性が低いため）。
 * - checkbox: markStyle（チェック/×/○）を追加。
 * - shape: 図形オブジェクト（矩形・円/楕円・直線）を新設。矩形・円は
 *   x,y,width,height + rotation（中心を軸に回転）で表現し、直線は
 *   pdf-libのdrawLineがrotateオプションを持たないため、始点・終点の
 *   座標を直接保持し、回転操作はその場で2点を回転移動して書き換える
 *   （手書きの移動と同じ「即座に座標へ反映する」方式）。
 */

export type AnnotationObjectType = "text" | "checkbox" | "ink" | "image" | "shape";

export interface AnnotationColor {
  r: number;
  g: number;
  b: number;
}

/** 手書き入力・チェックの既定色（黒に近い、印刷物のペンを想定した色） */
export const DEFAULT_INK_COLOR: AnnotationColor = { r: 0.1, g: 0.1, b: 0.12 };
export const DEFAULT_TEXT_COLOR: AnnotationColor = { r: 0.1, g: 0.1, b: 0.12 };
export const DEFAULT_SHAPE_COLOR: AnnotationColor = { r: 0.1, g: 0.35, b: 0.85 };

export type TextAlign = "left" | "center" | "right";
export type CheckboxMarkStyle = "check" | "cross" | "circle";
export type ShapeKind = "rectangle" | "circle" | "line";

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
  /** テキストボックスの幅（pt）。未指定の場合は内容から自動計算する（Phase 15互換） */
  width?: number;
  /** 左/中央/右揃え。未指定時はleft扱い */
  align?: TextAlign;
}

export interface CheckboxAnnotationObject extends AnnotationObjectBase {
  type: "checkbox";
  /** PDF-native座標。四角形の左下端 */
  x: number;
  y: number;
  size: number;
  checked: boolean;
  /** チェックのマーク種別。未指定時はcheck（レ点）扱い（Phase 15互換） */
  markStyle?: CheckboxMarkStyle;
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
  /** PDF-native座標。回転前（rotation=0のとき）の画像の左下端 */
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
  /** 回転角（度数法、反時計回りが正）。画像の中心を軸に回転する。未指定時は0 */
  rotation?: number;
  /** 縦横比を固定してリサイズするか（未指定時はtrue扱い）。falseのとき幅・高さを個別に変更できる */
  aspectLocked?: boolean;
  /**
   * 電子印鑑生成（Phase 16）から取り込んだ画像かどうかのUI表示専用フラグ。
   * 処理・書き出しロジックは通常の画像と完全に同一（新しい印鑑エンジンは作らない）。
   */
  isStamp?: boolean;
}

interface ShapeAnnotationObjectBase extends AnnotationObjectBase {
  type: "shape";
  color: AnnotationColor;
  strokeWidth: number;
}

export interface RectangleShapeObject extends ShapeAnnotationObjectBase {
  shapeKind: "rectangle";
  /** PDF-native座標。回転前（rotation=0のとき）の矩形の左下端 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 回転角（度数法）。矩形の中心を軸に回転する */
  rotation: number;
  /** 塗りつぶしの有無（任意機能） */
  fill: boolean;
}

export interface CircleShapeObject extends ShapeAnnotationObjectBase {
  shapeKind: "circle";
  /** PDF-native座標。回転前（rotation=0のとき）の外接矩形の左下端 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 回転角（度数法）。円/楕円の中心を軸に回転する */
  rotation: number;
  fill: boolean;
}

export interface LineShapeObject extends ShapeAnnotationObjectBase {
  shapeKind: "line";
  /** PDF-native座標の始点・終点。回転は2点をその場で回転移動して直接書き換える */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type ShapeAnnotationObject = RectangleShapeObject | CircleShapeObject | LineShapeObject;

export type AnnotationObject =
  | TextAnnotationObject
  | CheckboxAnnotationObject
  | InkAnnotationObject
  | ImageAnnotationObject
  | ShapeAnnotationObject;

/**
 * 安全のための上限値（開発指示書：無制限Undoの禁止・暴走防止）。
 * 通常利用を不必要に制限しない範囲で、メモリ膨張・パフォーマンス劣化を防ぐ。
 */
export const PDF_FILL_ANNOTATE_LIMITS = {
  /** 1つのPDFに配置できる注釈オブジェクトの総数 */
  maxObjectsPerDocument: 300,
  /** 1ページあたりに配置できる注釈オブジェクトの数（Phase 17で追加） */
  maxObjectsPerPage: 150,
  /** 1画（ひとふでの手書き）あたりの最大点数 */
  maxInkPointsPerStroke: 4000,
  /** Undo履歴として保持する最大件数 */
  maxUndoHistory: 30,
  /** テキストオブジェクト1つあたりの最大文字数 */
  maxTextLength: 500,
  /** 画像1枚あたりの最大サイズ(MB) */
  maxImageSizeMB: 15,
} as const;

/** 複製したオブジェクトを分かりやすくずらすためのオフセット（PDF-native pt） */
export const DUPLICATE_OFFSET_PT = 14;

let idCounter = 0;
/** オブジェクトIDを発行する（表示中のタブ内で一意であればよいため、単純な連番+乱数で十分） */
export function createAnnotationId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}
