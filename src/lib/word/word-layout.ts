/**
 * Word→PDFの行の組み立て（折り返し・タブ位置・中央/右揃え・両端揃え）。
 * フォントや描画に依存しない純粋な計算だけを行う（文字ごとの幅を渡すと、各文字の位置を返す）。
 */

export interface TabStopSpec {
  pos: number;
  kind: "left" | "right" | "center" | "decimal";
}

export interface LayoutParams {
  /** 1行目の開始位置（本文の左端からの距離） */
  firstX: number;
  /** 2行目以降の開始位置 */
  contX: number;
  /** 右端（本文の左端からの距離） */
  maxX: number;
  tabs: TabStopSpec[];
  defaultTab: number;
  align: "left" | "center" | "right" | "justify";
  /** 改行の決まり(禁則)。省略時は Word の既定(禁則あり・標準のレベル・ぶら下げあり・英単語の途中で改行しない) */
  breaking?: BreakRules;
}

/** 行の折り返しの決まり(Wordの段落の設定 w:kinsoku・w:wordWrap・w:overflowPunct と、文書の禁則の設定) */
export interface BreakRules {
  /** 日本語の禁則処理を行うか */
  kinsoku: boolean;
  /** 英単語の途中では改行しない(false なら、どこでも改行できる) */
  wordWrap: boolean;
  /** 句読点(、。，．)を行末にぶら下げる */
  overflowPunct: boolean;
  /** 行頭に置かない文字・行末に置かない文字(禁則の文字の一覧) */
  noLineStart: Set<string>;
  noLineEnd: Set<string>;
  /** この文字の後ろでは、英数字の単語の途中でも改行してよい(既定はハイフン) */
  breakAfter?: Set<string>;
}

/**
 * Wordの禁則の文字(「標準」のレベル)。行頭に置かない文字(閉じ括弧・句読点・繰り返し記号など)と、行末に置かない文字(開き括弧など)。
 * 「高レベル」(settings.xml の w:strictFirstAndLastChars)は、小さい仮名・長音記号なども行頭に置かない。
 */
export const KINSOKU_STANDARD_START = "!%),.:;?]}¢°’”‰′″℃、。々〉》」』】〕゛゜ゝゞ・ヽヾ！％），．：；？］｝｡｣､･ﾞﾟ￠";
export const KINSOKU_STRICT_START = KINSOKU_STANDARD_START + "ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿーｧｨｩｪｫｯｬｭｮｰ‐゠–〜～";
export const KINSOKU_LINE_END = "$([\\{£¥‘“〈《「『【〔＄（［｛｢￡￥";

export function defaultBreakRules(): BreakRules {
  return { kinsoku: true, wordWrap: true, overflowPunct: true, noLineStart: new Set(Array.from(KINSOKU_STANDARD_START)), noLineEnd: new Set(Array.from(KINSOKU_LINE_END)) };
}

/** 行末にぶら下げてよい句読点(Wordの「句読点のぶら下げ」) */
const HANGING_PUNCT = new Set(Array.from("、。，．､｡"));
/** 英数字の単語の途中でも、この文字の後ろでは改行できる(ハイフン) */
const DEFAULT_BREAK_AFTER = new Set(["-"]);
/** 2つ続けたとき、間で改行しない文字(分離禁止：…… ‥‥ ——) */
const INSEPARABLE = new Set(Array.from("…‥—―"));

export interface PlacedItem {
  /** 入力の何文字目か */
  index: number;
  x: number;
  width: number;
}

export interface LayoutLine {
  items: PlacedItem[];
  startX: number;
  endX: number;
  /** 明示的な改行（Shift+Enter）で終わった行 */
  explicitBreak: boolean;
  hasTab: boolean;
  /** 改行の文字(\n)で終わった行のとき、その改行の文字の位置 */
  breakIndex?: number;
}

/** 英数字の単語を作る文字(この文字の間では行を折り返さない)。日本語の文字・空白・記号の一部は区切りになる */
function isWordChar(ch: string): boolean {
  return /^[A-Za-z0-9@#$%&*+=_\-.,'"/:;!?()[\]{}<>~^|\\\u00C0-\u024F]$/.test(ch);
}

function nextTabStop(x: number, tabs: TabStopSpec[], defaultTab: number): TabStopSpec {
  for (const t of tabs) if (t.pos > x + 0.01) return t;
  const step = defaultTab > 0 ? defaultTab : 36;
  return { pos: (Math.floor((x + 0.01) / step) + 1) * step, kind: "left" };
}

/** 文字ごとの幅（widths）と文字（chars。タブは "\t"、改行は "\n"）から、行ごとの配置を求める */
export function layoutParagraph(chars: string[], widths: number[], p: LayoutParams): LayoutLine[] {
  const tabs = [...p.tabs].sort((a, b) => a.pos - b.pos);
  const rules = p.breaking ?? defaultBreakRules();
  const lines: LayoutLine[] = [];
  let items: PlacedItem[] = [];
  let x = p.firstX;
  let startX = p.firstX;
  let hasTab = false;

  const closeLine = (explicitBreak: boolean, breakIndex?: number) => {
    const endX = items.length > 0 ? items[items.length - 1].x + items[items.length - 1].width : startX;
    lines.push({ items, startX, endX: Math.max(endX, startX), explicitBreak, hasTab, ...(breakIndex !== undefined ? { breakIndex } : {}) });
    items = [];
    hasTab = false;
    startX = p.contX;
    x = p.contX;
  };

  const widthUntilBreak = (from: number) => {
    let w = 0;
    for (let j = from; j < chars.length; j++) {
      if (chars[j] === "\t" || chars[j] === "\n") break;
      w += widths[j];
    }
    return w;
  };

  /**
   * 文字 i の前(文字 i-1 と i の間)で改行してよいか。
   * 空白の後ろ・日本語の文字の前後では改行できる。英数字の単語の途中・空白の前・禁則の文字の前後・分離禁止の文字の間では改行しない
   */
  const canBreakBefore = (i: number): boolean => {
    if (i <= 0 || i >= chars.length) return false;
    const a = chars[i - 1];
    const b = chars[i];
    if (b === " " || b === "\u3000") return false; // 空白は行末にぶら下げる(行頭に送らない)
    if (a === "\t") return true;
    if (a === " " || a === "\u3000") return true;
    if (rules.kinsoku) {
      if (rules.noLineStart.has(b)) return false;
      if (rules.noLineEnd.has(a)) return false;
      if (INSEPARABLE.has(a) && a === b) return false;
    }
    if (isWordChar(a) && isWordChar(b)) return !rules.wordWrap || (rules.breakAfter ?? DEFAULT_BREAK_AFTER).has(a);
    return true;
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      closeLine(true, i);
      continue;
    }
    if (ch === "\t") {
      const stop = nextTabStop(x, tabs, p.defaultTab);
      let target = stop.pos;
      if (stop.kind === "right") target = Math.max(x, stop.pos - widthUntilBreak(i + 1));
      else if (stop.kind === "center") target = Math.max(x, stop.pos - widthUntilBreak(i + 1) / 2);
      target = Math.min(target, p.maxX);
      items.push({ index: i, x, width: Math.max(0, target - x) });
      x = target;
      hasTab = true;
      continue;
    }
    const w = widths[i];
    // 行末の空白は、余白にはみ出しても次の行へ送らない(Wordと同じ)
    if ((ch === " " || ch === "\u3000") && x + w > p.maxX + 0.01) {
      items.push({ index: i, x, width: 0 });
      continue;
    }
    if (x + w > p.maxX + 0.01 && items.some((it) => chars[it.index] !== "\t")) {
      // 句読点のぶら下げ：行末の句読点は、1文字だけ右の余白にはみ出して置く
      const lastItem = items[items.length - 1];
      const hangs =
        rules.kinsoku && rules.overflowPunct && HANGING_PUNCT.has(ch) && x <= p.maxX + 0.01 && !(lastItem && HANGING_PUNCT.has(chars[lastItem.index]) && lastItem.x + lastItem.width > p.maxX + 0.01);
      if (!hangs) {
        // この行の中で、いちばん後ろの「改行してよい位置」で改行する(禁則・英単語の途中を避ける)。
        // 無ければ(1つの単語が行より長いなど)、この文字の前で改行する
        const lineStart = items.length > 0 ? items[0].index : i;
        let b = -1;
        for (let k = i; k > lineStart; k--) {
          if (canBreakBefore(k)) {
            b = k;
            break;
          }
        }
        if (b > lineStart && b < i) {
          // 改行の位置から後ろの文字を、次の行で組み直す(タブの位置も計算し直すため)
          items = items.filter((it) => it.index < b);
          closeLine(false);
          i = b - 1;
          continue;
        }
        closeLine(false);
      }
    }
    items.push({ index: i, x, width: w });
    x += w;
  }
  closeLine(true);

  // 配置
  const lastIndex = lines.length - 1;
  lines.forEach((line, li) => {
    if (line.items.length === 0) return;
    const avail = p.maxX - line.endX;
    if (p.align === "right" && !line.hasTab) shift(line, avail);
    else if (p.align === "center" && !line.hasTab) shift(line, avail / 2);
    else if (p.align === "justify" && !line.hasTab && li !== lastIndex && !line.explicitBreak && line.items.length > 1) {
      // 両端揃え(Wordと同じ)：行末の空白は数えない。広げるのは「空白」と「日本語などの文字の前後」の間だけで、
      // 英数字の単語の文字と文字の間は広げない(広げる所が無い行は、左揃えのまま)
      let last = line.items.length - 1;
      while (last > 0 && chars[line.items[last].index] === " ") last--;
      const end = line.items[last].x + line.items[last].width;
      const room = p.maxX - end;
      if (room <= 0) return;
      const expandable: boolean[] = [];
      let gaps = 0;
      for (let k = 0; k < last; k++) {
        const a = chars[line.items[k].index];
        const b = chars[line.items[k + 1].index];
        const ok = a === " " || (b !== " " && !(isWordChar(a) && isWordChar(b)));
        expandable.push(ok);
        if (ok) gaps++;
      }
      if (gaps === 0) return;
      const add = room / gaps;
      let shiftBy = 0;
      line.items.forEach((it, k) => {
        it.x += shiftBy;
        if (k < last && expandable[k]) shiftBy += add;
      });
      line.endX = p.maxX;
    }
  });
  return lines;
}

function shift(line: LayoutLine, dx: number) {
  if (dx <= 0) return;
  for (const it of line.items) it.x += dx;
  line.startX += dx;
  line.endX += dx;
}
