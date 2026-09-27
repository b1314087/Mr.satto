/**
 * 記入されたPDF→Excel「テンプレートモード」の型定義（Phase 18）。
 *
 * 既存の自動抽出モード（src/lib/processors/browser/filled-pdf-to-excel.ts）は
 * 維持したまま、ユーザーが明示的に指定した入力枠の位置に基づいて、
 * 「人（Person）ごと・項目（Field）ごと」に正確な値を取り出すための
 * 新しいテンプレート定義を扱う。
 *
 * Phase 11の帳票エンジン（src/lib/forms/types.ts の FieldDefinition）は
 * 「テンプレートへ値を書き込む」ための定義（fontSize/align等、描画に必要な
 * 情報を持つ）であり、責務が異なる（今回は逆方向＝テンプレートから値を
 * 読み取る）ため、型を無理に共通化せず、責務ごとに独立させている
 * （開発指示書37章の方針）。ただし「x, y, width, height をPDFページ座標系
 * （原点左下）で持つ」という設計自体はPhase 11を踏襲している。
 *
 * このモジュールは型定義のみを持ち、個人情報を一切含まない
 * （テンプレートは「枠の位置とラベル名」だけを表し、記入済みPDFから読み取った
 * 実際の値は別のオブジェクト＝PersonRecord として、実行時のブラウザメモリ上
 * だけに存在する。開発指示書29章・31章と同じ「テンプレート定義と実データの分離」方針）。
 */

/** 1つの入力枠。personIndex・fieldIndexは1始まり */
export interface TemplateField {
  id: string;
  personIndex: number;
  fieldIndex: number;
  label: string;
  /** テンプレートPDF自身のページ番号（0始まり）。通常は0のみ（1ページのテンプレート） */
  pageIndex: number;
  /** PDFページ座標系（原点左下、上方向が正）での枠の左下位置と大きさ */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 空のテンプレートPDF自身の、この枠内にある固定文字（ラベルの残り・罫線に
   * 隣接する印字等）。記入済みPDFから抽出した値からこの文字列を除外することで、
   * 「氏名：」等の固定文字が値に混ざるのを防ぐ（開発指示書16章）。
   * テンプレート確認前に自動計算する。個人情報ではなく、テンプレート自身が
   * 元から持つ印字内容のため、テンプレート定義の一部として扱ってよい。
   */
  fixedText?: string;
}

/** テンプレートPDF自身のページ情報 */
export interface TemplatePageInfo {
  pageIndex: number;
  width: number;
  height: number;
}

export interface Template {
  pages: TemplatePageInfo[];
  fields: TemplateField[];
  /**
   * 人物ブロックの有効な入力枠が一定割合未満の場合、その人物を出力から
   * 除外する（開発指示書32章・33章）。AIではなくルールベースの判定。
   */
  excludeEmptyPersons: boolean;
}

export function createEmptyTemplate(): Template {
  return { pages: [], fields: [], excludeEmptyPersons: true };
}

/** 安全のための上限（開発指示書「不必要に低くしない」を踏まえつつ、無制限生成は避ける） */
export const TEMPLATE_LIMITS = {
  maxPersonsPerPage: 20,
  maxFieldsPerPerson: 30,
  maxFieldsTotal: 400,
  /** 記入済みPDF側の合計ページ数上限。既存の自動抽出モードと同じ技術上限を踏襲 */
  maxFilledPagesHard: 20,
} as const;

/**
 * 人物ブロックを「有効（記入あり）」と判定するための最小割合
 * （開発指示書33章の例「3項目以上のうち2項目以上に値あり」＝過半数を一般化）。
 */
export const PERSON_VALID_MIN_RATIO = 0.5;

let fieldIdCounter = 0;
export function createFieldId(): string {
  fieldIdCounter += 1;
  return `field-${Date.now().toString(36)}-${fieldIdCounter}`;
}

/** 丸数字（①②③...）。範囲外は "(n)" にフォールバックする */
const CIRCLED_DIGITS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳".split("");
export function circledNumber(n: number): string {
  if (n >= 1 && n <= CIRCLED_DIGITS.length) return CIRCLED_DIGITS[n - 1];
  return `(${n})`;
}

/** UI表示用の枠ID表記（例: "1-①"）。内部の識別子(id)としては使わない */
export function fieldDisplayId(personIndex: number, fieldIndex: number): string {
  return `${personIndex}-${circledNumber(fieldIndex)}`;
}

export function nextPersonIndex(template: Template): number {
  const known = new Set(template.fields.map((f) => f.personIndex));
  // 空の人物（フィールド0件で作成しただけ）も数えられるよう、呼び出し側が
  // personIndexes（後述）を別管理する設計とする。ここではフィールドからの
  // 復元用フォールバックとしてのみ使う。
  if (known.size === 0) return 1;
  return Math.max(...known) + 1;
}

export function nextFieldIndex(template: Template, personIndex: number): number {
  const indices = template.fields.filter((f) => f.personIndex === personIndex).map((f) => f.fieldIndex);
  if (indices.length === 0) return 1;
  return Math.max(...indices) + 1;
}
