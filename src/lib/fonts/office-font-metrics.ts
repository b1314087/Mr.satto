import { FONT_ALIASES, FONT_METRICS_DATA, type FontMetricsData } from "@/lib/fonts/office-font-metrics-data";

/**
 * Officeの文書(Word・Excel)のフォントの「文字の幅」と「1行の高さ」を求める(Excel→PDF・Word→PDFで共通に使う)。
 *
 * PDFに描く字形は、同梱の Noto Sans JP だけ(Microsoftのフォントは同梱できない)。しかし、行の折り返し・はみ出し・
 * ページの区切りは、文書が指定したフォントの文字の幅と1行の高さで決まる。そこで、描く字形とは別に、
 * 文書のフォントの寸法で行を組み、描くときは Noto の字形を、その寸法の幅に横に伸び縮みさせて置く
 * (行を組む計算の位置と、PDFの文字の位置が、いつも一致する)。寸法は次の順に探す。
 *
 *  1. 同梱の寸法の表(office-font-metrics-data.ts。scripts/fonts/generate_office_font_metrics.py が作る):
 *     游ゴシック・游明朝・メイリオ・MS ゴシック/明朝・Century・Calibri・Cambria・Aptos・HG フォントは、実際の
 *     Officeのフォントから取り出した数値。Arial・Times New Roman・Courier New は、メトリック互換の自由なフォントの数値。
 *     数値だけなので、利用者のパソコンに関係なく、いつも同じ結果になる。
 *  2. 表に無いフォントは、同梱の Noto Sans JP の幅(日本語は全角の幅)と、近似の行の高さ(文字の大きさ × 1.15)。
 *
 * 1行の高さは、Windowsの文字の描画(GDI)の決まり(OpenTypeの仕様 OS/2 の説明):
 *   高さ = usWinAscent + usWinDescent + 外部の行間、外部の行間 = max(0, hhea.lineGap − ((usWinAscent + usWinDescent) − (hhea.ascender − hhea.descender)))
 * (例 Calibri 1.2207、メイリオ 1.5、MS 明朝 1.0、游ゴシック・游明朝 約1.60)。Word・Excelは、この高さで「1行」を決める。
 *
 * 利用者のパソコンに入っているフォントをブラウザで測る方式は使わない。同じファイルでも、パソコン
 * (Windows・Mac・フォントの有無)によって改行の位置・ページの区切りが変わってしまうため(結果の決定性を優先する)。
 */

export type FontMetricsSource = "table" | "embedded" | "fallback";

export interface FontMetrics {
  /** 文書が指定したフォント名 */
  name: string;
  source: FontMetricsSource;
  /** 「1行」の高さ(文字の大きさに対する倍率) */
  lineFactor: number;
  /** 文字の上端から、文字の並ぶ線(ベースライン)までの高さ(文字の大きさに対する倍率) */
  ascentFactor: number;
  /** 文字の幅(文字の大きさ1ptあたり)。bold は太字。このフォントで分からない文字は null(呼び出し側で、同梱のフォントの幅を使う) */
  widthPerPt(ch: string, bold?: boolean): number | null;
}

/** 同梱の Noto Sans/Serif JP(PDFに描く字形と同じ)。アセント1.160+ディセント0.288 */
const EMBEDDED_ALIASES = new Set(["noto sans jp", "noto sans cjk jp", "noto serif jp", "noto serif cjk jp", "源ノ角ゴシック", "源ノ明朝"]);
const EMBEDDED_LINE_FACTOR = 1.448;

/** 近似の行の高さ(寸法が分からないフォント)。従来のMr.Sattoの値 */
export const FALLBACK_LINE_FACTOR = 1.15;

/** フォント名をそろえる(全角・半角の英数字とカタカナ、大文字・小文字、空白の違いをなくす。生成スクリプトの norm と同じ) */
const normalize = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

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

/** 表の数値から、GDIの決まりでの「1行」の高さ(1em=1000 → 倍率) */
export function gdiLineFactor(d: FontMetricsData): number {
  const win = d.winAscent + d.winDescent;
  const external = Math.max(0, d.lineGap - (win - (d.ascent + d.descent)));
  return (win + external) / 1000;
}

function widthFrom(data: FontMetricsData, ch: string): number | null {
  const code = ch.codePointAt(0) ?? 0;
  const i = tableIndex(code);
  if (i >= 0) return data.widths[i] >= 0 ? data.widths[i] / 1000 : null;
  const special = data.cjk[String(code)];
  if (special !== undefined) return special / 1000;
  if (code >= 0xff61 && code <= 0xff9f) return data.halfWidthKana !== null ? data.halfWidthKana / 1000 : null;
  if (isEastAsianChar(ch)) return data.fullWidth !== null ? data.fullWidth / 1000 : null;
  return null;
}

function fromTable(name: string, data: FontMetricsData): FontMetrics {
  const bold = data.bold ? FONT_METRICS_DATA[data.bold] : undefined;
  return {
    name,
    source: "table",
    lineFactor: gdiLineFactor(data),
    ascentFactor: data.winAscent / 1000,
    widthPerPt(ch, isBold) {
      return widthFrom(isBold && bold ? bold : data, ch);
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
  const table = FONT_ALIASES[key];
  if (table && FONT_METRICS_DATA[table]) result = fromTable(name ?? key, FONT_METRICS_DATA[table]);
  else if (EMBEDDED_ALIASES.has(key)) result = { name: name ?? key, source: "embedded", lineFactor: EMBEDDED_LINE_FACTOR, ascentFactor: 1.16, widthPerPt: () => null };
  else result = { name: name ?? key, source: "fallback", lineFactor: FALLBACK_LINE_FACTOR, ascentFactor: 0.9, widthPerPt: () => null };
  resolved.set(key, result);
  return result;
}

/** テスト・診断用：覚えた結果を消す */
export function clearFontMetricsCache() {
  resolved.clear();
}
