import { formatTimeInput, parseTimeInput } from "./edit-settings";
import { dedupeFileNames, sanitizeFileName } from "@/lib/utils/format";

/**
 * 動画サムネイルの複数抽出（動画編集 工程4）：取り出す時刻の決め方・枚数の上限・ファイル名。
 *
 * 決め方は3つ：
 * - 指定した時刻：利用者が時刻を並べて入れる（改行・「,」「、」・空白で区切る）。同じ時刻は1回だけ。
 * - 一定の間隔：0秒から、指定した秒数ごと（動画の長さまで）。
 * - 均等に：指定した枚数を、動画の最初から最後まで等しい間隔で（最初と最後のコマを含む）。1枚なら真ん中。
 * どの方法でも、時刻は小さい順に並べ、0.05秒より近い時刻は同じものとして1回だけにする。
 */

/** 1回に取り出せる枚数の上限。理由：最大1920画素のPNGは1枚数MBになり、ZIPを作るときに一時的に約2〜3倍のメモリを使うため、スマホでも安全な枚数にする */
export const THUMBNAIL_MAX_COUNT = 30;
export const INTERVAL_CHOICES = [5, 10, 30, 60] as const;
export const EVEN_COUNT_CHOICES = [3, 5, 10, 20] as const;

export type ThumbnailMode = "single" | "times" | "interval" | "even";

export interface ThumbnailPlan {
  times: number[];
  /** 実行できない理由（無ければ null） */
  error: string | null;
  /** 補足（重複を省いた、など） */
  note: string | null;
}

const SAME_TIME_SEC = 0.05;

function uniqueSorted(times: number[]): { times: number[]; removed: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1] >= SAME_TIME_SEC) out.push(t);
  }
  return { times: out, removed: sorted.length - out.length };
}

function limitError(count: number): string | null {
  return count > THUMBNAIL_MAX_COUNT ? `一度に取り出せるのは${THUMBNAIL_MAX_COUNT}枚までです（今の設定では${count}枚）。間隔を広げるか、枚数を減らしてください。` : null;
}

/** 指定した時刻（文字）から、取り出す時刻を決める */
export function planFromTimes(text: string, durationSec: number): ThumbnailPlan {
  const tokens = text.normalize("NFKC").split(/[\s,、]+/).filter((s) => s !== "");
  if (tokens.length === 0) return { times: [], error: "取り出す時刻を入れてください（例: 0:05, 0:15, 1:00）。", note: null };
  const bad: string[] = [];
  const over: string[] = [];
  const times: number[] = [];
  for (const tok of tokens) {
    const t = parseTimeInput(tok);
    if (t === null || Number.isNaN(t)) bad.push(tok);
    else if (durationSec > 0 && t >= durationSec) over.push(tok);
    else times.push(t);
  }
  if (bad.length > 0) return { times: [], error: `時刻として読めないものがあります：${bad.slice(0, 5).join("、")}（例: 0:05 や 65.5 のように入れてください）`, note: null };
  if (over.length > 0) return { times: [], error: `動画の長さ（${formatTimeInput(durationSec)}）を超えている時刻があります：${over.slice(0, 5).join("、")}`, note: null };
  const u = uniqueSorted(times);
  return { times: u.times, error: limitError(u.times.length), note: u.removed > 0 ? `同じ時刻が${u.removed}件あったため、1回だけ取り出します。` : null };
}

/** 一定の間隔（秒）で取り出す時刻を決める（0秒から） */
export function planFromInterval(intervalSec: number, durationSec: number): ThumbnailPlan {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return { times: [], error: "間隔を選んでください。", note: null };
  if (durationSec <= 0) return { times: [], error: "動画の長さが分かりません。", note: null };
  const count = Math.floor((durationSec - 1e-6) / intervalSec) + 1;
  if (count > THUMBNAIL_MAX_COUNT) return { times: [], error: limitError(count), note: null };
  const times = Array.from({ length: count }, (_, i) => Math.round(i * intervalSec * 1000) / 1000);
  return { times, error: null, note: count === 1 ? "動画が間隔より短いため、最初の1枚だけになります。" : null };
}

/** 指定した枚数を、動画全体から均等に取り出す時刻を決める（最初と最後のコマを含む） */
export function planEven(count: number, durationSec: number, frameRate = 30): ThumbnailPlan {
  if (!Number.isInteger(count) || count < 1) return { times: [], error: "枚数を選んでください。", note: null };
  if (count > THUMBNAIL_MAX_COUNT) return { times: [], error: limitError(count), note: null };
  if (durationSec <= 0) return { times: [], error: "動画の長さが分かりません。", note: null };
  // 最後のコマの始まり（動画の終わりちょうどにはコマがないため、1コマぶん手前）
  const last = Math.max(0, durationSec - 1 / Math.max(1, frameRate));
  const raw = count === 1 ? [last / 2] : Array.from({ length: count }, (_, i) => (last * i) / (count - 1));
  const u = uniqueSorted(raw.map((t) => Math.round(t * 1000) / 1000));
  return { times: u.times, error: null, note: u.removed > 0 ? `動画が短いため、同じコマになる${u.removed}枚を省きました。` : null };
}

/** 時刻をファイル名に使う形にする（例: 5秒 → 0005、65.5秒 → 0105-5、1時間2分3秒 → 010203） */
export function timeForFileName(sec: number): string {
  const tenths = Math.round(sec * 10);
  const h = Math.floor(tenths / 36000);
  const m = Math.floor((tenths % 36000) / 600);
  const s = Math.floor((tenths % 600) / 10);
  const d = tenths % 10;
  const base = `${h > 0 ? String(h).padStart(2, "0") : ""}${String(m).padStart(2, "0")}${String(s).padStart(2, "0")}`;
  return d > 0 ? `${base}-${d}` : base;
}

/** 取り出す画像のファイル名（重ならないようにする） */
export function thumbnailFileNames(baseName: string, times: number[], ext: "png" | "jpg"): string[] {
  const base = sanitizeFileName(baseName) || "video";
  return dedupeFileNames(times.map((t) => `${base}-thumbnail-${timeForFileName(t)}.${ext}`));
}
