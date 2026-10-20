/**
 * 連番・項目一括生成（Mr.Satto 生成ツール）の計算ロジック。
 *
 * すべてブラウザ内の純関数で、外部通信・保存は行わない。画面（sequence-generator-tool.tsx）とテストの両方が、
 * ここだけを使う（番号の付け方を画面ごとに別々に実装しない）。
 *
 * ■ 出力の形式
 *   1行に1項目。「番号の表示」と「項目名」の間は全角スペース1つ。
 *     第１回　英語 / 第1回　英語 / １回目　英語 / 1　英語
 *   Excelなどへそのまま貼り付けると、1行が1セルに入る。
 *
 * ■ 単一項目（generateSingle）
 *   開始番号〜終了番号を1つずつ増やして並べる。開始番号が終了番号より大きいときは、
 *   勝手に逆順にせず、エラーとして直し方を案内する。
 *
 * ■ 複数項目（generateMultiple）
 *   入力の行の順に、項目ごとに独立して番号を増やす（初回は1）。離れた行に同じ項目があっても継続する。
 *   空行（空白だけの行を含む）は出力せず、番号も進めない。項目の同一判定は「前後の空白（全角空白も）を除いた文字の完全一致」。
 */

export type SequenceStyle = "dai-kai" | "kai-me" | "plain";
export type SequenceWidth = "full" | "half";

export const SEQUENCE_STYLES: { value: SequenceStyle; label: string }[] = [
  { value: "dai-kai", label: "第○回" },
  { value: "kai-me", label: "○回目" },
  { value: "plain", label: "○" },
];

export const SEQUENCE_WIDTHS: { value: SequenceWidth; label: string }[] = [
  { value: "full", label: "全角（１２３）" },
  { value: "half", label: "半角（123）" },
];

export function isSequenceStyle(v: unknown): v is SequenceStyle {
  return v === "dai-kai" || v === "kai-me" || v === "plain";
}
export function isSequenceWidth(v: unknown): v is SequenceWidth {
  return v === "full" || v === "half";
}

/** 番号の表示と項目名の区切り（全角スペース） */
export const SEQUENCE_SEPARATOR = "　";

/** 番号に使える範囲と、1回に作れる行数の上限（画面が固まらないための安全のための制限） */
export const SEQUENCE_MIN_NUMBER = 0;
export const SEQUENCE_MAX_NUMBER = 9999;
export const SEQUENCE_MAX_LINES = 2000;

/** 番号を全角または半角の数字にする（例: 10 → "１０" / "10"） */
export function formatNumber(n: number, width: SequenceWidth): string {
  const half = String(n);
  return width === "half" ? half : half.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

/** 番号の表示（例: 第１回 / 1回目 / 1） */
export function formatSequenceLabel(n: number, style: SequenceStyle, width: SequenceWidth): string {
  const num = formatNumber(n, width);
  if (style === "dai-kai") return `第${num}回`;
  if (style === "kai-me") return `${num}回目`;
  return num;
}

/** 1行ぶん（番号の表示 + 全角スペース + 項目名） */
export function formatSequenceLine(item: string, n: number, style: SequenceStyle, width: SequenceWidth): string {
  return `${formatSequenceLabel(n, style, width)}${SEQUENCE_SEPARATOR}${item}`;
}

export type NumberParse = { value: number } | { error: string };

/** 番号の入力（全角数字も可）→ 整数。空・小数・負の数・文字・範囲外はエラー（どの項目のエラーかは label で示す） */
export function parseSequenceNumber(raw: string, label: string): NumberParse {
  const s = raw.normalize("NFKC").trim();
  if (s === "") return { error: `${label}を入力してください` };
  if (!/^\d+$/.test(s)) return { error: `${label}は、0以上の整数（半角または全角の数字）で入力してください` };
  const n = Number(s);
  if (n < SEQUENCE_MIN_NUMBER || n > SEQUENCE_MAX_NUMBER) {
    return { error: `${label}は、${SEQUENCE_MIN_NUMBER}〜${SEQUENCE_MAX_NUMBER}の範囲で入力してください` };
  }
  return { value: n };
}

export interface SequenceResult {
  /** 出力の行（エラーのときは空） */
  lines: string[];
  /** 利用者に見せる案内（エラー、または入力待ちの案内）。なければ null */
  error: string | null;
  /** 複数項目のとき、読み飛ばした空行の数 */
  skippedBlankLines: number;
}

const empty = (error: string | null): SequenceResult => ({ lines: [], error, skippedBlankLines: 0 });

/** 項目名を1行にそろえる（改行は空白1つにして、前後の空白を除く） */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export interface SingleInput {
  item: string;
  start: string;
  end: string;
  style: SequenceStyle;
  width: SequenceWidth;
}

/** モードA: 1つの項目に、開始番号〜終了番号の連番を付ける */
export function generateSingle(input: SingleInput): SequenceResult {
  const item = oneLine(input.item);
  if (item === "") return empty("項目名を入力してください");
  const start = parseSequenceNumber(input.start, "開始番号");
  if ("error" in start) return empty(start.error);
  const end = parseSequenceNumber(input.end, "終了番号");
  if ("error" in end) return empty(end.error);
  if (start.value > end.value) {
    return empty("開始番号が終了番号より大きくなっています。開始番号は終了番号以下にしてください");
  }
  const count = end.value - start.value + 1;
  if (count > SEQUENCE_MAX_LINES) {
    return empty(`一度に作れるのは${SEQUENCE_MAX_LINES.toLocaleString("ja-JP")}行までです（現在${count.toLocaleString("ja-JP")}行）。範囲を分けて作ってください`);
  }
  const lines: string[] = [];
  for (let n = start.value; n <= end.value; n++) lines.push(formatSequenceLine(item, n, input.style, input.width));
  return { lines, error: null, skippedBlankLines: 0 };
}

export interface MultipleInput {
  /** 1行に1項目（改行区切り） */
  text: string;
  style: SequenceStyle;
  width: SequenceWidth;
}

/** モードB: 入力順に、項目ごとの連番を付ける（項目ごとに独立。初回は1） */
export function generateMultiple(input: MultipleInput): SequenceResult {
  const rawLines = input.text.split(/\r\n|\r|\n/);
  const counters = new Map<string, number>();
  const lines: string[] = [];
  let skipped = 0;
  for (const raw of rawLines) {
    const item = raw.trim();
    if (item === "") {
      skipped++;
      continue;
    }
    const n = (counters.get(item) ?? 0) + 1;
    if (n > SEQUENCE_MAX_NUMBER) {
      return empty(`「${item}」の番号が${SEQUENCE_MAX_NUMBER}を超えました。項目を分けて作ってください`);
    }
    counters.set(item, n);
    lines.push(formatSequenceLine(item, n, input.style, input.width));
    if (lines.length > SEQUENCE_MAX_LINES) {
      return empty(`一度に作れるのは${SEQUENCE_MAX_LINES.toLocaleString("ja-JP")}行までです。入力を分けて作ってください`);
    }
  }
  if (lines.length === 0) return { lines: [], error: "項目を1行に1つずつ入力してください", skippedBlankLines: skipped };
  return { lines, error: null, skippedBlankLines: skipped };
}

/** コピー用の文字（改行をそろえ、末尾の空行は付けない。1行が1項目のまま） */
export function toClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}
