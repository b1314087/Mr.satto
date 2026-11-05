/**
 * 座席表作成（参加者の名簿）。ブラウザ内の処理だけ（名前は外部に送らない・保存しない）。
 *
 * 決まり（画面・テストと同じ）:
 * - 1行に1人。行の中の最初のタブ・「,」「、」「，」より後ろを役職（肩書き）にする。名前の中の空白では区切らない。
 * - 前後の空白は取り除き、途中の連続した空白は1つにまとめる。空の行は除く。
 * - 入力した順番が、席に入る順番になる。
 * - 同じ名前（全角・半角・大文字小文字・空白の違いを無視）が2人以上いるときは、2人目以降に「(2)」のように番号を付けて残す
 *   （席の入れ替えで、人を取り違えないため）。
 * - 行の先頭の数字（「12 山田太郎」「12、山田太郎」「12<タブ>山田太郎」）は、出席番号として読む（名前には含めない）。
 */
import type { XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

export interface Participant {
  id: number;
  name: string;
  role: string;
  /** ふりがな（付けるときだけ。空なら付けない） */
  reading?: string;
  /** 出席番号（行の先頭の数字、または表の「出席番号」の列。無ければ undefined） */
  number?: string;
}

export interface ParsedParticipants {
  participants: Participant[];
  /** 同じ名前のため、番号を付けた名前（変更後の名前） */
  renamedDuplicates: string[];
  /** 上限を超えたために読み込まなかった人数 */
  overLimit: number;
  /** 出席番号が書かれた行があったか */
  hasNumbers: boolean;
}

/** 1回に扱える参加者の上限 */
export const SEATING_MAX_PARTICIPANTS = 400;

/** 名前の照合に使う形（全角・半角、大文字小文字、空白の違いを無視する） */
export function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 表示に使う形（前後の空白を除き、途中の連続した空白は1つにまとめる） */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 行の先頭の出席番号（「12 山田」「１２、山田」「12. 山田」「12<タブ>山田」）を取り出す */
export function splitNumber(line: string): { number: string | null; rest: string } {
  const m = /^\s*([0-9０-９]{1,4})[\s.,、，．:：]+(\S.*)$/.exec(line);
  if (!m) return { number: null, rest: line };
  return { number: String(Number(m[1].normalize("NFKC"))), rest: m[2] };
}

/** 1行を、名前と役職に分ける */
export function splitLine(line: string): { name: string; role: string } {
  const m = /^([^\t,、，]*)[\t,、，](.*)$/.exec(line);
  if (!m) return { name: cleanText(line), role: "" };
  return { name: cleanText(m[1]), role: cleanText(m[2].replace(/[\t,、，]+/g, " ")) };
}

export function parseParticipants(text: string): ParsedParticipants {
  const participants: Participant[] = [];
  const renamedDuplicates: string[] = [];
  const used = new Set<string>();
  const counts = new Map<string, number>();
  let overLimit = 0;
  let hasNumbers = false;
  for (const raw of text.split(/\r?\n/)) {
    const { number, rest } = splitNumber(raw);
    const { name, role } = splitLine(rest);
    if (name === "") continue;
    if (participants.length >= SEATING_MAX_PARTICIPANTS) {
      overLimit++;
      continue;
    }
    const key = nameKey(name);
    let finalName = name;
    if (used.has(key)) {
      let n = (counts.get(key) ?? 1) + 1;
      while (used.has(nameKey(`${name}(${n})`))) n++;
      counts.set(key, n);
      finalName = `${name}(${n})`;
      renamedDuplicates.push(finalName);
    } else {
      counts.set(key, 1);
    }
    used.add(nameKey(finalName));
    if (number !== null) hasNumbers = true;
    participants.push({ id: participants.length, name: finalName, role, ...(number !== null ? { number } : {}) });
  }
  return { participants, renamedDuplicates, overLimit, hasNumbers };
}

const NAME_HEADERS = /^(氏名|名前|お名前|参加者|参加者名|生徒名|児童名|社員名|name|names|full ?name)$/i;
const READING_HEADERS = /^(ふりがな|フリガナ|ﾌﾘｶﾞﾅ|よみ|ヨミ|よみがな|ヨミガナ|読み|読み仮名|読みがな|読み方|かな|カナ|氏名かな|氏名カナ|kana|reading|furigana)$/i;
const NUMBER_HEADERS = /^(出席番号|出席No\.?|番号|No\.?|NO\.?|№|#|出席|学籍番号)$/i;
const ROLE_HEADERS = /^(役職|肩書き?|職位|職名|所属|部署|部門|会社名?|学年|クラス|担当|role|title|position|department)$/i;

function cellText(value: XlsxCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * 表（CSV・Excelのシート）から、名前と役職を取り出して、入力欄の文字（1行に「名前<タブ>役職」）にする。
 * 最初の空でない行に「氏名」「名前」などの見出しがあれば、その列（見出しの行は除く）。役職は「役職」「所属」などの見出しの列。
 * 見出しが無ければ、1列目を名前、2列目を役職とする。
 * 「ふりがな」「よみ」「フリガナ」などの見出しの列があれば、ふりがなも読み込む（readings は、文字の行と同じ順番）。
 */
export function namesFromRows(rows: XlsxCellValue[][]): {
  text: string;
  count: number;
  hadHeader: boolean;
  roleColumn: boolean;
  /** ふりがなの列があったときだけ。文字の行（1人ずつ）と同じ順番。空のこともある */
  readings: string[] | null;
} {
  const first = rows.findIndex((r) => r.some((c) => cellText(c).trim() !== ""));
  if (first < 0) return { text: "", count: 0, hadHeader: false, roleColumn: false, readings: null };
  const header = rows[first].map((c) => cellText(c).trim());
  const nameCol = header.findIndex((h) => NAME_HEADERS.test(h));
  const roleHeaderCol = header.findIndex((h) => ROLE_HEADERS.test(h));
  const readingCol = header.findIndex((h) => READING_HEADERS.test(h));
  const numberHeaderCol = header.findIndex((h) => NUMBER_HEADERS.test(h));
  const hadHeader = nameCol >= 0;
  // 見出しがないとき：1列目がすべて数字なら出席番号、名前は2列目
  const dataRows = rows.slice(first).filter((r) => r.some((c) => cellText(c).trim() !== ""));
  const firstColNumeric = !hadHeader && dataRows.length > 0 && dataRows.every((r) => /^[0-9０-９]{1,4}$/.test(cellText(r[0]).trim()) && cellText(r[1]).trim() !== "");
  const numberCol = hadHeader ? numberHeaderCol : firstColNumeric ? 0 : -1;
  const column = hadHeader ? nameCol : firstColNumeric ? 1 : 0;
  const roleCol = hadHeader ? roleHeaderCol : firstColNumeric ? (readingCol === 2 ? -1 : 2) : readingCol === 1 ? -1 : 1;
  const start = hadHeader || readingCol >= 0 ? first + 1 : first;
  const lines: string[] = [];
  const readings: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const name = cleanText(cellText(rows[i][column]).replace(/[\t,、，]/g, " "));
    if (name === "") continue;
    const role = roleCol >= 0 ? cleanText(cellText(rows[i][roleCol])) : "";
    const num = numberCol >= 0 ? cellText(rows[i][numberCol]).trim().normalize("NFKC") : "";
    const head = /^\d{1,4}$/.test(num) ? `${Number(num)}\t` : "";
    lines.push(head + (role ? `${name}\t${role}` : name));
    readings.push(readingCol >= 0 ? cleanReading(cellText(rows[i][readingCol])) : "");
  }
  return {
    text: lines.join("\n"),
    count: lines.length,
    hadHeader,
    roleColumn: roleCol >= 0 && lines.some((l) => l.includes("\t")),
    readings: readingCol >= 0 ? readings : null,
  };
}

/** ふりがなを整える（前後の空白を除き、途中の空白は1つにまとめる。長すぎるものは切る） */
export function cleanReading(text: string): string {
  return cleanText(text).slice(0, 40);
}

/**
 * まとめて貼り付けたふりがな（1行に1人。Excelの列をそのままコピーしたもの）を、名簿の上から順に割り当てる。
 * 途中の空の行は「その人はふりがな無し」として順番を保つ（Excelの空のセルをコピーすると空の行になるため）。
 * 最後の空の行は無視する。名簿より多い行は使わない。
 */
export function readingsFromPaste(text: string, names: string[]): { readings: Record<string, string>; used: number; extra: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const readings: Record<string, string> = {};
  names.forEach((name, i) => {
    if (i < lines.length) readings[name] = cleanReading(lines[i].split("\t")[0]);
  });
  return { readings, used: Math.min(lines.length, names.length), extra: Math.max(0, lines.length - names.length) };
}
