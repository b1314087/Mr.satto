/**
 * Excelの日付・時刻の表示書式コード（"yyyy/m/d"・"yyyy\"年\"m\"月\"d\"日\""・"[$-411]ggge\"年\"m\"月\"d\"日\"" 等）を
 * 解釈して、DateをExcelと同じ見た目の文字列へ整形する。
 *
 * read-excel-fileは日付セルを「Date型」で返すが、どう表示するか(書式)の情報は持たない。
 * 以前は常に "YYYY-MM-DD" 形式(時刻が0時でなければ時刻付き)で出力していたため、
 * Excelで「2026/9/25」と表示されている日付が「2026-09-25 09:00:00」のようになっていた。
 * (read-excel-fileはExcelの日付シリアル値をUTCの0時として返す。それを日本時間の
 *  ローカル時刻で読み取ると9時間ずれて「09:00:00」になるため、必ずUTCのゲッターで読む。)
 *
 * 対応する書式記号は実用上よく使われるものに絞っている（完全互換は謳わない）:
 *   年 yyyy / yy、月 m / mm / mmm / mmmm、日 d / dd / ddd / dddd、曜日 aaa / aaaa、
 *   時 h / hh、分 m / mm(時・秒の隣にあるとき)、秒 s / ss、AM/PM、
 *   和暦 g / gg / ggg(元号)・e / ee(元号の年)、引用符"..."と\x のリテラル。
 *   [$-411]等の言語指定や[Red]等の色指定、_x・*x(桁揃え・繰り返し)は読み飛ばす。
 */

const ERAS: { name: string; short: string; roman: string; start: number }[] = [
  { name: "令和", short: "令", roman: "R", start: Date.UTC(2019, 4, 1) },
  { name: "平成", short: "平", roman: "H", start: Date.UTC(1989, 0, 8) },
  { name: "昭和", short: "昭", roman: "S", start: Date.UTC(1926, 11, 25) },
  { name: "大正", short: "大", roman: "T", start: Date.UTC(1912, 6, 30) },
  { name: "明治", short: "明", roman: "M", start: Date.UTC(1868, 0, 25) },
];

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_EN_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Token =
  | { kind: "lit"; text: string }
  | { kind: "y" | "m" | "d" | "h" | "s" | "aaa" | "g" | "e"; len: number }
  | { kind: "ampm"; text: string };

function tokenize(code: string): Token[] {
  // 最初のセクション(;区切りの1つ目)だけを使う
  const sectionEnd = (() => {
    let inQuote = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === "\\") i++;
      else if (ch === ";" && !inQuote) return i;
    }
    return code.length;
  })();
  const src = code.slice(0, sectionEnd);

  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      const text = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
      tokens.push({ kind: "lit", text });
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < src.length) tokens.push({ kind: "lit", text: src[i + 1] });
      i += 2;
      continue;
    }
    if (ch === "[") {
      const end = src.indexOf("]", i + 1);
      i = end === -1 ? src.length : end + 1; // [$-411]・[Red]・[h]等は読み飛ばす
      continue;
    }
    if (ch === "_" || ch === "*") {
      i += 2; // 桁揃え・繰り返しの指定は読み飛ばす
      continue;
    }
    const rest = src.slice(i);
    const ampm = /^(AM\/PM|am\/pm|A\/P|a\/p)/.exec(rest);
    if (ampm) {
      tokens.push({ kind: "ampm", text: ampm[1] });
      i += ampm[1].length;
      continue;
    }
    const run = /^(y+|m+|d+|h+|s+|a+|g+|e+)/i.exec(rest);
    if (run) {
      const text = run[1];
      const kind = text[0].toLowerCase();
      if (kind === "y" || kind === "m" || kind === "d" || kind === "h" || kind === "s" || kind === "g" || kind === "e") {
        tokens.push({ kind, len: text.length });
      } else {
        tokens.push({ kind: "aaa", len: text.length });
      }
      i += text.length;
      continue;
    }
    tokens.push({ kind: "lit", text: ch });
    i += 1;
  }
  return tokens;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function eraFor(date: Date): { era: (typeof ERAS)[number]; year: number } | null {
  const t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  for (const era of ERAS) {
    if (t >= era.start) return { era, year: date.getUTCFullYear() - new Date(era.start).getUTCFullYear() + 1 };
  }
  return null;
}

/** 日付値が時刻成分(0時0分0秒以外)を持つか。UTCで判定する(read-excel-fileの仕様) */
export function hasTimePart(date: Date): boolean {
  return date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0;
}

/**
 * Dateを、Excelの書式コードに従った文字列へ整形する。codeがnullのときは、日付だけなら
 * 日本語環境のExcelの既定表示(yyyy/m/d)、時刻成分があれば「yyyy/m/d h:mm」とする。
 */
export function formatExcelDate(date: Date, code: string | null): string {
  const effectiveCode = code ?? (hasTimePart(date) ? "yyyy/m/d h:mm" : "yyyy/m/d");
  const tokens = tokenize(effectiveCode);
  const hasAmPm = tokens.some((t) => t.kind === "ampm");

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const weekday = date.getUTCDay();
  const era = eraFor(date);

  // "m"が「月」か「分」かは、直前(または直後)が時(h)・秒(s)のときだけ分として扱う(Excelと同じ規則)
  const nonLit = tokens.filter((t) => t.kind !== "lit");
  const isMinute = (tok: Token): boolean => {
    if (tok.kind !== "m") return false;
    const idx = nonLit.indexOf(tok);
    const prev = idx > 0 ? nonLit[idx - 1] : null;
    const next = idx < nonLit.length - 1 ? nonLit[idx + 1] : null;
    return prev?.kind === "h" || next?.kind === "s";
  };

  let out = "";
  for (const tok of tokens) {
    switch (tok.kind) {
      case "lit":
        out += tok.text;
        break;
      case "y":
        out += tok.len <= 2 ? pad2(year % 100) : String(year).padStart(4, "0");
        break;
      case "m":
        if (isMinute(tok)) {
          out += tok.len >= 2 ? pad2(minutes) : String(minutes);
        } else if (tok.len === 1) out += String(month);
        else if (tok.len === 2) out += pad2(month);
        else out += `${month}月`;
        break;
      case "d":
        if (tok.len === 1) out += String(day);
        else if (tok.len === 2) out += pad2(day);
        else if (tok.len === 3) out += WEEKDAYS_EN[weekday];
        else out += WEEKDAYS_EN_LONG[weekday];
        break;
      case "aaa":
        out += tok.len <= 3 ? WEEKDAYS_JA[weekday] : `${WEEKDAYS_JA[weekday]}曜日`;
        break;
      case "h": {
        const h = hasAmPm ? hours % 12 || 12 : hours;
        out += tok.len >= 2 ? pad2(h) : String(h);
        break;
      }
      case "s":
        out += tok.len >= 2 ? pad2(seconds) : String(seconds);
        break;
      case "ampm":
        out += hours < 12 ? (tok.text.length === 1 ? "A" : "AM") : tok.text.length === 1 ? "P" : "PM";
        break;
      case "g":
        out += era ? (tok.len >= 3 ? era.era.name : tok.len === 2 ? era.era.short : era.era.roman) : "";
        break;
      case "e":
        out += era ? (tok.len >= 2 ? pad2(era.year) : String(era.year)) : String(year);
        break;
    }
  }
  return out;
}
