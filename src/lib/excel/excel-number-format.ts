/**
 * Excelの数値の表示書式（"#,##0"・"0.00"・"0%"・"#,##0_);[Red](#,##0)"・"¥#,##0" 等）を解釈して、
 * 数値をExcelと同じ見た目の文字列へ整形する。
 *
 * read-excel-fileはセルの値(850000)だけを返し、どう表示するか(書式)の情報は持たない。
 * 書式を見ないと、Excelで「850,000」と表示されている金額が「850000」になってしまう。
 *
 * 対応: 桁区切り(,)・桁区切りの縮小(末尾の,で1000分の1)・小数桁(0 # ?)・先頭の0埋め・
 *       パーセント(%)・正負0文字のセクション(;区切り)・条件つきセクション([>=100]等)・
 *       指数(0.00E+00)・分数(# ?/? ・ ?/8)・引用符"..."と\xのリテラル・¥/$等の通貨記号・
 *       文字列用のセクション(@)・標準(General)表示。
 * [Red]等の色指定・[$-411]等の言語指定・_x(桁揃えの空白)・*x(繰り返し)は読み飛ばす。
 * 日付時刻は別処理(excel-date-format.ts)。解釈できない書式は null を返し、呼び出し側で元の値を表示する。
 */

interface Condition {
  op: "<" | "<=" | ">" | ">=" | "=" | "<>";
  value: number;
}

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let cur = "";
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\\") {
      cur += ch + (code[i + 1] ?? "");
      i++;
      continue;
    }
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

/** セクション先頭の [>=100] 等の条件を取り出す(無ければnull) */
function readCondition(section: string): Condition | null {
  const m = /\[(<=|>=|<>|<|>|=)\s*(-?[\d.]+)\]/.exec(section);
  return m ? { op: m[1] as Condition["op"], value: Number(m[2]) } : null;
}

function matches(c: Condition, v: number): boolean {
  switch (c.op) {
    case "<":
      return v < c.value;
    case "<=":
      return v <= c.value;
    case ">":
      return v > c.value;
    case ">=":
      return v >= c.value;
    case "=":
      return v === c.value;
    default:
      return v !== c.value;
  }
}

/** Excelと同じ「四捨五入(5は絶対値が大きい方へ)」。2進数の誤差(1.005→1.00)が出ないよう、10進の文字列として丸める */
function roundHalfAwayFromZero(value: number, decimals: number): number {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const shifted = Number(`${abs}e${decimals}`);
  if (!Number.isFinite(shifted)) return value;
  return sign * Number(`${Math.round(shifted)}e-${decimals}`);
}

function toFixedExcel(value: number, decimals: number): string {
  return roundHalfAwayFromZero(value, decimals).toFixed(decimals);
}

interface NumberSection {
  prefix: string;
  suffix: string;
  intPattern: string;
  decPattern: string;
  grouping: boolean;
  /** 末尾のカンマの数(1つにつき値を1000で割る) */
  scaleCommas: number;
  percentCount: number;
  hasNumberPattern: boolean;
  /** 指数表記: 指数部の桁数(0の個数)と、+を常に付けるか */
  exponent: { digits: number; plus: boolean } | null;
  /** 分数: 整数部を分けるか・分母の桁数または固定の分母・分子の?の個数 */
  fraction: { withWhole: boolean; denominatorDigits: number; fixedDenominator: number | null; numeratorWidth: number } | null;
}

function parseNumberSection(section: string): NumberSection | null {
  // 分数: "# ?/?"・"?/?"・"# ??/??"・"?/8"
  const fractionMatch = /(#+|0+|\?+)?(\s*)(\?+|#+|0+)\/(\?+|#+|0+|\d+)/.exec(section.replace(/"[^"]*"/g, ""));
  if (fractionMatch) {
    const withWhole = !!fractionMatch[1];
    const den = fractionMatch[4];
    const prefixEnd = section.search(/[#0?]/);
    const lastIdx = section.lastIndexOf(den);
    return {
      prefix: prefixEnd > 0 ? section.slice(0, prefixEnd).replace(/["\\_*]|\[[^\]]*\]/g, "") : "",
      suffix: section.slice(lastIdx + den.length).replace(/["\\_*]|\[[^\]]*\]/g, ""),
      intPattern: fractionMatch[1] ?? "",
      decPattern: "",
      grouping: false,
      scaleCommas: 0,
      percentCount: 0,
      hasNumberPattern: true,
      exponent: null,
      fraction: {
        withWhole,
        denominatorDigits: /^\d+$/.test(den) ? 0 : den.length,
        fixedDenominator: /^\d+$/.test(den) ? Number(den) : null,
        numeratorWidth: fractionMatch[3].length,
      },
    };
  }

  let prefix = "";
  let suffix = "";
  let intPattern = "";
  let decPattern = "";
  let grouping = false;
  let scaleCommas = 0;
  let percentCount = 0;
  let inDecimal = false;
  let started = false;
  let ended = false;
  let hasNumberPattern = false;
  let exponent: NumberSection["exponent"] = null;

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
    } else if ((ch === "E" || ch === "e") && started && !ended && /[+-]/.test(section[i + 1] ?? "")) {
      const plus = section[i + 1] === "+";
      let j = i + 2;
      let digits = 0;
      while (section[j] === "0" || section[j] === "#" || section[j] === "?") {
        digits++;
        j++;
      }
      exponent = { digits: Math.max(1, digits), plus };
      ended = true;
      i = j - 1;
    } else if ((ch === "0" || ch === "#" || ch === "?") && !ended) {
      started = true;
      hasNumberPattern = true;
      if (inDecimal) decPattern += ch;
      else intPattern += ch;
    } else if (ch === "," && started && !ended && !inDecimal) {
      // 数字パターンの直後(次が0・#・?でない)のカンマは桁区切りではなく「1000で割る」指定
      const next = section[i + 1] ?? "";
      if (/[0#?]/.test(next)) grouping = true;
      else scaleCommas++;
    } else if (ch === "." && started && !ended && !inDecimal) {
      inDecimal = true;
    } else {
      addLiteral(ch);
    }
  }
  return { prefix, suffix, intPattern, decPattern, grouping, scaleCommas, percentCount, hasNumberPattern, exponent, fraction: null };
}

function bestFraction(frac: number, maxDen: number, fixedDen: number | null): { n: number; d: number } {
  if (fixedDen) return { n: Math.round(frac * fixedDen), d: fixedDen };
  let best = { n: 0, d: 1 };
  let bestErr = Math.abs(frac);
  for (let d = 1; d <= maxDen; d++) {
    const n = Math.round(frac * d);
    const err = Math.abs(frac - n / d);
    if (err < bestErr - 1e-12) {
      best = { n, d };
      bestErr = err;
    }
  }
  return best;
}

function applyNumberSection(abs: number, s: NumberSection): string {
  let value = abs;
  for (let i = 0; i < s.percentCount; i++) value *= 100;
  for (let i = 0; i < s.scaleCommas; i++) value /= 1000;

  if (s.fraction) {
    const f = s.fraction;
    const maxDen = f.denominatorDigits > 0 ? 10 ** f.denominatorDigits - 1 : 0;
    const whole = f.withWhole ? Math.floor(value) : 0;
    let { n, d } = bestFraction(f.withWhole ? value - whole : value, maxDen || 1, f.fixedDenominator);
    let w = whole;
    if (f.withWhole && n === d) {
      w += 1;
      n = 0;
    }
    if (!f.withWhole && f.fixedDenominator === null) {
      // 仮分数(?/?)は、整数部も分子に含める
      const total = bestFraction(value, maxDen || 1, null);
      n = total.n;
      d = total.d;
    }
    const frac = n === 0 && f.withWhole ? " ".repeat(String(d).length * 2 + 1) : `${String(n).padStart(f.numeratorWidth, " ")}/${d}`;
    const wholeText = f.withWhole ? (w === 0 && n !== 0 ? "" : String(w)) : "";
    const joiner = f.withWhole && wholeText !== "" && n !== 0 ? " " : "";
    return `${wholeText}${joiner}${frac}`.trim() === "" ? "0" : `${wholeText}${joiner}${frac}`;
  }

  if (s.exponent) {
    const decimals = s.decPattern.length;
    const intDigits = Math.max(1, (s.intPattern.match(/[0?]/g) ?? []).length);
    // 仮数部の整数部をintDigits桁にそろえる(例: ##0.0E+0 は指数を3の倍数に)
    let exp = value === 0 ? 0 : Math.floor(Math.log10(value));
    if (intDigits > 1) exp -= ((exp % intDigits) + intDigits) % intDigits;
    let mantissa = value === 0 ? 0 : value / 10 ** exp;
    let mText = toFixedExcel(mantissa, decimals);
    if (Number(mText) >= 10 ** intDigits) {
      exp += intDigits;
      mantissa = value / 10 ** exp;
      mText = toFixedExcel(mantissa, decimals);
    }
    const sign = exp < 0 ? "-" : s.exponent.plus ? "+" : "";
    return `${mText}E${sign}${String(Math.abs(exp)).padStart(s.exponent.digits, "0")}`;
  }

  const decimals = s.decPattern.length;
  const text = toFixedExcel(value, decimals);
  let [intPart, decPart = ""] = text.split(".");
  // 先頭の0埋め(0の個数ぶんの桁数まで)。#のみのときは、整数部が0なら空にする(Excelは".5"のように表示する)
  const minInt = (s.intPattern.match(/0/g) ?? []).length;
  if (intPart === "0" && minInt === 0) intPart = "";
  if (intPart.length < minInt) intPart = intPart.padStart(minInt, "0");
  if (s.grouping) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // 小数部のうち#の位置の末尾の0は省く
  const minDec = (s.decPattern.match(/0/g) ?? []).length;
  while (decPart.length > minDec && decPart.endsWith("0")) decPart = decPart.slice(0, -1);
  return decPart ? `${intPart}.${decPart}` : intPart;
}

/** 数値をExcelの書式コードで整形する。解釈できない書式なら null（呼び出し側で標準表示にする） */
export function formatExcelNumber(value: number, code: string | null): string | null {
  if (!code || code === "General" || code === "@") return null;
  if (!Number.isFinite(value)) return null;
  const all = splitSections(code);
  // 4つ目のセクションは文字列用なので、数値の選択には使わない
  const sections = all.length >= 4 ? all.slice(0, 3) : all;
  const conds = sections.map(readCondition);
  const hasConditions = conds.some((c) => c !== null);

  let idx = 0;
  let implicitNegative = false;
  if (hasConditions) {
    idx = sections.length - 1;
    for (let i = 0; i < sections.length; i++) {
      const isLast = i === sections.length - 1;
      const cond = conds[i] ?? (isLast ? null : i === 0 ? ({ op: ">", value: 0 } as Condition) : ({ op: "<", value: 0 } as Condition));
      if (cond && matches(cond, value)) {
        idx = i;
        break;
      }
      if (!cond && isLast) idx = i;
    }
  } else if (value < 0 && sections.length >= 2) {
    idx = 1;
    implicitNegative = true;
  } else if (value === 0 && sections.length >= 3) {
    idx = 2;
  }

  // "General"のセクション(例: General"人")は、標準表示に前後の文字を付ける
  const sectionText = sections[idx] ?? "";
  if (/(^|[^A-Za-z])General([^A-Za-z]|$)/i.test(sectionText.replace(/"[^"]*"/g, ""))) {
    const parts = sectionText.split(/General/i);
    const lit = (t: string) => t.replace(/"([^"]*)"/g, "$1").replace(/\[[^\]]*\]|[_*].|\\/g, "");
    const body = formatGeneralNumber(implicitNegative ? Math.abs(value) : value);
    return `${lit(parts[0] ?? "")}${body}${lit(parts[1] ?? "")}`;
  }

  const section = parseNumberSection(sectionText);
  if (!section || !section.hasNumberPattern) return null;

  // 負数: 専用のセクション(2つ目)を選んだときは符号を付けない(括弧などの書式で表す)。それ以外は先頭に「-」。
  const negativeSign = value < 0 && !implicitNegative ? "-" : "";
  const body = applyNumberSection(Math.abs(value), section);
  return `${negativeSign}${section.prefix}${body}${section.suffix}`;
}

/**
 * 文字列セルの書式(@を含む書式。例: "@\"様\""・"\"No.\"@")。数値用のセクションしか無い書式では
 * 文字列はそのまま表示するのでnullを返す。
 */
export function formatExcelText(text: string, code: string | null): string | null {
  if (!code || code === "General" || code === "@") return null;
  const all = splitSections(code);
  const textSection = all.length >= 4 ? all[3] : all.length === 1 && all[0].includes("@") ? all[0] : null;
  if (textSection === null || !textSection.includes("@")) return null;
  let out = "";
  for (let i = 0; i < textSection.length; i++) {
    const ch = textSection[i];
    if (ch === '"') {
      const end = textSection.indexOf('"', i + 1);
      out += textSection.slice(i + 1, end === -1 ? textSection.length : end);
      i = end === -1 ? textSection.length : end;
    } else if (ch === "\\") {
      out += textSection[i + 1] ?? "";
      i++;
    } else if (ch === "[") {
      const end = textSection.indexOf("]", i + 1);
      i = end === -1 ? textSection.length : end;
    } else if (ch === "_" || ch === "*") {
      i++;
    } else if (ch === "@") {
      out += text;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 書式が「標準」のときの数値の表示。2進数の誤差(0.1+0.2=0.30000000000000004)を丸め、桁数の多い値は指数表記にする */
export function formatGeneralNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = value.toExponential(5).split("e");
    const trimmed = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const sign = e.startsWith("-") ? "-" : "+";
    return `${trimmed}E${sign}${e.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  return String(Number(value.toPrecision(10)));
}
