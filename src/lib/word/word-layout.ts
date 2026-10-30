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
}

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
}

/** 行頭に置いてはいけない文字（句読点・閉じ括弧・小さい仮名・長音） */
const NO_LINE_START = new Set(Array.from("、。，．,.)）」』】〕〉》］｝!?！？:;：；ー々ゝゞ・ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ”’"));
/** 行末に置いてはいけない文字（開き括弧） */
const NO_LINE_END = new Set(Array.from("(（「『【〔〈《［｛“‘"));

function nextTabStop(x: number, tabs: TabStopSpec[], defaultTab: number): TabStopSpec {
  for (const t of tabs) if (t.pos > x + 0.01) return t;
  const step = defaultTab > 0 ? defaultTab : 36;
  return { pos: (Math.floor((x + 0.01) / step) + 1) * step, kind: "left" };
}

/** 文字ごとの幅（widths）と文字（chars。タブは "\t"、改行は "\n"）から、行ごとの配置を求める */
export function layoutParagraph(chars: string[], widths: number[], p: LayoutParams): LayoutLine[] {
  const tabs = [...p.tabs].sort((a, b) => a.pos - b.pos);
  const lines: LayoutLine[] = [];
  let items: PlacedItem[] = [];
  let x = p.firstX;
  let startX = p.firstX;
  let hasTab = false;

  const closeLine = (explicitBreak: boolean) => {
    const endX = items.length > 0 ? items[items.length - 1].x + items[items.length - 1].width : startX;
    lines.push({ items, startX, endX: Math.max(endX, startX), explicitBreak, hasTab });
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

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\n") {
      closeLine(true);
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
    if (x + w > p.maxX + 0.01 && items.some((it) => chars[it.index] !== "\t")) {
      // 行頭禁則: 句読点・閉じ括弧は行末にぶら下げる（次の行頭に置かない）
      const hangs = NO_LINE_START.has(ch) && x + w <= p.maxX + w * 1.2;
      if (!hangs) {
        // 行末禁則: 開き括弧が行末に残るときは、次の行へ送る
        const last = items[items.length - 1];
        const carry = last && NO_LINE_END.has(chars[last.index]) && items.length > 1 ? items.pop()! : null;
        closeLine(false);
        if (carry) {
          items.push({ index: carry.index, x: p.contX, width: carry.width });
          x = p.contX + carry.width;
        }
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
    else if (p.align === "justify" && !line.hasTab && li !== lastIndex && !line.explicitBreak && line.items.length > 1 && avail > 0) {
      const gaps = line.items.length - 1;
      const add = avail / gaps;
      line.items.forEach((it, k) => {
        it.x += add * k;
      });
      line.endX += avail;
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
