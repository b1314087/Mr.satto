/**
 * 読み上げツール（ブラウザの声）の、文章の下ごしらえ（2026-11-18）。画面の部品とは分けて、テストしやすくしている。
 *
 * - splitForSpeech：文章を、読み上げる単位（文）に分ける。ブラウザの読み上げは、長い文章を一度に渡すと
 *   途中で止まることがあるため、文ごとに区切って順番に読む。長すぎる文は「、」などでさらに分ける。
 * - applyReadings：読みの登録（例：「明日」→「あした」）を、読み上げる文に当てはめる。画面に出す文は変えない。
 * - sortVoices：声の一覧を、日本語・端末の中だけで動く声（ネットを使わない声）を先に並べる。
 */

export interface SpeechChunk {
  /** 画面に出す文（元の文章のまま） */
  text: string;
  /** 元の文章の中の位置（何文字目から何文字目か） */
  start: number;
  end: number;
}

/** 1回に読ませる長さの上限（これより長い文は、「、」などで分ける） */
export const MAX_CHUNK_LENGTH = 120;

const SENTENCE_END = /[。．！？!?]/;
const SOFT_BREAK = /[、，,；;：:　 ]/;

/** 文章を、読み上げる単位に分ける（空白だけの部分は除く） */
export function splitForSpeech(source: string, maxLength = MAX_CHUNK_LENGTH): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let start = 0;
  const push = (from: number, to: number) => {
    // 前後の空白・改行は、文に含めない
    while (from < to && /\s/.test(source[from])) from++;
    while (to > from && /\s/.test(source[to - 1])) to--;
    if (to <= from) return;
    if (to - from <= maxLength) {
      chunks.push({ text: source.slice(from, to), start: from, end: to });
      return;
    }
    // 長すぎる文：上限より手前の、いちばん後ろの「、」などで分ける（なければ上限の位置で分ける）
    let cut = -1;
    for (let i = from + maxLength; i > from + maxLength / 3; i--) {
      if (SOFT_BREAK.test(source[i - 1])) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = from + maxLength;
    push(from, cut);
    push(cut, to);
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\n") {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (SENTENCE_END.test(ch)) {
      // 「。」のあとに続く閉じかっこ・同じ記号は、同じ文に含める（例：「はい。」→「はい。」」）
      let j = i + 1;
      while (j < source.length && /[」』）)】〕”’"'！？!?。]/.test(source[j])) j++;
      push(start, j);
      start = j;
      i = j - 1;
    }
  }
  push(start, source.length);
  return chunks;
}

export interface ReadingEntry {
  /** 書かれている言葉（例：明日） */
  word: string;
  /** 読ませたい読み（例：あした） */
  reading: string;
}

/** 読みの登録を当てはめる（長い言葉から先に置き換えるので、「明日香」と「明日」を両方登録しても正しく読む） */
export function applyReadings(text: string, entries: ReadingEntry[]): string {
  const valid = entries.filter((e) => e.word.trim() !== "" && e.reading.trim() !== "").sort((a, b) => b.word.length - a.word.length);
  if (valid.length === 0) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const hit = valid.find((e) => text.startsWith(e.word, i));
    if (hit) {
      out += hit.reading;
      i += hit.word.length;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/** 声の一覧を並べ替える：日本語 → 端末の中だけで動く声 → 名前の順 */
export function sortVoices<T extends VoiceLike>(voices: T[]): T[] {
  const isJa = (v: VoiceLike) => v.lang.toLowerCase().replace("_", "-").startsWith("ja");
  return [...voices].sort((a, b) => {
    if (isJa(a) !== isJa(b)) return isJa(a) ? -1 : 1;
    if (a.localService !== b.localService) return a.localService ? -1 : 1;
    return a.name.localeCompare(b.name, "ja");
  });
}

/** 最初に選んでおく声：日本語で端末の中だけで動く声 → 日本語の声 → 端末の中だけで動く声 → 先頭 */
export function pickDefaultVoice<T extends VoiceLike>(voices: T[]): T | null {
  const sorted = sortVoices(voices);
  const isJa = (v: VoiceLike) => v.lang.toLowerCase().replace("_", "-").startsWith("ja");
  return sorted.find((v) => isJa(v) && v.localService) ?? sorted.find(isJa) ?? sorted.find((v) => v.localService) ?? sorted[0] ?? null;
}
