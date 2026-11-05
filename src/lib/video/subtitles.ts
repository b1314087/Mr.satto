/**
 * 動画字幕追加：字幕（キュー）の入力・確認・書き出し用の文字（WebVTT・SRT）を作る。
 * 画面・処理の両方から使う、ライブラリに依存しない計算だけを置く（mediabunny を読み込まない）。
 *
 * 字幕は動画に焼き付けず、WebVTT 形式の字幕トラックとして動画（MKV・WebM）に入れる。
 * 表示設定（文字サイズ・文字色・背景色・背景の透明度・表示位置）は、WebVTT の STYLE ブロック（::cue）と
 * キューの設定（line）で表す。VLC で、これらが実際に反映されることを確認している。
 */

/** 1つの字幕 */
export interface SubtitleCue {
  /** 画面上で並べ替え・削除するための番号（書き出しには使わない） */
  id: string;
  /** 開始時間の入力（HH:MM:SS.mmm） */
  start: string;
  /** 終了時間の入力（HH:MM:SS.mmm） */
  end: string;
  text: string;
}

export type SubtitlePosition = "top" | "middle" | "bottom";
export type SubtitleFontSize = "small" | "medium" | "large" | "xlarge";

export interface SubtitleStyle {
  fontSize: SubtitleFontSize;
  /** 文字色（#rrggbb） */
  color: string;
  /** 背景色（#rrggbb） */
  backgroundColor: string;
  /** 背景の不透明度（0〜100。0で背景なし） */
  backgroundOpacity: number;
  position: SubtitlePosition;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: "medium",
  color: "#ffffff",
  backgroundColor: "#000000",
  backgroundOpacity: 60,
  position: "bottom",
};

export const SUBTITLE_FONT_SIZE_OPTIONS: { value: SubtitleFontSize; label: string; percent: number }[] = [
  { value: "small", label: "小", percent: 80 },
  { value: "medium", label: "中", percent: 100 },
  { value: "large", label: "大", percent: 130 },
  { value: "xlarge", label: "特大", percent: 160 },
];

export const SUBTITLE_POSITION_OPTIONS: { value: SubtitlePosition; label: string }[] = [
  { value: "top", label: "上" },
  { value: "middle", label: "中央" },
  { value: "bottom", label: "下" },
];

/** 字幕トラックの言語 */
export type SubtitleLanguage = "jpn" | "eng" | "und";
export const SUBTITLE_LANGUAGE_OPTIONS: { value: SubtitleLanguage; label: string; trackName: string }[] = [
  { value: "jpn", label: "日本語", trackName: "日本語" },
  { value: "eng", label: "英語", trackName: "English" },
  { value: "und", label: "指定しない", trackName: "字幕" },
];

/** 1つの字幕の文字数の上限（長すぎる入力で画面・ファイルが重くならないように） */
export const SUBTITLE_TEXT_MAX = 500;
/** 字幕の件数の上限 */
export const SUBTITLE_CUES_MAX = 2000;

const MAX_SECONDS = 99 * 3600 + 59 * 60 + 59.999;

/**
 * 時間の入力を秒にする。HH:MM:SS.mmm を基本とし、H:MM:SS・MM:SS.mmm・秒だけ（例：12.5）も受け付ける。
 * 全角の数字・記号も受け付ける。読めないときは null。
 */
export function parseSubtitleTime(text: string): number | null {
  const t = text.normalize("NFKC").trim();
  if (t === "") return null;
  // 時・分・秒（秒だけ小数（ミリ秒）を付けられる）。区切りはコロン、小数点は「.」か「,」
  const m = /^(?:(\d{1,2}):)??(?:(\d{1,2}):)?(\d+)(?:[.,](\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const h = m[1] !== undefined ? Number(m[1]) : 0;
  const min = m[2] !== undefined ? Number(m[2]) : 0;
  const sec = Number(m[3]);
  const hasColon = m[2] !== undefined;
  if (hasColon && (sec >= 60 || m[3].length > 2)) return null;
  if (min >= 60) return null;
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  const total = h * 3600 + min * 60 + sec + ms / 1000;
  if (!Number.isFinite(total) || total > MAX_SECONDS) return null;
  return Math.round(total * 1000) / 1000;
}

/** 秒を HH:MM:SS.mmm にする（WebVTT と同じ書き方。区切りを "," にすると SRT の書き方） */
export function formatSubtitleTime(sec: number, separator: "." | "," = "."): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

/** 書き出しに使う、確認済みの字幕 */
export interface ResolvedCue {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface CueProblem {
  id: string;
  /** 一覧で何番目か（1から） */
  index: number;
  field: "start" | "end" | "text";
  message: string;
}

export interface CueCheckResult {
  /** 書き出せない問題（直すまで書き出せない） */
  errors: CueProblem[];
  /** 重なっている字幕の組（警告だけ。意図的な重なりは禁止しない） */
  overlaps: { a: number; b: number }[];
  /** 時間順に並んでいないか（書き出し時は時間順に並べ替える） */
  outOfOrder: boolean;
  /** 問題がないときの、時間順に並べた字幕 */
  resolved: ResolvedCue[];
}

/** 字幕の文字の前後の空白を取り、空の行をまとめる（WebVTT では空の行がキューの区切りになるため） */
export function normalizeCueText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * 字幕の一覧を確かめる。durationSec（動画の長さ）が分かっていれば、それを超える字幕も問題にする。
 */
export function checkCues(cues: SubtitleCue[], durationSec: number | null): CueCheckResult {
  const errors: CueProblem[] = [];
  const parsed: (ResolvedCue | null)[] = cues.map((cue, i) => {
    const index = i + 1;
    const startSec = parseSubtitleTime(cue.start);
    const endSec = parseSubtitleTime(cue.end);
    const text = normalizeCueText(cue.text);
    let ok = true;
    if (startSec === null) {
      errors.push({ id: cue.id, index, field: "start", message: `${index}番目の開始時間を「00:00:01.000」の形で入力してください。` });
      ok = false;
    }
    if (endSec === null) {
      errors.push({ id: cue.id, index, field: "end", message: `${index}番目の終了時間を「00:00:03.000」の形で入力してください。` });
      ok = false;
    }
    if (startSec !== null && endSec !== null && endSec <= startSec) {
      errors.push({ id: cue.id, index, field: "end", message: `${index}番目の終了時間は、開始時間より後にしてください。` });
      ok = false;
    }
    if (durationSec !== null && durationSec > 0 && startSec !== null && startSec >= durationSec) {
      errors.push({
        id: cue.id,
        index,
        field: "start",
        message: `${index}番目の開始時間が、動画の長さ（${formatSubtitleTime(durationSec)}）を超えています。`,
      });
      ok = false;
    } else if (durationSec !== null && durationSec > 0 && endSec !== null && endSec > durationSec + 0.0005) {
      errors.push({
        id: cue.id,
        index,
        field: "end",
        message: `${index}番目の終了時間が、動画の長さ（${formatSubtitleTime(durationSec)}）を超えています。`,
      });
      ok = false;
    }
    if (text === "") {
      errors.push({ id: cue.id, index, field: "text", message: `${index}番目の字幕の文字を入力してください。` });
      ok = false;
    } else if (text.length > SUBTITLE_TEXT_MAX) {
      errors.push({ id: cue.id, index, field: "text", message: `${index}番目の字幕は、${SUBTITLE_TEXT_MAX}文字以内にしてください。` });
      ok = false;
    }
    return ok && startSec !== null && endSec !== null ? { id: cue.id, startSec, endSec, text } : null;
  });

  const overlaps: { a: number; b: number }[] = [];
  let outOfOrder = false;
  for (let i = 0; i < parsed.length; i++) {
    const a = parsed[i];
    if (!a) continue;
    for (let j = i + 1; j < parsed.length; j++) {
      const b = parsed[j];
      if (!b) continue;
      if (a.startSec < b.endSec && b.startSec < a.endSec) overlaps.push({ a: i + 1, b: j + 1 });
      if (b.startSec < a.startSec) outOfOrder = true;
    }
  }

  const resolved = errors.length === 0 ? sortResolved(parsed.filter((c): c is ResolvedCue => c !== null)) : [];
  return { errors, overlaps, outOfOrder, resolved };
}

function sortResolved(cues: ResolvedCue[]): ResolvedCue[] {
  // 開始時間の順（同じなら終了時間の順。それも同じなら一覧の順のまま）
  return cues
    .map((c, i) => ({ c, i }))
    .sort((x, y) => x.c.startSec - y.c.startSec || x.c.endSec - y.c.endSec || x.i - y.i)
    .map((x) => x.c);
}

/** 一覧を時間順に並べ替える（読めない時間の字幕は、後ろにそのままの順で残す） */
export function sortCuesByTime(cues: SubtitleCue[]): SubtitleCue[] {
  const withTime = cues.map((c, i) => ({ c, i, s: parseSubtitleTime(c.start), e: parseSubtitleTime(c.end) }));
  return withTime
    .sort((x, y) => {
      if (x.s === null && y.s === null) return x.i - y.i;
      if (x.s === null) return 1;
      if (y.s === null) return -1;
      return x.s - y.s || (x.e ?? 0) - (y.e ?? 0) || x.i - y.i;
    })
    .map((x) => x.c);
}

/** ある時間に表示される字幕（プレビュー用。開始を含み、終了を含まない） */
export function activeCuesAt(cues: ResolvedCue[], timeSec: number): ResolvedCue[] {
  return cues.filter((c) => timeSec >= c.startSec && timeSec < c.endSec);
}

/** プレビュー用：入力の途中でも、読める字幕だけを返す（時間順） */
export function previewCues(cues: SubtitleCue[]): ResolvedCue[] {
  const out: ResolvedCue[] = [];
  for (const cue of cues) {
    const s = parseSubtitleTime(cue.start);
    const e = parseSubtitleTime(cue.end);
    const text = normalizeCueText(cue.text);
    if (s === null || e === null || e <= s || text === "") continue;
    out.push({ id: cue.id, startSec: s, endSec: e, text });
  }
  return sortResolved(out);
}

/** #rrggbb と不透明度（0〜100）を rgba(...) にする */
export function hexToRgba(hex: string, opacityPercent: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
  const a = Math.min(100, Math.max(0, Math.round(opacityPercent))) / 100;
  return `rgba(${r},${g},${b},${a})`;
}

export function fontSizePercent(size: SubtitleFontSize): number {
  return SUBTITLE_FONT_SIZE_OPTIONS.find((o) => o.value === size)?.percent ?? 100;
}

/** 表示位置を、WebVTT のキューの設定（line）にする。下は既定の位置（設定なし） */
export function cueSettingsFor(position: SubtitlePosition): string {
  if (position === "top") return "line:5% align:center";
  if (position === "middle") return "line:50% align:center";
  return "align:center";
}

/** 字幕の文字を、WebVTT の中で安全に書ける形にする（& < > は記号に置き換える） */
function escapeVttText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 色の入力を #rrggbb に限る（ファイルに任意の文字を書かないため） */
function safeHex(hex: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex.trim()) ? hex.trim().toLowerCase() : fallback;
}

/** 字幕トラック・字幕ファイル（.vtt）用の WebVTT を作る */
export function buildWebVtt(cues: ResolvedCue[], style: SubtitleStyle): string {
  const color = safeHex(style.color, DEFAULT_SUBTITLE_STYLE.color);
  const bg = hexToRgba(safeHex(style.backgroundColor, DEFAULT_SUBTITLE_STYLE.backgroundColor), style.backgroundOpacity);
  const lines = [
    "WEBVTT",
    "",
    "STYLE",
    `::cue { color: ${color}; background-color: ${bg}; font-size: ${fontSizePercent(style.fontSize)}%; }`,
    "",
  ];
  const settings = cueSettingsFor(style.position);
  cues.forEach((cue, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatSubtitleTime(cue.startSec)} --> ${formatSubtitleTime(cue.endSec)} ${settings}`);
    lines.push(escapeVttText(cue.text));
    lines.push("");
  });
  return lines.join("\n");
}

/** 字幕ファイル（.srt）を作る。SRT には表示設定の書き方がないため、時間と文字だけ */
export function buildSrt(cues: ResolvedCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${formatSubtitleTime(cue.startSec, ",")} --> ${formatSubtitleTime(cue.endSec, ",")}\n${cue.text}\n`)
    .join("\n");
}

let cueSeq = 0;
/** 新しい字幕の番号 */
export function newCueId(): string {
  cueSeq += 1;
  return `cue-${Date.now().toString(36)}-${cueSeq}`;
}
