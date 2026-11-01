import { cellValueText, columnToLetters, type DocxContent, type XlsxBook, type XlsxCell } from "./office-reader";

/**
 * 機能B：別々の資料に書かれた「項目と値」を取り出して照合する（AI・外部送信は使わない）。
 *
 * 取り出す形（どれにも当てはまらない文は、照合の対象にならない）：
 *  1. 1つのセル・段落に「項目：値」（全角・半角のコロン、またはタブ）と書かれたもの
 *  2. 表の1行に「項目 | 値」と並んだもの（項目は短い文字。値は、その右の最初の空でないセル）
 *  3. 見出しの行がある表（見出しの行の下に、数値・日付の入った行が続く）：
 *     「行の先頭のセル／列の見出し」を項目名にする（例：「りんご／数量」）
 *
 * 項目の対応づけ：項目名を、全角・半角をそろえ、空白と末尾のコロンを除いた形で、同じものどうしを組にする。
 * 名前が違う項目は、利用者が画面で手動で組にできる。似ているだけの名前は、自動では組にしない。
 */

export interface ExtractedItem {
  label: string;
  key: string;
  value: string;
  /** Excelのセルから取った数値・日付（文字から読み取った値ではない） */
  typed?: { kind: "number" | "date"; value: number; percent?: boolean };
  location: string;
}

export type MatchStatus = "match" | "mismatch" | "missing" | "review";

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  match: "一致",
  mismatch: "不一致",
  missing: "片方に記載なし",
  review: "要確認",
};

export interface MatchRow {
  id: string;
  labelA: string;
  labelB: string;
  locationA: string;
  locationB: string;
  valueA: string;
  valueB: string;
  status: MatchStatus;
  reason: string;
  /** 利用者が手動で組にした行 */
  manual: boolean;
}

const LABEL_MAX = 30;

export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[:：]+$/, "")
    .toLowerCase();
}

function looksLikeValueOnly(text: string): boolean {
  const t = text.normalize("NFKC").trim();
  return parseNumber(t) !== null || parseDate(t) !== null;
}

function isLabelLike(text: string): boolean {
  const t = text.trim();
  if (t === "" || t.length > LABEL_MAX) return false;
  if (/[。．.!！?？]$/.test(t)) return false;
  if (t.includes("\n")) return false;
  return !looksLikeValueOnly(t);
}

function splitColon(text: string): { label: string; value: string } | null {
  const m = /^([^:：\t\n]{1,30}?)\s*(?:[:：]|\t)\s*([\s\S]+)$/.exec(text.trim());
  if (!m) return null;
  const label = m[1].trim();
  const value = m[2].trim();
  if (!label || !value || !isLabelLike(label)) return null;
  // 「10:30」のような時刻を、項目と値に分けない
  if (/^\d+$/.test(label) && /^\d/.test(value)) return null;
  return { label, value };
}

interface GridCell {
  text: string;
  typed?: ExtractedItem["typed"];
  location: string;
}

function extractFromGrid(grid: (GridCell | null)[][], out: ExtractedItem[]) {
  let header: { cols: Map<number, string> } | null = null;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const filled = row.map((c, i) => ({ c, i })).filter((x): x is { c: GridCell; i: number } => !!x.c && x.c.text.trim() !== "");
    if (filled.length === 0) {
      header = null;
      continue;
    }
    const allLabels = filled.every((x) => isLabelLike(x.c.text) && !x.c.typed);
    const next = grid[r + 1] ?? [];
    const nextHasValue = next.some((c) => c && c.text.trim() !== "" && (c.typed || looksLikeValueOnly(c.text)));
    // 見出しの行は、3列以上の表だけとする（2列の「項目 | 値」の並びを、見出しと取り違えないため）
    if (allLabels && filled.length >= 3 && nextHasValue) {
      header = { cols: new Map(filled.map((x) => [x.i, x.c.text.trim()])) };
      continue;
    }
    if (header && filled.length >= 2 && isLabelLike(filled[0].c.text)) {
      const rowLabel = filled[0].c.text.trim();
      for (const x of filled.slice(1)) {
        const h = header.cols.get(x.i);
        if (!h) continue;
        const label = `${rowLabel}／${h}`;
        out.push({ label, key: normalizeLabel(label), value: x.c.text.trim(), typed: x.c.typed, location: x.c.location });
      }
      continue;
    }
    header = null;
    // 1行の中の「項目 | 値」、または1つのセルの「項目：値」
    for (let k = 0; k < filled.length; k++) {
      const { c } = filled[k];
      const colon = !c.typed ? splitColon(c.text) : null;
      if (colon) {
        out.push({ label: colon.label, key: normalizeLabel(colon.label), value: colon.value, location: c.location });
        continue;
      }
      const nextCell = filled[k + 1];
      if (nextCell && !c.typed && isLabelLike(c.text)) {
        const label = c.text.trim().replace(/[:：]+$/, "");
        out.push({ label, key: normalizeLabel(label), value: nextCell.c.text.trim(), typed: nextCell.c.typed, location: nextCell.c.location });
        k++;
      }
    }
  }
}

function excelCellText(cell: XlsxCell): { text: string; typed?: ExtractedItem["typed"] } {
  const percent = !!cell.numFmt && /%/.test(cell.numFmt.replace(/"[^"]*"/g, ""));
  if (cell.kind === "number" && typeof cell.value === "number") {
    return { text: percent ? `${roundFloat(cell.value * 100)}%` : String(cell.value), typed: { kind: "number", value: cell.value, percent } };
  }
  if (cell.kind === "date" && typeof cell.value === "number") return { text: cellValueText(cell), typed: { kind: "date", value: cell.value } };
  return { text: cellValueText(cell) };
}

function roundFloat(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

export function extractFromXlsx(book: XlsxBook): ExtractedItem[] {
  const out: ExtractedItem[] = [];
  for (const sheet of book.sheets) {
    const grid: (GridCell | null)[][] = [];
    for (const cell of sheet.cells.values()) {
      if (cell.noCachedValue) continue;
      const { text, typed } = excelCellText(cell);
      if (text === "") continue;
      (grid[cell.row - 1] ??= [])[cell.col - 1] = { text, typed, location: `${sheet.name}!${columnToLetters(cell.col)}${cell.row}` };
    }
    for (let r = 0; r < grid.length; r++) grid[r] ??= [];
    extractFromGrid(grid, out);
  }
  return out;
}

export function extractFromDocx(content: DocxContent): ExtractedItem[] {
  const out: ExtractedItem[] = [];
  let paragraphNo = 0;
  for (const block of content.blocks) {
    if (block.kind === "paragraph") {
      if (block.text.trim() === "") continue;
      paragraphNo++;
      for (const line of block.text.split("\n")) {
        const colon = splitColon(line);
        if (colon) out.push({ label: colon.label, key: normalizeLabel(colon.label), value: colon.value, location: `第${paragraphNo}段落` });
      }
    } else {
      const grid = block.rows.map((row, ri) => row.map((text, ci) => ({ text, location: `表${block.tableIndex}・${ri + 1}行${ci + 1}列` })));
      extractFromGrid(grid, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 値の読み取り（正規化）と判定
// ---------------------------------------------------------------------------

export interface ParsedNumber {
  value: number;
  unit: string;
}

const CURRENCY_PREFIX = /^[¥￥$＄]/;

/** 「10,000円」「¥10,000」「▲1,000」「3個」「10%」などを、数値と単位に分ける。分けられなければ null */
export function parseNumber(raw: string): ParsedNumber | null {
  let t = raw.normalize("NFKC").trim().replace(/\s+/g, "");
  if (t === "") return null;
  let unit = "";
  let sign = 1;
  if (CURRENCY_PREFIX.test(raw.trim())) {
    unit = "円";
    t = t.replace(/^[¥$]/, "");
  }
  if (/^[▲△]/.test(t)) {
    sign = -1;
    t = t.slice(1);
  }
  const m = /^([+-]?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([^\d.,]{0,4})$/.exec(t);
  if (!m) return null;
  const suffix = m[3];
  if (suffix && /[\/\-年月日時分:]/.test(suffix)) return null;
  if (suffix) unit = suffix === "-" ? unit : suffix;
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return { value: (m[1] === "-" ? -1 : 1) * sign * n, unit: unit.replace(/^円\(税込\)$/, "円") };
}

export interface ParsedDate {
  /** yyyy-mm-dd。年が書かれていないときは null */
  iso: string | null;
  /** mm-dd（年が書かれていないときの比較用） */
  monthDay: string;
}

const ERA_BASE: Record<string, number> = { 令和: 2018, R: 2018, 平成: 1988, H: 1988, 昭和: 1925, S: 1925 };

/** 「2026/10/01」「2026-10-1」「2026年10月1日」「令和8年10月1日」「R8.10.1」「10月1日」を日付として読む */
export function parseDate(raw: string): ParsedDate | null {
  const t = raw
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[(（][月火水木金土日](?:曜日?)?[)）]$/, "");
  let m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(t);
  let year: number | null = null;
  let month: number;
  let day: number;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else if ((m = /^(令和|平成|昭和|[RHS])(元|\d{1,2})[.年\/](\d{1,2})[.月\/](\d{1,2})日?$/.exec(t))) {
    year = ERA_BASE[m[1]] + (m[2] === "元" ? 1 : Number(m[2]));
    month = Number(m[3]);
    day = Number(m[4]);
  } else if ((m = /^(\d{1,2})月(\d{1,2})日$/.exec(t))) {
    month = Number(m[1]);
    day = Number(m[2]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const md = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { iso: year !== null ? `${year}-${md}` : null, monthDay: md };
}

function serialToIso(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

type Parsed =
  | { kind: "number"; num: ParsedNumber }
  | { kind: "date"; date: ParsedDate }
  | { kind: "text"; text: string };

function parseValue(item: ExtractedItem): Parsed {
  if (item.typed?.kind === "date") {
    const iso = serialToIso(item.typed.value);
    return { kind: "date", date: { iso, monthDay: iso.slice(5) } };
  }
  if (item.typed?.kind === "number") {
    return { kind: "number", num: item.typed.percent ? { value: roundFloat(item.typed.value * 100), unit: "%" } : { value: item.typed.value, unit: "" } };
  }
  const date = parseDate(item.value);
  if (date) return { kind: "date", date };
  const num = parseNumber(item.value);
  if (num) return { kind: "number", num: { ...num, unit: num.unit === "％" ? "%" : num.unit } };
  return { kind: "text", text: item.value };
}

function formatNum(n: ParsedNumber): string {
  return `${n.value.toLocaleString("ja-JP", { maximumFractionDigits: 10 })}${n.unit}`;
}

/** 2つの値を照合する。確実に言えないときは「要確認」にする */
export function judgeValues(a: ExtractedItem, b: ExtractedItem): { status: MatchStatus; reason: string } {
  const pa = parseValue(a);
  const pb = parseValue(b);
  if (pa.kind === "number" && pb.kind === "number") {
    const ua = pa.num.unit;
    const ub = pb.num.unit;
    if (ua && ub && ua !== ub) {
      return { status: "review", reason: `単位が違うため、そのままは比べられません（${formatNum(pa.num)} と ${formatNum(pb.num)}）` };
    }
    const same = Math.abs(pa.num.value - pb.num.value) < 1e-9;
    const shown = `${formatNum(pa.num)} / ${formatNum(pb.num)}`;
    if (same) {
      const raw = a.value.trim() === b.value.trim();
      return { status: "match", reason: raw ? "同じ値です" : `数値として一致（桁区切り・単位・全角半角をそろえて比較：${shown}）` };
    }
    return { status: "mismatch", reason: `数値が違います（${shown}）` };
  }
  if (pa.kind === "date" && pb.kind === "date") {
    if (pa.date.iso && pb.date.iso) {
      return pa.date.iso === pb.date.iso
        ? { status: "match", reason: a.value.trim() === b.value.trim() ? "同じ値です" : `日付として一致（${pa.date.iso}）` }
        : { status: "mismatch", reason: `日付が違います（${pa.date.iso} / ${pb.date.iso}）` };
    }
    if (pa.date.monthDay !== pb.date.monthDay) return { status: "mismatch", reason: "月日が違います" };
    return { status: "review", reason: "片方に年が書かれていないため、同じ日か確かめられません" };
  }
  if (pa.kind !== pb.kind) {
    const name = { number: "数値", date: "日付", text: "文字" };
    return { status: "review", reason: `値の形が違います（${name[pa.kind]} と ${name[pb.kind]}）` };
  }
  const ta = a.value.normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  const tb = b.value.normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  if (a.value === b.value) return { status: "match", reason: "同じ値です" };
  if (ta === tb) return { status: "match", reason: "全角・半角、前後や連続した空白の違いを除いて一致" };
  if (ta.replace(/ /g, "") === tb.replace(/ /g, "")) return { status: "review", reason: "空白の位置だけが違います（同じものか確かめてください）" };
  if (ta.length >= 2 && tb.length >= 2 && (ta.includes(tb) || tb.includes(ta))) {
    return { status: "review", reason: "片方がもう片方の一部です（略称・追記の可能性。同じものか確かめてください）" };
  }
  return { status: "mismatch", reason: "文字が違います" };
}

function groupByKey(items: ExtractedItem[]): Map<string, ExtractedItem[]> {
  const map = new Map<string, ExtractedItem[]>();
  for (const it of items) {
    const list = map.get(it.key);
    if (list) list.push(it);
    else map.set(it.key, [it]);
  }
  return map;
}

function distinctValues(list: ExtractedItem[]): ExtractedItem[] {
  const seen = new Map<string, ExtractedItem>();
  for (const it of list) {
    const k = it.value.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!seen.has(k)) seen.set(k, it);
  }
  return Array.from(seen.values());
}

function joinValues(list: ExtractedItem[]): string {
  return list.map((i) => i.value).join(" ／ ");
}

function joinLocations(list: ExtractedItem[]): string {
  return list.map((i) => i.location).join("、");
}

function pairRow(id: string, listA: ExtractedItem[], listB: ExtractedItem[], manual: boolean): MatchRow {
  const da = distinctValues(listA);
  const db = distinctValues(listB);
  const base = {
    id,
    labelA: listA[0].label,
    labelB: listB[0].label,
    locationA: joinLocations(listA),
    locationB: joinLocations(listB),
    valueA: joinValues(da),
    valueB: joinValues(db),
    manual,
  };
  if (da.length > 1 || db.length > 1) {
    const which = [da.length > 1 ? "ファイルA" : "", db.length > 1 ? "ファイルB" : ""].filter(Boolean).join("・");
    return { ...base, status: "review", reason: `${which}に、同じ項目が複数あり、値が違います（どれを比べるか確かめてください）` };
  }
  const { status, reason } = judgeValues(da[0], db[0]);
  const dup = listA.length > 1 || listB.length > 1 ? "（同じ項目・同じ値が複数あります）" : "";
  return { ...base, status, reason: `${manual ? "手動で対応づけ。" : ""}${reason}${dup}` };
}

export interface MatchResult {
  rows: MatchRow[];
  itemsA: ExtractedItem[];
  itemsB: ExtractedItem[];
}

/**
 * 項目を照合する。manualPairs は、利用者が手動で組にした「Aの項目のかぎ → Bの項目のかぎ」。
 * excluded は、比べないことにした行のID（結果から外す）。
 */
export function matchItems(itemsA: ExtractedItem[], itemsB: ExtractedItem[], manualPairs: Record<string, string> = {}): MatchResult {
  const gA = groupByKey(itemsA);
  const gB = groupByKey(itemsB);
  const usedB = new Set<string>();
  const rows: MatchRow[] = [];
  const manualTargets = new Set(Object.values(manualPairs));
  for (const [key, listA] of gA) {
    const manualKey = manualPairs[key] && gB.has(manualPairs[key]) ? manualPairs[key] : undefined;
    const bKey = manualKey ?? (gB.has(key) && !manualTargets.has(key) ? key : undefined);
    const listB = bKey !== undefined ? gB.get(bKey) : undefined;
    if (listB && bKey !== undefined) {
      usedB.add(bKey);
      rows.push(pairRow(`a:${key}`, listA, listB, !!manualKey));
    } else {
      rows.push({
        id: `a:${key}`,
        labelA: listA[0].label,
        labelB: "",
        locationA: joinLocations(listA),
        locationB: "",
        valueA: joinValues(distinctValues(listA)),
        valueB: "（記載なし）",
        status: "missing",
        reason: "ファイルBに、同じ名前の項目が見つかりません",
        manual: false,
      });
    }
  }
  for (const [key, listB] of gB) {
    if (usedB.has(key)) continue;
    rows.push({
      id: `b:${key}`,
      labelA: "",
      labelB: listB[0].label,
      locationA: "",
      locationB: joinLocations(listB),
      valueA: "（記載なし）",
      valueB: joinValues(distinctValues(listB)),
      status: "missing",
      reason: "ファイルAに、同じ名前の項目が見つかりません",
      manual: false,
    });
  }
  return { rows, itemsA, itemsB };
}

export function countByStatus(rows: MatchRow[]): Record<MatchStatus, number> {
  const out: Record<MatchStatus, number> = { match: 0, mismatch: 0, missing: 0, review: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}

export const MATCH_RULES: string[] = [
  "取り出す項目：1つのセル・段落の「項目：値」（コロンまたはタブ）、表の1行に並んだ「項目 | 値」、見出しの行がある表の「行の先頭／列の見出し」。",
  "項目の対応づけ：全角・半角をそろえ、空白と末尾のコロンを除いた項目名が同じものを組にします。名前が違う項目は、下の「対応づける項目」で手動で組にできます。名前が似ているだけでは組にしません。",
  "数値：全角・半角、桁区切りのカンマ、「¥」「円」をそろえて比べます（例：「10,000円」と「10000」は一致）。単位が違う数値（「円」と「千円」など）は「要確認」にします。「▲」「△」はマイナスとして読みます。",
  "日付：「2026/10/01」「2026年10月1日」「令和8年10月1日」「R8.10.1」とExcelの日付を同じ日付として比べます。年が書かれていない日付は、月日が同じでも「要確認」にします。",
  "文字：全角・半角と、前後・連続した空白だけをそろえて比べます。空白の位置だけが違う、片方がもう片方の一部（略称など）の場合は「要確認」にし、同じものとは断定しません。",
  "同じ項目が1つのファイルに複数あり、値が違うときは「要確認」にします。数値と文字など、値の形が違うときも「要確認」です。",
];
