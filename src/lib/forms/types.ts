/**
 * 帳票共通エンジン（Phase 11 開発指示書 30章：ツール②専用ではなく、将来の
 * 宛名ラベル・名札・個別通知・修了証・会員証・一括帳票にも再利用できる
 * Template / Field / Mapping / Render 構造として設計する）。
 *
 * このモジュールは型定義のみを持ち、PDF生成ロジック（template-renderer.ts）や
 * UI（form-to-individual-pdfs-tool.tsx）から共通で参照される。
 *
 * 重要な設計方針（開発指示書15章・31章）：
 *   テンプレート（フィールド定義）と個人データ（実行時の値）を明確に分離する。
 *   FormTemplate はテンプレートPDFの見た目・フィールド配置のみを表し、
 *   個人情報を一切含まない。個人データは実行時（ブラウザのメモリ上）だけに存在し、
 *   このテンプレート定義とは別のオブジェクト（ParsedTable / 行データ）として扱う。
 */

/** フィールドの入力元データ種別。将来的にチェックボックス等が増えてもここに追加する */
export type FieldDataType = "text" | "photo";

export type FieldAlign = "left" | "center" | "right";

export interface FieldDefinition {
  id: string;
  /** UI表示用のラベル（例: "氏名"）。個人情報そのものではなく、項目名 */
  label: string;
  /** 1始まりのページ番号 */
  page: number;
  /** PDFページ座標系（原点は左下、上方向が正）でのフィールド左下の位置 */
  x: number;
  y: number;
  width: number;
  height: number;
  dataType: FieldDataType;
  /** テキストフィールドのフォントサイズ（pt）。photoフィールドでは未使用 */
  fontSize: number;
  /** テキストフィールドの水平方向の配置。photoフィールドでは未使用 */
  align: FieldAlign;
}

/** アップロードしたテンプレートPDFのページサイズ情報（PDF点単位） */
export interface TemplatePageInfo {
  pageNumber: number;
  width: number;
  height: number;
}

/**
 * テンプレート設定（フィールド配置のみ）。個人情報・実データは含まない。
 * 開発指示書31章：この設定はユーザーが明示的に保存を求めない限りサーバーへ
 * 送信・保存しない（ブラウザ内メモリ上でのみ保持する）。
 */
export interface FormTemplate {
  pages: TemplatePageInfo[];
  fields: FieldDefinition[];
}

/** CSV/Excelから読み取った表形式データ（見出し行 + データ行） */
export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/**
 * フィールドID -> CSV/Excelの列名（見出し）の対応。
 * 曖昧な自動推定は行わず、完全一致以外は未設定(null)のままにする
 * （開発指示書22章・41章：ユーザーが必ず最終確認・手動設定できるようにする）。
 */
export type ColumnMapping = Record<string, string | null>;

/**
 * 写真フィールド用の「識別子列の値」→「実際にアップロードされた画像ファイル」の対応。
 * ファイル名の自動マッチングが失敗した行は undefined のままにし、決して
 * 無関係な写真を代わりに割り当てない（開発指示書19章・23章）。
 */
export type PhotoAssignment = Map<string, File>;

export function createEmptyField(overrides: Partial<FieldDefinition> & { id: string }): FieldDefinition {
  return {
    label: "新しい項目",
    page: 1,
    x: 50,
    y: 700,
    width: 150,
    height: 20,
    dataType: "text",
    fontSize: 11,
    align: "left",
    ...overrides,
  };
}
