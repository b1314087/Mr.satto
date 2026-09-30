import { BrowserProcessor } from "../types";

/**
 * 数字・番号フォーマットツール（次工程・軽量便利ツール一括追加 Tool 3）。
 * 既存の「大文字・小文字変換」(text-case-converter) とは別ツールとして、
 * 数字専用の整形（郵便番号・電話番号・任意区切り・カンマ）をまとめる。
 *
 * 入力は複数行対応（1行=1件として、行ごとに独立して変換する）。
 * 空行はそのまま空行として結果に残す。
 */
export type NumberFormatMode = "zip" | "phone" | "custom" | "comma-add" | "comma-remove" | "digits-only";

export interface NumberFormatInput {
  mode: NumberFormatMode;
  text: string;
  /** custom モード: 区切り位置のパターン（例: "3-4-3"） */
  customPattern?: string;
  /** custom モード: 区切り文字（既定 "-"） */
  customDelimiter?: string;
}

export interface NumberFormatOutput {
  result: string;
}

function extractDigits(line: string): string {
  return line.replace(/[^0-9]/g, "");
}

/** 郵便番号: 7桁の数字のみ "XXX-XXXX" に整形する。7桁でなければ元の行をそのまま返す */
function formatZip(line: string): string {
  const digits = extractDigits(line);
  if (digits.length !== 7) return line;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/**
 * 電話番号: よく使われる桁数のパターンにのみ対応する（指示書の例に準拠）。
 * - 11桁・070/080/090/050始まり -> 3-4-4（携帯電話）
 * - 10桁 -> 3-3-4（固定電話の一般的な例。市外局番の桁数まで厳密に判定はしない）
 * それ以外の桁数は誤変換を避けるため元の行をそのまま返す。
 */
function formatPhone(line: string): string {
  const digits = extractDigits(line);
  if (digits.length === 11 && /^(070|080|090|050)/.test(digits)) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return line;
}

/** "3-4-3" のようなパターン文字列を区切り位置の配列 [3,4,3] に変換する */
export function parseCustomPattern(pattern: string): number[] {
  const segments = pattern
    .split(/[-,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (segments.length === 0 || segments.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error("区切り位置は「3-4-3」のように、正の整数をハイフンで区切って入力してください");
  }
  return segments;
}

function applyCustomPattern(digits: string, segments: number[], delimiter: string): string {
  const parts: string[] = [];
  let idx = 0;
  for (const len of segments) {
    if (idx >= digits.length) break;
    parts.push(digits.slice(idx, idx + len));
    idx += len;
  }
  if (idx < digits.length) parts.push(digits.slice(idx));
  return parts.filter((p) => p.length > 0).join(delimiter);
}

/** 数値文字列（整数部分）に3桁区切りのカンマを追加する。符号・小数部分は保持する */
function addThousandsSeparator(line: string): string {
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(line.trim());
  if (!m) return line;
  const [, sign, intPart, decPart = ""] = m;
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${withCommas}${decPart}`;
}

function processLine(line: string, input: NumberFormatInput): string {
  if (line.trim() === "") return line;
  switch (input.mode) {
    case "zip":
      return formatZip(line);
    case "phone":
      return formatPhone(line);
    case "custom": {
      const segments = parseCustomPattern(input.customPattern ?? "");
      const delimiter = input.customDelimiter ?? "-";
      return applyCustomPattern(extractDigits(line), segments, delimiter);
    }
    case "comma-add":
      return addThousandsSeparator(line);
    case "comma-remove":
      return line.replace(/,/g, "");
    case "digits-only":
      return extractDigits(line);
    default:
      throw new Error("不明なモードです");
  }
}

export class NumberFormatProcessor extends BrowserProcessor<NumberFormatInput, NumberFormatOutput> {
  async process(input: NumberFormatInput): Promise<NumberFormatOutput> {
    if (input.text === "") return { result: "" };
    const lines = input.text.split(/\r\n|\r|\n/);
    const result = lines.map((line) => processLine(line, input)).join("\n");
    return { result };
  }
}
