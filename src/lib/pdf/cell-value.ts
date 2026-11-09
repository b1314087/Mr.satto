/**
 * PDFから読み取ったセルの文字を、Excelのセルの値（数値・日付・文字）に直す（工程4：記入済みPDF→Excelの精度改善）。
 *
 * 確信を持てる表記だけを数値・日付にし、それ以外は読み取った文字のまま残す（勝手に補完・推測しない）。
 * - 数値：全角数字（１２３）・3桁区切り（1,234）・小数（12.50。桁数を表示形式で保つ）
 * - 金額：「¥1,234」「￥1,234」「1,234円」「1,234-」（金額の後ろの「-」）。表示は元の表記に近い形式にする
 * - マイナス：「-1,234」「−1,234」（全角・数学のマイナス）「△1,234」「▲1,234」「(1,234)」（会計の負数）
 * - 割合：「12.5%」→ 0.125（表示は 12.5%）
 * - 日付：「2026/4/1」「2026-04-01」「2026.4.1」「2026年4月1日」「令和8年4月1日」「R8.4.1」「令和元年5月1日」
 *   （年のない「4月1日」は、年を推測しないため文字のまま）
 * - 先頭が0の番号（001・電話番号・郵便番号など）は、0が消えないよう文字のまま
 * - 空欄は空欄のまま（0にしない）。記号（※・○・☑ など）は文字のまま
 */

export type CellValue =
  | { kind: "empty" }
  | { kind: "text"; value: string }
  | { kind: "number"; value: number; format?: string }
  | { kind: "date"; value: Date; format: string };

/** 全角の英数字・記号を半角に直す（数値・日付の判定のためだけに使う。文字のセルは元の表記のまま残す） */
export function toHalfWidthForParse(text: string): string {
  return text
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，]/g, ",")
    .replace(/[．]/g, ".")
    .replace(/[／]/g, "/")
    .replace(/[％]/g, "%")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[＋]/g, "+")
    .replace(/[−－‐‑‒–—]/g, "-")
    .replace(/[　]/g, " ");
}

const ERA_START_YEAR: Record<string, number> = {
  令和: 2018,
  r: 2018,
  平成: 1988,
  h: 1988,
  昭和: 1925,
  s: 1925,
};

function utcDate(y: number, mo: number, d: number): Date | null {
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  // write-excel-file はDateをUTC基準でExcelのシリアル値に変換するため、UTCの0時で作る（1日ずれないように）
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** 日付として確かな表記なら Date（UTCの0時）を返す */
export function parseDateText(raw: string): Date | null {
  const t = toHalfWidthForParse(raw).trim().replace(/\s+/g, "");
  let m = t.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
  if (m) return utcDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return utcDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(令和|平成|昭和)(元|\d{1,2})年(\d{1,2})月(\d{1,2})日?$/);
  if (m) return utcDate(ERA_START_YEAR[m[1]] + (m[2] === "元" ? 1 : +m[2]), +m[3], +m[4]);
  m = t.match(/^([RrHhSs])(元|\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{1,2})$/);
  if (m) return utcDate(ERA_START_YEAR[m[1].toLowerCase()] + (m[2] === "元" ? 1 : +m[2]), +m[3], +m[4]);
  return null;
}

const PLAIN_NUMBER_RE = /^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$/;

function decimals(numText: string): number {
  const m = numText.match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

function numberFormat(hasComma: boolean, places: number, prefix = "", suffix = ""): string | undefined {
  const base = `${hasComma ? "#,##0" : "0"}${places > 0 ? `.${"0".repeat(places)}` : ""}`;
  if (!hasComma && places === 0 && !prefix && !suffix) return undefined;
  const p = prefix ? `"${prefix}"` : "";
  const s = suffix ? `"${suffix}"` : "";
  return `${p}${base}${s};-${p}${base}${s}`;
}

/** 読み取ったセルの文字を、Excelのセルの値に直す */
export function parseCellValue(raw: string): CellValue {
  const original = raw.trim();
  if (original === "") return { kind: "empty" };
  // 改行を含む（複数行の記入）ものは、文字のまま残す
  if (/\n/.test(original)) return { kind: "text", value: original };

  const date = parseDateText(original);
  if (date) return { kind: "date", value: date, format: "yyyy/mm/dd" };

  let t = toHalfWidthForParse(original).replace(/\s+/g, "");
  let negative = false;
  let prefix = "";
  let suffix = "";
  // 会計の負数（括弧）・△▲
  const paren = t.match(/^\((.+)\)$/);
  if (paren) {
    negative = true;
    t = paren[1];
  }
  if (/^[△▲]/.test(t)) {
    negative = true;
    t = t.slice(1);
  }
  if (/^-/.test(t)) {
    negative = !negative;
    t = t.slice(1);
  } else if (/^\+/.test(t)) {
    t = t.slice(1);
  }
  // 通貨記号・単位
  if (/^[¥￥\\]/.test(t)) {
    prefix = "¥";
    t = t.slice(1);
    if (/^-/.test(t)) {
      negative = !negative;
      t = t.slice(1);
    }
  }
  if (/円$/.test(t)) {
    suffix = "円";
    t = t.slice(0, -1);
  }
  // 金額の後ろの「-」「也」（例：¥1,000-）
  if (prefix && /[-也]$/.test(t)) t = t.slice(0, -1);
  if (/%$/.test(t)) {
    const body = t.slice(0, -1);
    if (!PLAIN_NUMBER_RE.test(body)) return { kind: "text", value: original };
    const n = Number(body.replace(/,/g, ""));
    if (!Number.isFinite(n)) return { kind: "text", value: original };
    const places = decimals(body);
    return { kind: "number", value: (negative ? -n : n) / 100, format: `0${places > 0 ? `.${"0".repeat(places)}` : ""}%` };
  }
  if (!PLAIN_NUMBER_RE.test(t)) return { kind: "text", value: original };
  // 先頭が0の番号（001・電話番号・郵便番号など）は文字のまま（小数の 0.5 は数値）
  if (/^0\d/.test(t)) return { kind: "text", value: original };
  // 15桁を超える数字は、Excelで桁が丸められるため文字のまま
  if (t.replace(/[,.]/g, "").length > 15) return { kind: "text", value: original };
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return { kind: "text", value: original };
  return { kind: "number", value: negative ? -n : n, format: numberFormat(t.includes(","), decimals(t), prefix, suffix) };
}

/** write-excel-file に渡すセルの形 */
export type ExcelWriteCell =
  | null
  | string
  | number
  | { value: number; type: NumberConstructor; format: string }
  | { value: Date; type: DateConstructor; format: string };

/** 読み取ったセルの文字を、write-excel-file のセルにする */
export function toExcelWriteCell(raw: string): ExcelWriteCell {
  const v = parseCellValue(raw);
  if (v.kind === "empty") return "";
  if (v.kind === "text") return v.value;
  if (v.kind === "date") return { value: v.value, type: Date, format: v.format };
  return v.format ? { value: v.value, type: Number, format: v.format } : v.value;
}
