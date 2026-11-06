/**
 * CSVの文字コードの判定と読み込み（ブラウザ内だけで行う。ファイルの内容はどこにも送らない）。
 *
 * 日本のCSVは、Excelの「CSV（コンマ区切り）」や銀行・会計ソフトの出力など、Shift_JIS（Windows-31J）で
 * 保存されたものが多い。UTF-8だけを前提に読むと文字化けするため、次の順で文字コードを決める。
 *
 * 1. BOM（ファイルの先頭の印）があれば、それに従う（UTF-8 BOM・UTF-16）
 * 2. 英数字だけ（0x80以上のバイトが無い）なら、どの文字コードでも同じ文字になるので、そのまま読む
 * 3. UTF-8として正しく読めれば UTF-8
 * 4. UTF-8として読めなければ Shift_JIS（Windows-31J）
 * 5. 判定が不確実なとき（UTF-8としてもShift_JISとしても読める短いデータ、どちらで読んでも読めない文字が出るデータ）は
 *    「確認が必要」として返し、画面で文字コードを選んでもらう（誤った文字コードのまま黙って進めない）
 *
 * Shift_JIS の読み込みには、ブラウザ標準の TextDecoder("shift_jis") を使う。WHATWG Encoding 標準の "shift_jis" は
 * Windows-31J（CP932）と同じ文字の対応表で、NEC特殊文字（①・㈱・№など）・IBM拡張文字（髙・﨑など）・半角カナも読める
 * （Chrome・Edge・Firefox・Safari の現行版で利用できる）。新しいライブラリは使わない。
 *
 * 利用者が文字コードを選び直したときは、その選択をファイルごとに覚えておき（setCsvEncodingChoice）、
 * プレビュー・変換のどちらも同じ文字コードで読む（readCsvText）。
 */

/** 画面で選べる文字コード（auto＝自動判定） */
export type CsvEncodingChoice = "auto" | "utf-8" | "utf-8-bom" | "shift_jis";

/** 実際に読んだ文字コード */
export type CsvEncodingUsed = "utf-8" | "utf-8-bom" | "shift_jis" | "utf-16le" | "utf-16be" | "ascii";

export const CSV_ENCODING_OPTIONS: { value: CsvEncodingChoice; label: string }[] = [
  { value: "auto", label: "自動判定" },
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-8-bom", label: "UTF-8（BOM付き）" },
  { value: "shift_jis", label: "Shift_JIS／Windows-31J" },
];

export const CSV_ENCODING_LABELS: Record<CsvEncodingUsed, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8（BOM付き）",
  shift_jis: "Shift_JIS／Windows-31J",
  "utf-16le": "UTF-16（Excelの「Unicodeテキスト」）",
  "utf-16be": "UTF-16（ビッグエンディアン）",
  ascii: "英数字のみ（UTF-8・Shift_JISのどちらでも同じ）",
};

export interface CsvDecodeResult {
  text: string;
  /** 実際に読んだ文字コード */
  encoding: CsvEncodingUsed;
  /** 利用者が選んだ文字コード（auto のときは自動判定） */
  choice: CsvEncodingChoice;
  /** 自動判定が確かでなく、利用者の確認が必要か */
  uncertain: boolean;
  /** 読めない文字（U+FFFD）が含まれる＝文字化けしている可能性が高い */
  hasUnreadable: boolean;
}

/** 文字化けの警告に使う、利用者向けの文言 */
export const CSV_DECODE_FAILED_MESSAGE = "CSVファイルを正常に読み込めませんでした。文字コードを変更して再度お試しください。";

const REPLACEMENT = "�";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeWith(label: string, bytes: Uint8Array, fatal = false): string {
  return new TextDecoder(label, { fatal }).decode(bytes);
}

/** 0x80以上のバイトの数（英数字以外の文字がどれくらいあるか） */
function countHighBytes(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) n++;
  return n;
}

/** UTF-8として「ありそう」と言えるだけの量の、日本語などの文字があるか（全角1文字＝3バイト。2文字分以上） */
const UTF8_CONFIDENT_HIGH_BYTES = 6;

/** 文字コードを自動で判定して読む */
export function detectAndDecodeCsv(input: ArrayBuffer | Uint8Array): CsvDecodeResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const base = { choice: "auto" as const };

  // 1. BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = stripBom(decodeWith("utf-8", bytes));
    return { ...base, text, encoding: "utf-8-bom", uncertain: false, hasUnreadable: text.includes(REPLACEMENT) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = stripBom(decodeWith("utf-16le", bytes));
    return { ...base, text, encoding: "utf-16le", uncertain: false, hasUnreadable: text.includes(REPLACEMENT) };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = stripBom(decodeWith("utf-16be", bytes));
    return { ...base, text, encoding: "utf-16be", uncertain: false, hasUnreadable: text.includes(REPLACEMENT) };
  }

  // 2. 英数字だけ
  const high = countHighBytes(bytes);
  if (high === 0) {
    return { ...base, text: decodeWith("utf-8", bytes), encoding: "ascii", uncertain: false, hasUnreadable: false };
  }

  // 3. UTF-8として正しく読めるか
  let utf8: string | null = null;
  try {
    utf8 = decodeWith("utf-8", bytes, true);
  } catch {
    utf8 = null;
  }
  const sjis = decodeWith("shift_jis", bytes);
  const sjisOk = !sjis.includes(REPLACEMENT);
  if (utf8 !== null) {
    // Shift_JISとしては読めない、または日本語が十分な量あれば、UTF-8で確定。
    // 短いデータでShift_JISとしても読める場合は、どちらとも言えないため確認してもらう
    const uncertain = sjisOk && high < UTF8_CONFIDENT_HIGH_BYTES;
    return { ...base, text: utf8, encoding: "utf-8", uncertain, hasUnreadable: false };
  }

  // 4. Shift_JIS（Windows-31J）
  // どちらで読んでも読めない文字が出る（EUC-JPなど別の文字コード、壊れたファイル）ときは、確認してもらう
  return { ...base, text: sjis, encoding: "shift_jis", uncertain: !sjisOk, hasUnreadable: !sjisOk };
}

/** 指定した文字コードで読む（auto のときは自動判定） */
export function decodeCsvWith(input: ArrayBuffer | Uint8Array, choice: CsvEncodingChoice): CsvDecodeResult {
  if (choice === "auto") return detectAndDecodeCsv(input);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (choice === "shift_jis") {
    const text = decodeWith("shift_jis", bytes);
    return { text, encoding: "shift_jis", choice, uncertain: false, hasUnreadable: text.includes(REPLACEMENT) };
  }
  // UTF-8 と UTF-8（BOM付き）は、読み方は同じ（BOMがあれば取り除く）
  const text = stripBom(decodeWith("utf-8", bytes));
  return { text, encoding: choice, choice, uncertain: false, hasUnreadable: text.includes(REPLACEMENT) };
}

// ---------------------------------------------------------------------------
// ファイルごとの選択（画面で選び直した文字コード）
// ---------------------------------------------------------------------------

const choices = new WeakMap<File, CsvEncodingChoice>();
const listeners = new Set<() => void>();
let version = 0;

export function getCsvEncodingChoice(file: File): CsvEncodingChoice {
  return choices.get(file) ?? "auto";
}

/** 文字コードを選び直す（プレビュー・変換のどちらも、この文字コードで読み直す） */
export function setCsvEncodingChoice(file: File, choice: CsvEncodingChoice): void {
  if (getCsvEncodingChoice(file) === choice) return;
  choices.set(file, choice);
  version++;
  listeners.forEach((l) => l());
}

/** 選択が変わったことを知る（画面の読み直し用） */
export function subscribeCsvEncoding(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCsvEncodingVersion(): number {
  return version;
}

/** CSVファイルとして扱う名前・種類か */
export function isCsvLikeFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || name.endsWith(".txt") || name.endsWith(".tsv") || file.type === "text/csv" || file.type === "text/plain";
}

/**
 * CSVファイルを文字にする。choice を省くと、画面で選ばれた文字コード（無ければ自動判定）で読む。
 * ファイルを読めなかったときは、利用者向けの日本語のエラーを投げる（元のファイルは変更しない）。
 */
export async function readCsvText(file: File, choice?: CsvEncodingChoice): Promise<CsvDecodeResult> {
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    throw new Error(`${file.name} の読み込みに失敗しました`);
  }
  try {
    return decodeCsvWith(buf, choice ?? getCsvEncodingChoice(file));
  } catch {
    throw new Error(CSV_DECODE_FAILED_MESSAGE);
  }
}
