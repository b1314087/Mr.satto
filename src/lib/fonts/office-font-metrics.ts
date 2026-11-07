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
 *  2. 利用者のパソコンに入っているフォントを、ブラウザの中で測る(游明朝・游ゴシック・メイリオ など、
 *     寸法の表を同梱できないフォント)。ファイルの内容は外に送らない(ブラウザの中で文字の幅を測るだけ)。
 *  3. どちらも無いときは、同梱の Noto Sans JP の幅と、近似の行の高さ(文字の大きさ × 1.15)。
 */

export type FontMetricsSource = "table" | "system" | "embedded" | "fallback";

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

/** パソコンに入っているかを確かめるときの、別名(Windows・macOSで名前が違うフォント) */
const SYSTEM_ALIASES: Record<string, string[]> = {
  游ゴシック: ["Yu Gothic", "YuGothic", "游ゴシック", "游ゴシック体"],
  "yu gothic": ["Yu Gothic", "YuGothic", "游ゴシック体"],
  游ゴシック体: ["YuGothic", "Yu Gothic", "游ゴシック体"],
  "游ゴシック medium": ["Yu Gothic Medium", "Yu Gothic", "YuGothic"],
  "yu gothic medium": ["Yu Gothic Medium", "Yu Gothic", "YuGothic"],
  游明朝: ["Yu Mincho", "YuMincho", "游明朝", "游明朝体"],
  "yu mincho": ["Yu Mincho", "YuMincho", "游明朝体"],
  游明朝体: ["YuMincho", "Yu Mincho", "游明朝体"],
  メイリオ: ["Meiryo", "メイリオ"],
  meiryo: ["Meiryo", "メイリオ"],
};

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

// ---- パソコンに入っているフォントを、ブラウザの中で測る ----
type Ctx2D = { font: string; measureText(t: string): { width: number; fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number } };
let measureCtx: Ctx2D | null | undefined;
function getMeasureContext(): Ctx2D | null {
  if (measureCtx !== undefined) return measureCtx;
  measureCtx = null;
  try {
    if (typeof OffscreenCanvas !== "undefined") measureCtx = new OffscreenCanvas(8, 8).getContext("2d") as unknown as Ctx2D | null;
    else if (typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d") as unknown as Ctx2D | null;
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

const PROBE = "mmmmmmmmmmlli漢字あア12345WWW";
/** そのフォントがパソコンに入っているか(入っていなければ、ブラウザは代わりのフォントで描くので、幅が代わりのフォントと同じになる) */
function isInstalled(ctx: Ctx2D, family: string): boolean {
  for (const generic of ["monospace", "serif", "sans-serif"]) {
    ctx.font = `100px ${generic}`;
    const base = ctx.measureText(PROBE).width;
    ctx.font = `100px "${family}", ${generic}`;
    if (Math.abs(ctx.measureText(PROBE).width - base) > 0.5) return true;
  }
  return false;
}

function fromSystem(name: string, family: string, ctx: Ctx2D): FontMetrics {
  const cache = new Map<string, number>();
  ctx.font = `100px "${family}"`;
  const m = ctx.measureText("あAg");
  const asc = m.fontBoundingBoxAscent;
  const desc = m.fontBoundingBoxDescent;
  // ブラウザが返す高さは、フォントのアセント+ディセント(行間を含まない)。測れないときは近似
  const lineFactor = asc !== undefined && desc !== undefined && asc + desc > 50 ? (asc + desc) / 100 : FALLBACK_LINE_FACTOR;
  return {
    name,
    source: "system",
    lineFactor,
    widthPerPt(ch) {
      const hit = cache.get(ch);
      if (hit !== undefined) return hit;
      ctx.font = `100px "${family}"`;
      const w = ctx.measureText(ch).width / 100;
      cache.set(ch, w);
      return w;
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
  else {
    const ctx = key ? getMeasureContext() : null;
    const candidates = ctx ? [...(SYSTEM_ALIASES[key] ?? []), name ?? ""].filter(Boolean) : [];
    const family = ctx ? candidates.find((f) => isInstalled(ctx, f)) : undefined;
    result = ctx && family ? fromSystem(name ?? key, family, ctx) : { name: name ?? key, source: "fallback", lineFactor: FALLBACK_LINE_FACTOR, widthPerPt: () => null };
  }
  resolved.set(key, result);
  return result;
}

/** テスト・診断用：覚えた結果を消す */
export function clearFontMetricsCache() {
  resolved.clear();
}
