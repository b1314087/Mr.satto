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

