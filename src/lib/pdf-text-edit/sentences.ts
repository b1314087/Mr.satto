import type { TextRun } from "./text-runs";

/**
 * ページの文字を、文（「。」などで区切ったひとまとまり）に分ける（2026-11-18 文字を消す機能）。
 *
 * - 「。」「．」「！」「？」「!」「?」と、うしろが空白・行末の「.」で文を区切る（閉じかっこ「」』）」は前の文に含める）。
 * - 行をまたぐ文は、1つの文としてまとめる。ただし、段落が変わる（行の間が大きく空く・前の行が途中で終わる・文字の大きさが変わる）ところや、
 *   同じ行の中で大きく離れた文字（表の別のマスなど）は、別の文にする。
 * - 文字は、PDFに描かれた順に並べる（ふつうは読む順と同じ）。
 */

export interface GlyphRef {
  opIndex: number;
  glyphIndex: number;
}

export interface SentenceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Sentence {
  id: number;
  text: string;
  refs: GlyphRef[];
  /** 行ごとの範囲（画面のページの座標。左下が原点・上が正） */
  boxes: SentenceBox[];
  /** すべての文字が消せるか */
  erasable: boolean;
  /** 文の最後に空白があったか（「1.5」のような数字の途中の「.」と、文の終わりの「.」を見分ける） */
  endsWithSpace?: boolean;
}

const END_CHARS = new Set(["。", "．", "！", "？", "!", "?", "｡"]);
const CLOSERS = new Set(["」", "』", "）", ")", "】", "〕", "”", "’", '"', "'", "〉", "》"]);

interface Flat {
  ref: GlyphRef;
  unicode: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  baseX: number;
  baseY: number;
  size: number;
  erasable: boolean;
}

interface Line {
  items: Flat[];
  size: number;
  baseY: number;
  x0: number;
  x1: number;
  /** 前の行と同じ行の中で、大きく離れて始まった（表の別のマスなど） */
  detached: boolean;
}

const isSpace = (s: string) => s.trim() === "";

export function splitSentences(runs: TextRun[]): Sentence[] {
  const flat: Flat[] = [];
  for (const run of runs) {
    run.glyphs.forEach((g, glyphIndex) => {
      flat.push({
        ref: { opIndex: run.opIndex, glyphIndex },
        unicode: g.unicode,
        x0: g.x0,
        y0: g.y0,
        x1: g.x1,
        y1: g.y1,
        baseX: g.baseX,
        baseY: g.baseY,
        size: Math.max(1, run.displayFontSize),
        erasable: run.erasable,
      });
    });
  }
  if (flat.length === 0) return [];

  // 1. 行に分ける（基準線の高さが変わる・左へ戻る・大きく右へ離れると、別の行にする）
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const f of flat) {
    if (cur) {
      const last: Flat = cur.items[cur.items.length - 1];
      const sameBaseline: boolean = Math.abs(f.baseY - cur.baseY) <= Math.max(cur.size, f.size) * 0.5;
      const backwards: boolean = f.x0 < last.x0 - Math.max(cur.size, f.size) * 0.5;
      const farGap: boolean = f.x0 - last.x1 > Math.max(cur.size, f.size) * 2.5;
      if (sameBaseline && !backwards && !farGap) {
        cur.items.push(f);
        cur.x1 = Math.max(cur.x1, f.x1);
        continue;
      }
      lines.push(cur);
      cur = { items: [f], size: f.size, baseY: f.baseY, x0: f.x0, x1: f.x1, detached: sameBaseline && farGap };
      continue;
    }
    cur = { items: [f], size: f.size, baseY: f.baseY, x0: f.x0, x1: f.x1, detached: false };
  }
  if (cur) lines.push(cur);

  // 行の右端の目安：続いている行（間が大きく空かず、文字の大きさが同じくらい）のまとまりの中で、いちばん右
  const blockOf: number[] = [];
  lines.forEach((line, li) => {
    const prev = lines[li - 1];
    const joined =
      prev &&
      !line.detached &&
      Math.abs(prev.size - line.size) <= Math.max(prev.size, line.size) * 0.2 &&
      Math.abs(prev.baseY - line.baseY) <= Math.max(prev.size, line.size) * 1.8;
    blockOf.push(joined ? blockOf[li - 1] : li);
  });
  const blockRight = new Map<number, number>();
  lines.forEach((line, li) => blockRight.set(blockOf[li], Math.max(blockRight.get(blockOf[li]) ?? Number.NEGATIVE_INFINITY, trimmedRight(line))));

  // 2. 文に分ける
  const sentences: Sentence[] = [];
  let curRefs: Flat[] = [];
  let curText = "";
  let pendingBreak = false;
  const finish = () => {
    const visible = curRefs.filter((f) => !isSpace(f.unicode));
    if (visible.length > 0) {
      sentences.push({
        id: sentences.length,
        text: curText.trim(),
        refs: curRefs.map((f) => f.ref),
        boxes: boxesOf(visible),
        erasable: curRefs.every((f) => f.erasable),
        endsWithSpace: isSpace(curRefs[curRefs.length - 1].unicode),
      });
    }
    curRefs = [];
    curText = "";
    pendingBreak = false;
  };

  lines.forEach((line, li) => {
    if (li > 0) {
      const prev = lines[li - 1];
      const gap = Math.abs(prev.baseY - line.baseY);
      const sizeChanged = Math.abs(prev.size - line.size) > Math.max(prev.size, line.size) * 0.2;
      const bigGap = gap > Math.max(prev.size, line.size) * 1.8;
      const prevShort = blockOf[li] === blockOf[li - 1] && trimmedRight(prev) < (blockRight.get(blockOf[li]) ?? 0) - prev.size * 3;
      if (line.detached || sizeChanged || bigGap || prevShort) finish();
    }
    line.items.forEach((f, fi) => {
      if (pendingBreak && !isSpace(f.unicode) && !CLOSERS.has(f.unicode)) finish();
      // 行をまたいでつなぐとき、欧文どうしなら、表示用の文に空白をはさむ
      if (fi === 0 && curText && /[A-Za-z0-9,;:]$/.test(curText) && /^[A-Za-z0-9]/.test(f.unicode)) curText += " ";
      curRefs.push(f);
      curText += f.unicode;
      if (END_CHARS.has(f.unicode)) pendingBreak = true;
      else if (f.unicode === "." ) pendingBreak = true;
      else if (pendingBreak && !isSpace(f.unicode) && !CLOSERS.has(f.unicode)) pendingBreak = false;
    });
    // 「.」は、うしろに空白か行末が来たときだけ区切る（1.5 のような数字の途中では区切らない）
  });
  finish();
  return mergeDecimalSplits(sentences);
}

/** 「1.5」「ver.2」のように、「.」のすぐうしろに数字が続いて区切られた文は、つなぎ直す */
function mergeDecimalSplits(list: Sentence[]): Sentence[] {
  const out: Sentence[] = [];
  for (const s of list) {
    const prev = out[out.length - 1];
    if (prev && prev.text.endsWith(".") && !prev.endsWithSpace && /^[0-9]/.test(s.text) && /[0-9A-Za-z]\.$/.test(prev.text) && sameLineContinuation(prev, s)) {
      out[out.length - 1] = {
        id: prev.id,
        text: prev.text + s.text,
        refs: [...prev.refs, ...s.refs],
        boxes: mergeBoxes([...prev.boxes, ...s.boxes]),
        erasable: prev.erasable && s.erasable,
        endsWithSpace: s.endsWithSpace,
      };
      continue;
    }
    out.push(s);
  }
  return out.map((s, i) => ({ ...s, id: i }));
}

function sameLineContinuation(a: Sentence, b: Sentence): boolean {
  const la = a.boxes[a.boxes.length - 1];
  const fb = b.boxes[0];
  if (!la || !fb) return false;
  const h = Math.max(la.y1 - la.y0, fb.y1 - fb.y0);
  return Math.abs(la.y0 - fb.y0) < h * 0.5 && fb.x0 - la.x1 < h * 0.3;
}

function trimmedRight(l: Line): number {
  let r = l.x0;
  for (const f of l.items) if (!isSpace(f.unicode)) r = Math.max(r, f.x1);
  return r;
}

/** 文字の範囲を、行ごとの四角にまとめる */
function boxesOf(items: Flat[]): SentenceBox[] {
  const boxes: SentenceBox[] = [];
  let cur: SentenceBox | null = null;
  let curBase = 0;
  let curSize = 0;
  for (const f of items) {
    if (cur && Math.abs(f.baseY - curBase) <= Math.max(curSize, f.size) * 0.5 && f.x0 >= cur.x0 - f.size) {
      cur.x0 = Math.min(cur.x0, f.x0);
      cur.x1 = Math.max(cur.x1, f.x1);
      cur.y0 = Math.min(cur.y0, f.y0);
      cur.y1 = Math.max(cur.y1, f.y1);
      continue;
    }
    if (cur) boxes.push(cur);
    cur = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 };
    curBase = f.baseY;
    curSize = f.size;
  }
  if (cur) boxes.push(cur);
  return boxes;
}

function mergeBoxes(boxes: SentenceBox[]): SentenceBox[] {
  const out: SentenceBox[] = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    const h = Math.max(b.y1 - b.y0, last ? last.y1 - last.y0 : 0);
    if (last && Math.abs(last.y0 - b.y0) < h * 0.5) {
      last.x0 = Math.min(last.x0, b.x0);
      last.x1 = Math.max(last.x1, b.x1);
      last.y0 = Math.min(last.y0, b.y0);
      last.y1 = Math.max(last.y1, b.y1);
    } else out.push({ ...b });
  }
  return out;
}

/** 点（画面のページの座標）が入っている文を探す（少しはみ出していても選べるよう、余白をとる） */
export function sentenceAt(sentences: Sentence[], x: number, y: number, pad = 1.5): Sentence | null {
  for (const s of sentences) {
    for (const b of s.boxes) {
      if (x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) return s;
    }
  }
  return null;
}
