/**
 * 領収書・レシートから会計CSV作成ツール（工程8）で共通に使う型と上限。
 *
 * このフォルダ（src/lib/accounting）の関数は、画面にも通信にも依存しない純粋な処理だけにする。
 * これにより、OCRの結果が実行環境で変わっても、抽出規則・検証・CSVの動作をテストで固定できる。
 */

/** 抽出する項目 */
export type ReceiptFieldKey = "date" | "vendor" | "total";

/** 1つの候補。value は、画面の入力欄にそのまま入れられる形（日付は YYYY-MM-DD、金額は数字だけ、取引先は文字） */
export interface FieldCandidate {
  value: string;
  /** なぜ候補にしたか（利用者に見せる短い説明） */
  reason: string;
}

/**
 * 1項目の抽出結果。
 * value は「自動で入力欄に入れてよい」と判断できた場合だけ入る。複数の候補があって判断できない・
 * 見つからない場合は null（推測で埋めない）。candidates は、利用者が選べる候補（value の元になった候補も含む）。
 */
export interface FieldExtraction {
  value: string | null;
  candidates: FieldCandidate[];
  /** 画面に出す注意書き（なければ null） */
  note: string | null;
  /** その値が読み取られた行のOCR信頼度が低かった（OCRの場合のみ。確認を促す印） */
  lowConfidence: boolean;
}

export interface ReceiptExtraction {
  date: FieldExtraction;
  vendor: FieldExtraction;
  total: FieldExtraction;
}

/** 書類から読み取った1行の文字。confidence は、OCRの場合のみ 0〜100（行の中で最も低い単語の値）。文字情報から取り出した行は null */
export interface TextLine {
  text: string;
  confidence: number | null;
}

/** 読み取り方法 */
export type ReadMethod = "text-layer" | "ocr";

/** 確認画面の1行（1書類＝1画像、またはPDFの1ページ）が持つ、利用者が編集できる値（入力欄の文字そのまま） */
export interface ReceiptEditableValues {
  date: string;
  vendor: string;
  total: string;
}

/** 入力値の検証結果 */
export interface RowValidation {
  /** 確認済みにできない・出力できない問題 */
  errors: string[];
  /** 出力はできるが、見直してほしい点 */
  warnings: string[];
  /** 検証を通った場合の値（errors が空のときだけ入る） */
  normalized: { date: string; vendor: string; total: number } | null;
}

/**
 * 処理量の上限。ブラウザ内OCRは重く、スマートフォンではメモリも限られるため、控えめに設定している
 * （既存のOCR・PDF→Excelの上限（PDFは20ページ）に合わせ、根拠なく大きくしない）。
 */
export const RECEIPT_LIMITS = {
  /** 画像1枚の最大サイズ(MB) */
  maxImageMB: 15,
  /** PDF1つの最大サイズ(MB) */
  maxPdfMB: 30,
  /** 一度に追加できるファイル数 */
  maxFilesPerAdd: 30,
  /** 画面に並べられる書類（画像1枚・PDF1ページ）の合計 */
  maxDocuments: 60,
  /** 画像の最大画素数（デコード後）。これを超える画像はメモリ保護のため読み込まない */
  maxImagePixels: 50_000_000,
} as const;

/** 取引先の最大文字数（freeeなど会計ソフトの一般的な上限に合わせた安全側の値） */
export const VENDOR_MAX_LENGTH = 255;

/** 合計金額の上限（円）。これより大きい値は誤読の可能性が高いため候補にしない */
export const TOTAL_MAX_YEN = 999_999_999;

/**
 * OCRの信頼度がこの値を下回る行から読み取った値には「信頼度が低い」印を付ける。
 * 仮の値であり、実物の領収書での評価（工程9）の結果で決め直す。信頼度が高いことは、意味を正しく読めたことを保証しない。
 */
export const LOW_CONFIDENCE_THRESHOLD = 60;

/**
 * OCRの信頼度がこの値を下回る行から読み取った値は、自動では入力欄に入れない（候補として示し、利用者が選ぶか入力する）。工程12。
 * 合成データ（94種類の書類×7条件）での測定では、40未満で止めると、誤った自動入力の約半数（日付5/11・合計9/17・取引先23/45）を止められ、
 * 正しい自動入力を止める割合は2〜6%だった（60未満にすると合計の約29%を止めてしまう）。
 * 信頼度が高くても、数字の読み違いなど誤りは残るため、この値で精度を保証するものではない。実物での評価で決め直す。
 */
export const AUTOFILL_STOP_CONFIDENCE = 40;
