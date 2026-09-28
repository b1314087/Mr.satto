/**
 * Phase 18: 記入されたPDF→Excel「テンプレートモード」テスト用の共通レイアウト定義。
 *
 * テストフィクスチャ生成（tests/global-setup.ts）と、実際のE2Eテスト
 * （テンプレート編集画面で入力枠のX/Y/幅/高さを数値入力する箇所）の両方から
 * 同じ座標定義を参照することで、「フィクスチャPDF内の実際の印字位置」と
 * 「テストがテンプレートへ登録する入力枠の位置」が食い違わないようにする。
 *
 * 実在の人物・個人情報は一切使用しない、テスト専用の架空データ。
 */

export const TEMPLATE_PAGE = { width: 500, height: 700 };

export interface TemplateFieldSpec {
  personIndex: number;
  fieldIndex: number;
  /** テンプレート編集画面で入力する項目名 */
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 3項目 x 2人分のテンプレート。
 * 1人目の「氏名」だけは、あえて印字ラベル「氏名：」を枠の内側に含む位置に
 * している（開発指示書16章の固定文字除外を検証するため）。それ以外の項目は
 * ラベルを枠の外側（x=40〜130付近）に置き、枠の中には入力値だけが入る
 * 「素直な」ケースにしている。
 */
export const TEMPLATE_FIELDS: TemplateFieldSpec[] = [
  { personIndex: 1, fieldIndex: 1, label: "氏名", x: 40, y: 615, width: 240, height: 20 },
  { personIndex: 1, fieldIndex: 2, label: "生年月日", x: 140, y: 575, width: 140, height: 20 },
  { personIndex: 1, fieldIndex: 3, label: "住所", x: 140, y: 535, width: 180, height: 20 },
  { personIndex: 2, fieldIndex: 1, label: "氏名", x: 140, y: 455, width: 140, height: 20 },
  { personIndex: 2, fieldIndex: 2, label: "生年月日", x: 140, y: 415, width: 140, height: 20 },
  { personIndex: 2, fieldIndex: 3, label: "住所", x: 140, y: 375, width: 180, height: 20 },
];

export const FIELD_LABEL_TEXT: Record<string, string> = {
  氏名: "氏名：",
  生年月日: "生年月日：",
  住所: "住所：",
};

export interface DummyPerson {
  氏名: string;
  生年月日: string;
  住所: string;
}

// ダミーデータ（実在の人物・個人情報は一切使用しない）
export const PERSON_A: DummyPerson = { 氏名: "山田太郎", 生年月日: "1990/01/01", 住所: "大阪府大阪市北区1-2-3" };
export const PERSON_B: DummyPerson = { 氏名: "佐藤花子", 生年月日: "1992/05/20", 住所: "京都府京都市中京区4-5-6" };
export const PERSON_C: DummyPerson = { 氏名: "鈴木一郎", 生年月日: "1985/03/15", 住所: "愛知県名古屋市中区7-8-9" };
export const PERSON_D: DummyPerson = { 氏名: "田中恵子", 生年月日: "1995/11/30", 住所: "福岡県福岡市博多区1-1-1" };

/**
 * 3項目 x 3人分のテンプレート（「1ページに3人」のケースの検証用、開発指示書44章）。
 * 1・2人目はTEMPLATE_FIELDSと全く同じ配置とし、3人目をさらに下（人物ブロック間の
 * 間隔80pt・項目間隔40ptという既存の規則をそのまま延長した位置）へ追加しただけの、
 * 最小限の差分にしている。
 */
export const THREE_PERSON_TEMPLATE_FIELDS: TemplateFieldSpec[] = [
  ...TEMPLATE_FIELDS,
  { personIndex: 3, fieldIndex: 1, label: "氏名", x: 140, y: 295, width: 140, height: 20 },
  { personIndex: 3, fieldIndex: 2, label: "生年月日", x: 140, y: 255, width: 140, height: 20 },
  { personIndex: 3, fieldIndex: 3, label: "住所", x: 140, y: 215, width: 180, height: 20 },
];

/**
 * Phase 18.2 A-19: checkbox枠の検証用レイアウト。
 * 「氏名」のtextフィールドに加え、checkbox型の「同意」フィールドを1つ持つ、
 * 最小限の1人分テンプレート（専用の小さいページを使い、既存のTEMPLATE_FIELDSや
 * それを使う既存フィクスチャ・既存テストには一切影響しない）。
 */
export const CHECKBOX_PAGE = { width: 300, height: 200 };
export const CHECKBOX_TEMPLATE_FIELDS: TemplateFieldSpec[] = [
  { personIndex: 1, fieldIndex: 1, label: "氏名", x: 40, y: 140, width: 200, height: 20 },
  { personIndex: 1, fieldIndex: 2, label: "同意", x: 40, y: 80, width: 30, height: 30 },
];
export const CHECKBOX_PERSON_NAME = "高橋修";

/**
 * Phase 18.2 A-11/A-12: 隣接するFieldの分離を検証するための、間隔ゼロで
 * 隙間なく隣り合う2つのtext枠（横方向に完全に接している）。
 */
export const ADJACENT_PAGE = { width: 320, height: 120 };
export const ADJACENT_TEMPLATE_FIELDS: TemplateFieldSpec[] = [
  { personIndex: 1, fieldIndex: 1, label: "氏名", x: 20, y: 60, width: 120, height: 24 },
  { personIndex: 1, fieldIndex: 2, label: "住所", x: 140, y: 60, width: 160, height: 24 },
];
export const ADJACENT_PERSON = { 氏名: "伊藤次郎", 住所: "東京都渋谷区9-9-9" };

/** OCRフォールバック検証用のスキャン画像フィクスチャは、認識精度を安定させるため英数字のみを使う */
export const SCANNED_TEMPLATE_FIELDS: TemplateFieldSpec[] = [
  { personIndex: 1, fieldIndex: 1, label: "NAME", x: 140, y: 615, width: 240, height: 24 },
  { personIndex: 1, fieldIndex: 2, label: "ADDR", x: 140, y: 535, width: 260, height: 24 },
];
export const SCANNED_PERSON_A = { NAME: "TARO YAMADA", ADDR: "1-2-3 OSAKA" };
export const SCANNED_PERSON_B = { NAME: "HANAKO SATO", ADDR: "4-5-6 KYOTO" };
export const SCANNED_TEMPLATE_FIELDS_PERSON2: TemplateFieldSpec[] = [
  { personIndex: 2, fieldIndex: 1, label: "NAME", x: 140, y: 455, width: 240, height: 24 },
  { personIndex: 2, fieldIndex: 2, label: "ADDR", x: 140, y: 375, width: 260, height: 24 },
];
