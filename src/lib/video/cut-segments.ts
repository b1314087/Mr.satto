import { MIN_CLIP_SEC } from "@/lib/processors/browser/video-cut-merge";

/** 動画カットで残す区間（秒） */
export interface CutSegment {
  id: number;
  start: number;
  end: number;
}

const round = (t: number) => Math.round(t * 1000) / 1000;

/**
 * 区間の並びから、ある範囲（秒）を取り除いた区間の並び（総合改修 30：タイムラインで選んだ不要な範囲を削除する）。
 * 区間の中に範囲がかかるときは、その区間を前後に分ける。短くなりすぎた区間は消す。順番は保つ。
 */
export function removeRangeFromSegments(segments: CutSegment[], range: { start: number; end: number }, nextId: () => number): CutSegment[] {
  const out: CutSegment[] = [];
  for (const s of segments) {
    if (range.end <= s.start || range.start >= s.end) {
      out.push(s);
      continue;
    }
    if (range.start - s.start >= MIN_CLIP_SEC) out.push({ id: s.id, start: s.start, end: round(range.start) });
    if (s.end - range.end >= MIN_CLIP_SEC) out.push({ id: out.some((o) => o.id === s.id) ? nextId() : s.id, start: round(range.end), end: s.end });
  }
  return out;
}


// ---------------------------------------------------------------------------
// つないだあとの時間（出力の時間）で扱うための計算（2026-11：動画編集ソフトのような1本のトラック）
// 区間は順番どおりに隙間なく並ぶ。区間を消す・短くすると、うしろの区間が自動で詰まる。
// ---------------------------------------------------------------------------

/** 各区間が、つないだあとの何秒から始まるか（最後に合計の長さを足した配列） */
export function sequenceStarts(segments: readonly { start: number; end: number }[]): number[] {
  const out = [0];
  for (const s of segments) out.push(round(out[out.length - 1] + Math.max(0, s.end - s.start)));
  return out;
}

/** つないだあとの時間 t が、どの区間の、元の動画の何秒にあたるか（区間が無ければ null） */
export function outputToSource(segments: readonly CutSegment[], t: number): { index: number; source: number } | null {
  if (segments.length === 0) return null;
  const starts = sequenceStarts(segments);
  const total = starts[starts.length - 1];
  const tt = Math.min(total, Math.max(0, t));
  let i = segments.findIndex((_, k) => tt < starts[k + 1]);
  if (i < 0) i = segments.length - 1;
  return { index: i, source: round(segments[i].start + (tt - starts[i])) };
}

/** つないだあとの時間 t で、その位置の区間を2つに分ける（どちらかが短すぎるときは、そのまま返す） */
export function splitAtOutputTime(segments: CutSegment[], t: number, nextId: () => number): CutSegment[] {
  const hit = outputToSource(segments, t);
  if (!hit) return segments;
  const s = segments[hit.index];
  if (hit.source - s.start < MIN_CLIP_SEC || s.end - hit.source < MIN_CLIP_SEC) return segments;
  const next = [...segments];
  next.splice(hit.index, 1, { ...s, end: hit.source }, { id: nextId(), start: hit.source, end: s.end });
  return next;
}

/** つないだあとの時間で選んだ範囲を取り除く（範囲にかかる区間は前後に分ける。うしろの区間は詰まる） */
export function removeOutputRange(segments: CutSegment[], range: { start: number; end: number }, nextId: () => number): CutSegment[] {
  const starts = sequenceStarts(segments);
  const out: CutSegment[] = [];
  segments.forEach((s, i) => {
    const a = starts[i];
    const b = starts[i + 1];
    if (range.end <= a || range.start >= b) {
      out.push(s);
      return;
    }
    const cutFrom = round(s.start + Math.max(0, range.start - a));
    const cutTo = round(s.start + Math.min(b - a, range.end - a));
    let used = false;
    if (cutFrom - s.start >= MIN_CLIP_SEC) {
      out.push({ id: s.id, start: s.start, end: cutFrom });
      used = true;
    }
    if (s.end - cutTo >= MIN_CLIP_SEC) out.push({ id: used ? nextId() : s.id, start: cutTo, end: s.end });
  });
  return out;
}

/**
 * 磁石（スナップ）：t が候補のどれかに近ければ（threshold 秒以内）、いちばん近い候補に吸い付ける。
 * 吸い付いたときは、その候補も返す（画面に目印の線を出すため）。
 */
export function snapTime(t: number, candidates: readonly number[], threshold: number): { t: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best === null ? { t, snappedTo: null } : { t: best, snappedTo: best };
}
