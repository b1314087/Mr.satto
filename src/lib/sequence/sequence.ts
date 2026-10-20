/**
 * 連番・項目一括生成（Mr.Satto 生成ツール）の計算ロジック。
 *
 * すべてブラウザ内の純関数で、外部通信・保存は行わない。画面（sequence-generator-tool.tsx）とテストの両方が、
 * ここだけを使う（番号の付け方を画面ごとに別々に実装しない）。
 *
 * ■ テンプレート（自由入力）
 *   1行ぶんの書き方を、利用者が自由に入力する。使える記号は次の2つだけ。
 *     {n}    連番（全角・半角は「数字」の設定で切り替える。変換されるのは番号だけ）
 *     {item} 項目名
 *   同じ記号が複数あれば、すべて置き換える。順序・間に入れる文字は自由。
 *     例: 第{n}回　{item} / {n}. {item} / {item}（第{n}回） / 【{n}】{item}
 *   片方、または両方の記号がなくてもよい（その旨を案内だけする）。
 *   上記以外の波かっこ（{番号}・{N}・対応していない {} ・全角の｛｝）は、直し方を示すエラーにする。
 *   初期値は「第{n}回　{item}」（全角スペース区切り）。
 *
 * ■ 単一項目（generateSingle）
 *   開始番号〜終了番号を1つずつ増やして並べる。開始番号が終了番号より大きいときは、
 *   勝手に逆順にせず、エラーとして直し方を案内する。
 *
 * ■ 複数項目（generateMultiple）
 *   入力の行の順に、項目ごとに独立して番号を増やす（初回は1）。離れた行に同じ項目があっても継続する。
 *   空行（空白だけの行を含む）は出力せず、番号も進めない。項目の同一判定は「前後の空白（全角空白も）を除いた文字の完全一致」。
 */

export type SequenceWidth = "full" | "half";

export const SEQUENCE_WIDTHS: { value: SequenceWidth; label: string }[] = [
  { value: "full", label: "全角（１２３）" },
  { value: "half", label: "半角（123）" },
];

export function isSequenceWidth(v: unknown): v is SequenceWidth {
  return v === "full" || v === "half";
}

/** テンプレートの初期値（全角スペース区切り） */
export const DEFAULT_TEMPLATE = "第{n}回　{item}";
/** 画面に出す、テンプレートの入力例 */
export const TEMPLATE_EXAMPLES: string[] = ["第{n}回　{item}", "{n}回目　{item}", "{n}. {item}", "{item}（第{n}回）", "【{n}】{item}", "{n}　{item}"];

export const TEMPLATE_NUMBER_TOKEN = "{n}";
export const TEMPLATE_ITEM_TOKEN = "{item}";
export const TEMPLATE_MAX_LENGTH = 200;

/** 番号に使える範囲と、1回に作れる行数の上限（画面が固まらないための安全のための制限） */
export const SEQUENCE_MIN_NUMBER = 0;
export const SEQUENCE_MAX_NUMBER = 9999;
export const SEQUENCE_MAX_LINES = 2000;

/** 番号を全角または半角の数字にする（例: 10 → "１０" / "10"） */
export function formatNumber(n: number, width: SequenceWidth): string {
  const half = String(n);
  return width === "half" ? half : half.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

export interface TemplateCheck {
  /** 使えないテンプレートのときの、直し方を示す案内。使えるなら null */
  error: string | null;
  /** 使えるが知らせたいこと（記号がないなど） */
  notes: string[];
  hasNumber: boolean;
  hasItem: boolean;
}

const USAGE = "使えるのは {n}（連番）と {item}（項目名）です";
const NUMBER_ALIASES = new Set(["番号", "連番", "no", "num", "number", "i", "回", "数字"]);
const ITEM_ALIASES = new Set(["項目", "項目名", "name", "title", "名前", "内容", "科目"]);

/** テンプレートの検査。使える記号は {n} と {item} だけ。それ以外の波かっこは、直し方を示すエラーにする */
export function checkTemplate(template: string): TemplateCheck {
  const fail = (error: string): TemplateCheck => ({ error, notes: [], hasNumber: false, hasItem: false });
  if (template.trim() === "") return fail("テンプレートを入力してください（例: 第{n}回　{item}）");
  if (/[\r\n]/.test(template)) return fail("テンプレートに改行は入れられません。1行で入力してください");
  if (template.length > TEMPLATE_MAX_LENGTH) return fail(`テンプレートは${TEMPLATE_MAX_LENGTH}文字までにしてください`);
  if (/[｛｝]/.test(template)) return fail(`全角の波かっこ（｛｝）は使えません。半角の { } で書いてください。${USAGE}`);

  for (const m of template.matchAll(/\{([^{}]*)\}/g)) {
    const name = m[1];
    if (name === "n" || name === "item") continue;
    const lower = name.toLowerCase();
    if (lower === "n" || lower === "item") return fail(`「${m[0]}」は小文字で {${lower}} と書いてください`);
    if (NUMBER_ALIASES.has(lower)) return fail(`「${m[0]}」は使えません。連番は {n} と書いてください`);
    if (ITEM_ALIASES.has(lower)) return fail(`「${m[0]}」は使えません。項目名は {item} と書いてください`);
    return fail(`「${m[0]}」は使えません。${USAGE}`);
  }
  // 記号として読めた部分を除いて、波かっこが残っていたら対応していない
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""))) {
    return fail(`波かっこ { } の対応が合っていません。連番は {n}、項目名は {item} と、閉じるところまで書いてください`);
  }

  const hasNumber = template.includes(TEMPLATE_NUMBER_TOKEN);
  const hasItem = template.includes(TEMPLATE_ITEM_TOKEN);
  const notes: string[] = [];
  if (!hasNumber) notes.push("{n} がないため、番号は出力されません。");
  if (!hasItem) notes.push("{item} がないため、項目名は出力されません。");
  return { error: null, notes, hasNumber, hasItem };
}

/**
 * テンプレートの {n} と {item} を置き換えた1行を返す（検査済みのテンプレートを渡すこと）。
 * 同じ記号はすべて置き換える。置き換えは1回の走査で行うので、項目名の中に「{n}」などの文字があっても、再び置き換えない。
 * 全角・半角の変換は番号だけに適用し、項目名とテンプレートの文字はそのまま。
 */
export function applyTemplate(template: string, item: string, n: number, width: SequenceWidth): string {
  return template.replace(/\{(n|item)\}/g, (_all, name: string) => (name === "n" ? formatNumber(n, width) : item));
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
  /** error の原因がテンプレートか（画面では、テンプレート欄の近くに出す） */
  errorKind: "template" | "input" | null;
  /** テンプレートについての補足（記号がないなど。エラーではない） */
  notes: string[];
  /** 複数項目のとき、読み飛ばした空行の数 */
  skippedBlankLines: number;
}

const fail = (error: string, errorKind: "template" | "input", notes: string[] = [], skipped = 0): SequenceResult => ({
  lines: [],
  error,
  errorKind,
  notes,
  skippedBlankLines: skipped,
});

/** 項目名を1行にそろえる（改行は空白1つにして、前後の空白を除く） */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export interface SingleInput {
  item: string;
  start: string;
  end: string;
  template: string;
  width: SequenceWidth;
}

/** モードA: 1つの項目に、開始番号〜終了番号の連番を付ける */
export function generateSingle(input: SingleInput): SequenceResult {
  const check = checkTemplate(input.template);
  if (check.error) return fail(check.error, "template");
  const item = oneLine(input.item);
  // {item} を使わないテンプレートでは、項目名は出力に使わないので、空でもよい
  if (check.hasItem && item === "") return fail("項目名を入力してください", "input", check.notes);
  const start = parseSequenceNumber(input.start, "開始番号");
  if ("error" in start) return fail(start.error, "input", check.notes);
  const end = parseSequenceNumber(input.end, "終了番号");
  if ("error" in end) return fail(end.error, "input", check.notes);
  if (start.value > end.value) {
    return fail("開始番号が終了番号より大きくなっています。開始番号は終了番号以下にしてください", "input", check.notes);
  }
  const count = end.value - start.value + 1;
  if (count > SEQUENCE_MAX_LINES) {
    return fail(
      `一度に作れるのは${SEQUENCE_MAX_LINES.toLocaleString("ja-JP")}行までです（現在${count.toLocaleString("ja-JP")}行）。範囲を分けて作ってください`,
      "input",
      check.notes,
    );
  }
  const lines: string[] = [];
  for (let n = start.value; n <= end.value; n++) lines.push(applyTemplate(input.template, item, n, input.width));
  return { lines, error: null, errorKind: null, notes: check.notes, skippedBlankLines: 0 };
}

export interface MultipleInput {
  /** 1行に1項目（改行区切り） */
  text: string;
  template: string;
  width: SequenceWidth;
}

/** モードB: 入力順に、項目ごとの連番を付ける（項目ごとに独立。初回は1） */
export function generateMultiple(input: MultipleInput): SequenceResult {
  const check = checkTemplate(input.template);
  if (check.error) return fail(check.error, "template");
  const counters = new Map<string, number>();
  const lines: string[] = [];
  let skipped = 0;
  for (const raw of input.text.split(/\r\n|\r|\n/)) {
    const item = raw.trim();
    if (item === "") {
      skipped++;
      continue;
    }
    const n = (counters.get(item) ?? 0) + 1;
    if (n > SEQUENCE_MAX_NUMBER) {
      return fail(`「${item}」の番号が${SEQUENCE_MAX_NUMBER}を超えました。項目を分けて作ってください`, "input", check.notes, skipped);
    }
    counters.set(item, n);
    lines.push(applyTemplate(input.template, item, n, input.width));
    if (lines.length > SEQUENCE_MAX_LINES) {
      return fail(`一度に作れるのは${SEQUENCE_MAX_LINES.toLocaleString("ja-JP")}行までです。入力を分けて作ってください`, "input", check.notes, skipped);
    }
  }
  if (lines.length === 0) return fail("項目を1行に1つずつ入力してください", "input", check.notes, skipped);
  return { lines, error: null, errorKind: null, notes: check.notes, skippedBlankLines: skipped };
}

/** コピー用の文字（改行をそろえ、末尾の空行は付けない。1行が1項目のまま） */
export function toClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}
