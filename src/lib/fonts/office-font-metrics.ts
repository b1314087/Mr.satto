import { FONT_METRICS_DATA, type FontMetricsData } from "@/lib/fonts/office-font-metrics-data";

/**
 * Officeの文書(Word・Excel)のフォントの「文字の幅」と「1行の高さ」を求める(Excel→PDF・Word→PDFで共通に使う)。
 *
 * PDFに描く字形は、同梱の Noto Sans JP だけ(Microsoftのフォントは同梱できない)。しかし、行の折り返し・はみ出し・
 * ページの区切りは、文書が指定したフォントの文字の幅と1行の高さで決まる。そこで、描く字形とは別に、
 * 文書のフォントの寸法で行を組む。寸法は次の順に探す。
 *
 *  1. 同梱の寸法の表(office-font-metrics-data.ts)：Calibri・Cambria・Arial・Times New Roman・Courier New・
 *     MS ゴシック/明朝・MS Pゴシック/P明朝。メトリック互換の自由なフォントから取り出した数値なので、
 *     利用者のパソコンに関係なく、いつも同じ結果になる。
 *  2. 表に無いフォント(游明朝・游ゴシック・メイリオ など、自由に使える同じ寸法のフォントが無いもの)は、
 *     同梱の Noto Sans JP の幅(日本語の文字は全角の幅。英数字は Noto の幅)と、近似の行の高さ(文字の大きさ × 1.15)。
 *
 * 利用者のパソコンに入っているフォントをブラウザで測る方式(以前の方式)は使わない。同じファイルでも、パソコン
 * (Windows・Mac・フォントの有無)によって改行の位置・ページの区切りが変わってしまうため(結果の決定性を優先する)。
 */

export type FontMetricsSource = "table" | "embedded" | "fallback";

export interface FontMetrics {
  /** 文書が指定したフォント名 */
  name: string;
  source: FontMetricsSource;
  /** Wordの「1行」の高さ(文字の大きさに対する倍率) */
  lineFactor: number;
  /** 文字の幅(文字の大きさ1ptあたり)。このフォントで分からない文字は null(呼び出し側で、同梱のフォントの幅を使う) */
  widthPerPt(ch: string): number | null;
}

/** フォント名(小文字・空白をそろえたもの) → 寸法の表の名前 */
const TABLE_ALIASES: Record<string, string> = {
  calibri: "carlito",
  "calibri light": "carlito",
  carlito: "carlito",
  cambria: "caladea",
  caladea: "caladea",
  arial: "liberationSans",
  helvetica: "liberationSans",
  "liberation sans": "liberationSans",
  "times new roman": "liberationSerif",
  times: "liberationSerif",
  "liberation serif": "liberationSerif",
  "courier new": "liberationMono",
  courier: "liberationMono",
  "liberation mono": "liberationMono",
  // MS ゴシック・MS 明朝は、どちらも英数字が全角の半分・日本語が全角の固定幅(IPAゴシックと同じ幅)
  "ms gothic": "ipaGothic",
  "ms mincho": "ipaGothic",
  "ｍｓ ゴシック": "ipaGothic",
  "ｍｓ 明朝": "ipaGothic",
  "ms ゴシック": "ipaGothic",
  "ms 明朝": "ipaGothic",
  msゴシック: "ipaGothic",
  ms明朝: "ipaGothic",
  ipagothic: "ipaGothic",
  ipaゴシック: "ipaGothic",
  "ms pgothic": "ipaPGothic",
  "ms pmincho": "ipaPGothic",
  "ｍｓ ｐゴシック": "ipaPGothic",
  "ｍｓ ｐ明朝": "ipaPGothic",
  "ms pゴシック": "ipaPGothic",
  "ms p明朝": "ipaPGothic",
  ipapgothic: "ipaPGothic",
  "ipa pゴシック": "ipaPGothic",
};

/** 同梱の Noto Sans/Serif JP(PDFに描く字形と同じ)。アセント1.160+ディセント0.288 */
const EMBEDDED_ALIASES = new Set(["noto sans jp", "noto sans cjk jp", "noto serif jp", "noto serif cjk jp", "源ノ角ゴシック", "源ノ明朝"]);
const EMBEDDED_LINE_FACTOR = 1.448;

/** 近似の行の高さ(寸法が分からないフォント)。従来のMr.Sattoの値 */
export const FALLBACK_LINE_FACTOR = 1.15;

const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** 表に入っている範囲の文字の位置 */
function tableIndex(code: number): number {
  if (code >= 0x20 && code <= 0x7e) return code - 0x20;
  if (code >= 0xa0 && code <= 0xff) return 0x7f - 0x20 + (code - 0xa0);
  return -1;
}

/** 全角(日本語・全角記号)の文字か */
export function isEastAsianChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x3ffff) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

function fromTable(name: string, data: FontMetricsData): FontMetrics {
  const lineFactor = (data.ascent + data.descent + data.lineGap) / 1000;
  return {
    name,
    source: "table",
    lineFactor,
    widthPerPt(ch) {
      const code = ch.codePointAt(0) ?? 0;
      const i = tableIndex(code);
      if (i >= 0) return data.widths[i] >= 0 ? data.widths[i] / 1000 : null;
      if (code >= 0xff61 && code <= 0xff9f) return data.halfWidthKana !== null ? data.halfWidthKana / 1000 : null;
      if (isEastAsianChar(ch)) return data.fullWidth !== null ? data.fullWidth / 1000 : null;
      return null;
    },
  };
}

const resolved = new Map<string, FontMetrics>();

/**
 * フォント名から寸法を求める(結果は覚えておく)。name が null・空なら、同梱のフォント(近似の行の高さ)。
 */
export function fontMetricsFor(name: string | null | undefined): FontMetrics {
  const key = normalize(name ?? "");
  const hit = resolved.get(key);
  if (hit) return hit;
  let result: FontMetrics;
  const table = TABLE_ALIASES[key];
  if (table && FONT_METRICS_DATA[table]) result = fromTable(name ?? key, FONT_METRICS_DATA[table]);
  else if (EMBEDDED_ALIASES.has(key)) result = { name: name ?? key, source: "embedded", lineFactor: EMBEDDED_LINE_FACTOR, widthPerPt: () => null };
  else result = { name: name ?? key, source: "fallback", lineFactor: FALLBACK_LINE_FACTOR, widthPerPt: () => null };
  resolved.set(key, result);
  return result;
}

/** テスト・診断用：覚えた結果を消す */
export function clearFontMetricsCache() {
  resolved.clear();
}
