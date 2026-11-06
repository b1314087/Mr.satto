/**
 * グラフの分類の軸の目盛りの文字(項目名)の並べ方を決める。
 *
 * 項目の数・項目名の長さ・1項目あたりの幅から、重ならない表示のしかたを選ぶ。
 *   1. 横書きのまま全部入る           → 横書き
 *   2. 折り返せば全部入る(3行まで)     → 折り返し(日本語は読みやすい位置で改行)
 *   3. 斜め(45度)にすれば全部入る     → 斜め
 *   4. それでも入らない                → 間引き(短い項目名は横書きのまま、長い項目名は斜めにして間引く)
 * Excel側で間隔(tickLblSkip)・角度(txPrのrot)が指定されていれば、それを優先する(自動の調整と混ぜない)。
 *
 * 間引くのは文字(ラベル)だけで、系列のデータは減らさない。先頭の項目は必ず、末尾の項目もできるだけ表示する。
 * 長すぎる項目名は、グラフ全体を崩さないよう、決めた範囲に入るところで「…」で切る。
 */

export interface CategoryLabelInput {
  labels: string[];
  /** 1項目あたりの軸方向の長さ(pt) */
  slotLen: number;
  /** 文字の大きさ(pt) */
  size: number;
  /** 文字列の幅(pt) */
  width: (text: string) => number;
  /** 軸と直角の方向に使ってよい長さの上限(pt)。縦棒なら文字の領域の高さ、横棒なら文字の領域の幅 */
  maxExtent: number;
  /** 軸の向き: "x"=横の軸(縦棒・折れ線。文字は軸の下)、"y"=縦の軸(横棒。文字は軸の左) */
  axis: "x" | "y";
  /** Excelの指定(tickLblSkip)。null=自動 */
  explicitSkip: number | null;
  /** Excelの指定の角度(反時計回りの度)。null=自動 */
  explicitAngle: number | null;
}

export interface CategoryLabelPlan {
  mode: "horizontal" | "wrap" | "rotate";
  /** 回転の角度(反時計回りの度)。mode=rotate のとき */
  angle: number;
  /** 表示する項目の番号(小さい順) */
  shown: number[];
  /** 表示する項目ごとの行(折り返し・「…」で切ったあとの文字) */
  lines: Map<number, string[]>;
  /** 軸と直角の方向に必要な長さ(pt)。プロットエリアの余白に使う */
  extent: number;
  /** 文字の行の高さ(pt) */
  lineHeight: number;
}

const ELLIPSIS = "…";
/** 行頭に置かない文字(閉じかっこ・句読点・長音・小書きの仮名など) */
const NO_LINE_START = new Set(Array.from("、。，．,.)）]］}｝〕〉》」』】ー～・:：;；!！?？ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ%％"));
/** 行末に置かない文字(開きかっこ) */
const NO_LINE_END = new Set(Array.from("(（[［{｛〔〈《「『【"));
/** この文字の後ろで改行するのが自然(区切りの記号) */
const GOOD_BREAK_AFTER = new Set(Array.from(" 　・、，,/／)）」』】-－_"));
const isWordChar = (ch: string) => /[0-9A-Za-zÀ-ɏ.'’\-+#&%]/.test(ch);

/** 文字の種類(改行の位置の選び方に使う) */
function charKind(ch: string): "han" | "hira" | "kata" | "word" | "other" {
  if (/[\u4e00-\u9fff\u3400-\u4dbf々〆]/.test(ch)) return "han";
  if (/[\u3040-\u309f]/.test(ch)) return "hira";
  if (/[\u30a0-\u30ff\uff66-\uff9f]/.test(ch)) return "kata";
  if (isWordChar(ch)) return "word";
  return "other";
}

/** 1行分の改行の位置を選ぶ。gready=true なら、入るだけ詰める(位置の良し悪しは英数字の単語を切らない程度) */
function chooseBreak(chars: string[], start: number, endMax: number, target: number, widthTo: (i: number) => number, greedy: boolean): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = endMax; i > start; i--) {
    const prev = chars[i - 1];
    const next = chars[i];
    if (next !== undefined && (NO_LINE_START.has(next) || NO_LINE_END.has(prev))) continue;
    if (next !== undefined && isWordChar(prev) && isWordChar(next)) continue; // 英数字の単語の途中は避ける
    const w = widthTo(i);
    if (greedy) return i;
    if (w < target * 0.5) break; // 行が短くなりすぎる位置は選ばない
    // 区切りの記号の後ろ > 文字の種類(漢字・ひらがな・カタカナ・英数字)の変わり目 > その他。同じなら、行の長さがそろう位置
    const cls = GOOD_BREAK_AFTER.has(prev) ? 3 : next !== undefined && charKind(prev) !== charKind(next) ? 2 : 1;
    const score = cls * 1000 - Math.abs(w - target);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function wrapOnce(chars: string[], maxW: number, width: (t: string) => number, greedy: boolean): string[] {
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const widthTo = (i: number) => width(chars.slice(start, i).join(""));
    const rest = widthTo(chars.length);
    if (rest <= maxW) {
      lines.push(chars.slice(start).join(""));
      break;
    }
    let endMax = start;
    while (endMax < chars.length && widthTo(endMax + 1) <= maxW) endMax++;
    if (endMax === start) endMax = start + 1; // 1文字も入らない幅でも、1文字は置く
    // 残りを何行に分けるかの見込みから、1行の目安の長さを決める(最後の行だけが極端に短くならないように)
    const target = rest / Math.ceil(rest / maxW);
    let brk = chooseBreak(chars, start, endMax, target, widthTo, greedy);
    if (brk <= start) brk = endMax; // 単語が1行より長いときは、入るところで切る
    lines.push(chars.slice(start, brk).join("").replace(/[ 　]+$/, ""));
    start = brk;
    while (start < chars.length && (chars[start] === " " || chars[start] === "　")) start++;
  }
  return lines;
}

/**
 * 1つの項目名を、幅 maxW の行に折り返す。改行の位置は、区切りの記号(・、／ や空白など)の後ろ → 漢字・ひらがな・
 * カタカナ・英数字の変わり目 → その他 の順に選び、行の長さがそろうようにする。英数字の単語の途中・閉じかっこや
 * 句読点の前・開きかっこの後ろでは改行しない(単語が1行より長いときだけ途中で切る)。
 * maxLines 行に入らないときは、詰めて並べ直し、それでも入らなければ最後の行を「…」で切る(truncated=true)
 */
export function wrapLabel(text: string, maxW: number, width: (t: string) => number, maxLines: number): { lines: string[]; truncated: boolean } {
  const paras = text.split(/\r?\n/).map((p) => Array.from(p));
  let lines = paras.flatMap((p) => wrapOnce(p, maxW, width, false));
  if (lines.length > maxLines) lines = paras.flatMap((p) => wrapOnce(p, maxW, width, true));
  if (lines.length <= maxLines) return { lines: lines.length > 0 ? lines : [""], truncated: false };
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = truncateText(kept[maxLines - 1] + ELLIPSIS, maxW, width);
  return { lines: kept, truncated: true };
}

/** 幅 maxW に入るように、末尾を「…」にして切る(入るならそのまま) */
export function truncateText(text: string, maxW: number, width: (t: string) => number): string {
  if (width(text) <= maxW) return text;
  const chars = Array.from(text.endsWith(ELLIPSIS) ? text.slice(0, -1) : text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(chars.slice(0, mid).join("") + ELLIPSIS) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? chars.slice(0, lo).join("") + ELLIPSIS : ELLIPSIS;
}

/** 0, step, 2step… を表示し、末尾の項目は前の表示と重ならなければ足す(重なるなら、1つ前の代わりに末尾を出す) */
function pickShown(n: number, step: number, keepLast: boolean, fits: (a: number, b: number) => boolean): number[] {
  const shown: number[] = [];
  for (let i = 0; i < n; i += step) shown.push(i);
  if (keepLast && n > 1 && shown[shown.length - 1] !== n - 1) {
    const prev = shown[shown.length - 1];
    if (fits(prev, n - 1)) shown.push(n - 1);
    else if (shown.length > 1 && fits(shown[shown.length - 2], n - 1)) shown[shown.length - 1] = n - 1;
  }
  return shown;
}

export function planCategoryLabels(input: CategoryLabelInput): CategoryLabelPlan {
  const { labels, size, width, explicitSkip, explicitAngle } = input;
  const n = labels.length;
  const slot = Math.max(0.01, input.slotLen);
  const lineHeight = size * 1.2;
  const maxExtent = Math.max(size * 1.2, input.maxExtent);
  const empty: CategoryLabelPlan = { mode: "horizontal", angle: 0, shown: [], lines: new Map(), extent: 0, lineHeight };
  if (n === 0) return empty;

  // 同じ文字列の幅は1回だけ測る(項目名が数千あっても、測るのは種類の数だけ)
  const widths = labels.map((t) => width(t));
  const maxW = Math.max(0, ...widths);
  const gap = size * 0.6;

  // ---- 縦の軸(横棒グラフ)：文字は横書き。幅が足りなければ折り返し(項目の高さに入る行数まで)、それでも長ければ「…」 ----
  if (input.axis === "y") {
    const availW = maxExtent;
    const maxLinesBySlot = Math.max(1, Math.floor(slot / lineHeight));
    const maxLines = Math.min(3, maxLinesBySlot);
    const lines = new Map<number, string[]>();
    let usedW = 0;
    let maxLinesUsed = 1;
    const wrapped = labels.map((t, i) => (widths[i] <= availW ? { lines: [t], truncated: false } : wrapLabel(t, availW, width, maxLines)));
    wrapped.forEach((w) => {
      maxLinesUsed = Math.max(maxLinesUsed, w.lines.length);
      for (const ln of w.lines) usedW = Math.max(usedW, width(ln));
    });
    // 項目どうしの縦の間隔は、文字の行の高さより少し広く(文字の上下が詰まって見えないように)
    const need = maxLinesUsed * lineHeight + size * 0.2;
    const step = explicitSkip ?? Math.max(1, Math.ceil(need / slot));
    const shown = pickShown(n, step, explicitSkip === null, (a, b) => (b - a) * slot >= need);
    for (const i of shown) lines.set(i, wrapped[i].lines);
    return { mode: maxLinesUsed > 1 ? "wrap" : "horizontal", angle: 0, shown, lines, extent: Math.min(availW, usedW), lineHeight };
  }

  // ---- 横の軸(縦棒・折れ線など)：文字は軸の下 ----
  const horizontalPlan = (step: number, keepLast: boolean): CategoryLabelPlan => {
    const lines = new Map<number, string[]>();
    // 間引いたときは、1つの文字に使える幅も広がる(表示する項目どうしの間隔まで)。入らない名前は折り返し、それでも長ければ「…」
    const room = Math.max(size, slot * step - gap * 0.5);
    const maxLines = Math.max(1, Math.min(3, Math.floor((maxExtent - size * 0.4) / lineHeight)));
    const shown = pickShown(n, step, keepLast, (a, b) => (b - a) * slot >= (Math.min(widths[a], room) + Math.min(widths[b], room)) / 2 + gap);
    let maxLinesUsed = 1;
    for (const i of shown) {
      const ls = widths[i] <= room ? [labels[i]] : wrapLabel(labels[i], room, width, maxLines).lines;
      lines.set(i, ls);
      maxLinesUsed = Math.max(maxLinesUsed, ls.length);
    }
    return { mode: maxLinesUsed > 1 ? "wrap" : "horizontal", angle: 0, shown, lines, extent: maxLinesUsed * lineHeight + size * 0.4, lineHeight };
  };
  const rotatePlan = (angle: number, step: number, keepLast: boolean): CategoryLabelPlan => {
    const rad = (Math.abs(angle) * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    // 斜めの文字の、軸と直角の方向の長さ = 文字列の幅×sin + 文字の高さ×cos。上限を超える分は「…」で切る
    const maxLen = Math.max(size, (maxExtent - size * cos) / Math.max(0.2, sin));
    const lines = new Map<number, string[]>();
    let longest = 0;
    const footprint = size / Math.max(0.2, sin) + size * 0.5; // 軸方向に1つの文字が占める長さ(隣と少し空ける)
    const shown = pickShown(n, step, keepLast, (a, b) => (b - a) * slot >= footprint);
    for (const i of shown) {
      const t = widths[i] <= maxLen ? labels[i] : truncateText(labels[i], maxLen, width);
      lines.set(i, [t]);
      longest = Math.max(longest, Math.min(widths[i], maxLen));
    }
    return { mode: "rotate", angle, shown, lines, extent: longest * sin + size * cos + size * 0.3, lineHeight };
  };

  // Excelで角度が指定されている：その角度で描き、間隔は指定があればそれ、無ければ重ならない間隔
  if (explicitAngle !== null && Math.abs(explicitAngle) >= 1) {
    const rad = (Math.abs(explicitAngle) * Math.PI) / 180;
    const along = Math.min(maxW + size * 0.5, size / Math.max(0.2, Math.sin(rad)) + size * 0.5);
    const step = explicitSkip ?? Math.max(1, Math.ceil(along / slot));
    return rotatePlan(explicitAngle, step, explicitSkip === null);
  }
  const horizontalStep = (pad: number) => Math.max(1, Math.ceil((maxW + pad) / slot));

  // Excelで間隔だけが指定されている(角度は自動)：その間隔で、横書き→斜めの順に入る方を選ぶ
  if (explicitSkip !== null) {
    if (explicitAngle === 0 || maxW + gap <= slot * explicitSkip) return horizontalPlan(explicitSkip, false);
    return rotatePlan(45, explicitSkip, false);
  }

  // 1. 横書きのまま全部入る
  if (maxW + gap * 0.5 <= slot) return horizontalPlan(1, false);

  // 2. 折り返せば全部入る(1項目の幅に、3行まで)。英数字だけの短い名前(数値・日付など)は折り返さない
  const textual = labels.some((t) => /[^\x20-\x7e]/.test(t) || /\s/.test(t.trim()));
  const wrapW = slot - gap * 0.5;
  if (textual && wrapW >= size * 2.5) {
    const maxLines = Math.max(1, Math.min(3, Math.floor((maxExtent - size * 0.4) / lineHeight)));
    const wrapped = labels.map((t, i) => (widths[i] <= wrapW ? { lines: [t], truncated: false } : wrapLabel(t, wrapW, width, maxLines)));
    if (wrapped.every((w) => !w.truncated)) {
      const lines = new Map<number, string[]>();
      let maxLinesUsed = 1;
      wrapped.forEach((w, i) => {
        lines.set(i, w.lines);
        maxLinesUsed = Math.max(maxLinesUsed, w.lines.length);
      });
      return { mode: "wrap", angle: 0, shown: labels.map((_, i) => i), lines, extent: maxLinesUsed * lineHeight + size * 0.4, lineHeight };
    }
  }

  // 3. 斜め(45度)なら全部入る
  const footprint45 = size / Math.SQRT1_2 + size * 0.5;
  if (footprint45 <= slot) return rotatePlan(45, 1, false);

  // 4. 間引く：短い名前(数値・日付など)は横書きのまま、長い名前は斜めにして間引く
  if (maxW <= size * 6) {
    const step = horizontalStep(gap);
    return horizontalPlan(step, true);
  }
  return rotatePlan(45, Math.max(1, Math.ceil(footprint45 / slot)), true);
}
