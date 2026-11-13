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

// ---------------------------------------------------------------------------
// 自由に置けるクリップ（2026-11：クリップをドラッグして好きな位置に置き、間に空白を作れる）
// at は、つないだあとのタイムライン上の開始位置（秒）。クリップどうしは重ならない（重なったら、うしろを右へ押し出す）。
// 空白は、書き出すと黒い画面・無音になる。
// ---------------------------------------------------------------------------

export interface TimelineClip extends CutSegment {
  at: number;
}

const clipLen = (c: { start: number; end: number }) => Math.max(0, c.end - c.start);

/** タイムラインの終わり（いちばんうしろのクリップの終わり） */
export function timelineEnd(clips: readonly TimelineClip[]): number {
  return clips.reduce((m, c) => Math.max(m, c.at + clipLen(c)), 0);
}

/** 置いた位置の順に並べ、重なっているクリップは、前のクリップの終わりまで右へ押し出す */
export function resolveOverlaps(clips: readonly TimelineClip[]): TimelineClip[] {
  const sorted = [...clips].map((c) => ({ ...c, at: Math.max(0, c.at) })).sort((a, b) => a.at - b.at);
  let prevEnd = 0;
  return sorted.map((c) => {
    const at = round(Math.max(c.at, prevEnd));
    prevEnd = at + clipLen(c);
    return { ...c, at };
  });
}

/** 時間 t にあるクリップ（無ければ、t のあとにある最初のクリップを next に入れる） */
export function clipAtTime(clips: readonly TimelineClip[], t: number): { index: number; source: number } | { index: -1; next: number } {
  const i = clips.findIndex((c) => t >= c.at && t < c.at + clipLen(c));
  if (i >= 0) return { index: i, source: round(clips[i].start + (t - clips[i].at)) };
  return { index: -1, next: clips.findIndex((c) => c.at > t) };
}

/** 時間 t（再生ヘッド）でクリップを2つに分ける（クリップの外・短すぎる位置では、そのまま返す） */
export function splitClipAt(clips: TimelineClip[], t: number, nextId: () => number): TimelineClip[] {
  const hit = clipAtTime(clips, t);
  if (!("source" in hit)) return clips;
  const c = clips[hit.index];
  const src = hit.source;
  if (src - c.start < MIN_CLIP_SEC || c.end - src < MIN_CLIP_SEC) return clips;
  const next = [...clips];
  next.splice(hit.index, 1, { ...c, end: src }, { id: nextId(), start: src, end: c.end, at: round(c.at + (src - c.start)) });
  return next;
}

/** クリップを消す。ripple のときは、うしろのクリップをその長さだけ前へ詰める */
export function deleteClip(clips: TimelineClip[], id: number, ripple: boolean): TimelineClip[] {
  const target = clips.find((c) => c.id === id);
  if (!target) return clips;
  const len = clipLen(target);
  return clips.filter((c) => c.id !== id).map((c) => (ripple && c.at >= target.at ? { ...c, at: round(Math.max(0, c.at - len)) } : c));
}

/** 一覧で順番を入れ替える：空白の並びはそのままに、クリップの順番だけを入れ替える */
export function moveClipOrder(clips: TimelineClip[], from: number, to: number): TimelineClip[] {
  const sorted = resolveOverlaps(clips);
  if (from === to || from < 0 || to < 0 || from >= sorted.length || to >= sorted.length) return sorted;
  const gaps: number[] = [];
  let prevEnd = 0;
  for (const c of sorted) {
    gaps.push(c.at - prevEnd);
    prevEnd = c.at + clipLen(c);
  }
  const order = [...sorted];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  let pos = 0;
  return order.map((c, k) => {
    pos += gaps[k];
    const at = round(pos);
    pos += clipLen(c);
    return { ...c, at };
  });
}

/** 書き出し用：置いた順の区間と、それぞれの前の空白（秒） */
export function clipsForExport(clips: readonly TimelineClip[]): { start: number; end: number; gapBefore: number }[] {
  let prevEnd = 0;
  return resolveOverlaps(clips).map((c) => {
    const gapBefore = round(Math.max(0, c.at - prevEnd));
    prevEnd = c.at + clipLen(c);
    return { start: c.start, end: c.end, gapBefore };
  });
}
