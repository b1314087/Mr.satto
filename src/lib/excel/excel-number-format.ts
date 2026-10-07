/**
 * Excelの数値の表示書式（"#,##0"・"0.00"・"0%"・"#,##0_);[Red](#,##0)"・"¥#,##0" 等）を解釈して、
 * 数値をExcelと同じ見た目の文字列へ整形する。
 *
 * read-excel-fileはセルの値(850000)だけを返し、どう表示するか(書式)の情報は持たない。
 * 書式を見ないと、Excelで「850,000」と表示されている金額が「850000」になってしまう。
 *
 * 対応: 桁区切り(,)・小数桁(0 # ?)・先頭の0埋め・パーセント(%)・正負0のセクション(;区切り)・
 *       引用符"..."と\xのリテラル・¥/$等の通貨記号。
 * 非対応(元の値をそのまま表示): 指数(E+)・分数(?/?)・日付時刻(別処理)・[条件]付きのセクション分け。
 * [Red]等の色指定・[$-411]等の言語指定・_x(桁揃えの空白)・*x(繰り返し)は読み飛ばす。
 */

interface Section {
  prefix: string;
  suffix: string;
  intPattern: string;
  decPattern: string;
  grouping: boolean;
  percentCount: number;
  hasNumberPattern: boolean;
}

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let cur = "";
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "[") inBracket = true;
    else if (!inQuote && ch === "]") inBracket = false;
    if (ch === ";" && !inQuote && !inBracket) {
      sections.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  sections.push(cur);
  return sections;
}

function parseSection(section: string): Section | null {
  let prefix = "";
  let suffix = "";
  let intPattern = "";
  let decPattern = "";
  let grouping = false;
  let percentCount = 0;
  let inDecimal = false;
  let started = false;
  let ended = false;
  let hasNumberPattern = false;

  const addLiteral = (text: string) => {
    if (!started) prefix += text;
    else {
      ended = true;
      suffix += text;
    }
  };

  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      const text = section.slice(i + 1, end === -1 ? section.length : end);
      addLiteral(text);
      i = end === -1 ? section.length : end;
    } else if (ch === "\\") {
      if (i + 1 < section.length) addLiteral(section[i + 1]);
      i++;
    } else if (ch === "[") {
      const end = section.indexOf("]", i + 1);
      const inner = end === -1 ? "" : section.slice(i + 1, end);
      // [$¥-411] のような通貨指定は記号を表示する。色・条件・言語のみの指定は読み飛ばす。
      const currency = /^\$([^-\]]*)/.exec(inner);
      if (currency && currency[1]) addLiteral(currency[1]);
      i = end === -1 ? section.length : end;
    } else if (ch === "_" || ch === "*") {
      i++; // 次の1文字(桁揃え・繰り返しの対象)ごと読み飛ばす
    } else if (ch === "%") {
      percentCount++;
      addLiteral("%");
    } else if ((ch === "0" || ch === "#" || ch === "?") && !ended) {
      started = true;
      hasNumberPattern = true;
      if (inDecimal) decPattern += ch;
      else intPattern += ch;
    } else if (ch === "," && started && !ended && !inDecimal) {
      grouping = true;
    } else if (ch === "." && started && !ended && !inDecimal) {
      inDecimal = true;
    } else if (/[eE]/.test(ch) && started && /[+-]/.test(section[i + 1] ?? "")) {
      return null; // 指数表記は非対応
    } else if (ch === "/" && started) {
      return null; // 分数は非対応
    } else {
      addLiteral(ch);
    }
  }
  return { prefix, suffix, intPattern, decPattern, grouping, percentCount, hasNumberPattern };
}

function applySection(abs: number, s: Section): string {
  let value = abs;
  for (let i = 0; i < s.percentCount; i++) value *= 100;
  const decimals = s.decPattern.length;
  let text = value.toFixed(decimals);
  let [intPart, decPart = ""] = text.split(".");
  // 先頭の0埋め(0の個数ぶんの桁数まで)。#のみのときは、整数部が0なら空にする(Excelは".5"のように表示する)
  const minInt = (s.intPattern.match(/0/g) ?? []).length;
  if (intPart === "0" && minInt === 0) intPart = "";
  if (intPart.length < minInt) intPart = intPart.padStart(minInt, "0");
  if (s.grouping) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // 小数部のうち#の位置の末尾の0は省く
  const minDec = (s.decPattern.match(/0/g) ?? []).length;
  while (decPart.length > minDec && decPart.endsWith("0")) decPart = decPart.slice(0, -1);
  text = decPart ? `${intPart}.${decPart}` : intPart;
  return text;
}

/** 数値をExcelの書式コードで整形する。解釈できない書式なら null（呼び出し側で元の値を表示する） */
export function formatExcelNumber(value: number, code: string | null): string | null {
  if (!code || code === "General" || code === "@") return null;
  if (!Number.isFinite(value)) return null;
  const sections = splitSections(code);
  // 条件付きセクション([>100]等)は非対応
  if (sections.some((sec) => /\[(<|>|=)/.test(sec))) return null;

  let sectionIdx = 0;
  let useAbs = false;
  if (value < 0) {
    if (sections.length >= 2) sectionIdx = 1;
    else useAbs = false;
  } else if (value === 0 && sections.length >= 3) {
    sectionIdx = 2;
  }
  const section = parseSection(sections[sectionIdx] ?? "");
  if (!section || !section.hasNumberPattern) return null;

  const negativeHandledBySection = value < 0 && sections.length >= 2;
  useAbs = negativeHandledBySection;
  const body = applySection(useAbs ? Math.abs(value) : value, section);
  // セクションが1つだけで負数のときは、マイナス記号を先頭(通貨記号などの前)ではなく数字の直前へ付ける
  return `${section.prefix}${body}${section.suffix}`;
}
