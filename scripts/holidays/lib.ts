/**
 * 内閣府の公式祝日CSVを検証し、祝日データの更新内容を決める（Mr.Satto 祝日データの自動更新）。
 *
 * ここは「ファイルの読み書き・通信をしない」純粋な処理だけを置く（通信・書き込みは sync.ts）。
 * 入力（CSV）が壊れている・不審なときは、何も書き換えない（invalid）。祝日の計算は holidays.ts の
 * computeHolidays を使い、同じ仕組みを重複して実装しない。
 */
import { addDaysIso, computeHolidays, HOLIDAY_MAX_YEAR, HOLIDAY_MIN_YEAR, weekdayOfIso, type Holiday, type HolidayData } from "../../src/lib/calendar/holidays";
import type { OfficialHoliday, OfficialHolidayKind } from "../../src/lib/calendar/holiday-data.generated";

export const OFFICIAL_CSV_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";

export interface OfficialRow {
  /** YYYY-MM-DD */
  iso: string;
  name: string;
}

/** 更新後の祝日データ（holiday-data.generated.ts に書く内容） */
export interface GeneratedData {
  confirmedThroughYear: number;
  equinoxDays: Record<number, { spring: number; autumn: number }>;
  overrides: Record<number, OfficialHoliday[]>;
}

/** 取得したデータが不正・不審で、更新に使えない */
export class OfficialDataError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

// ---------------------------------------------------------------------------------------------
// 取得したバイト列 → 文字列 → 行
// ---------------------------------------------------------------------------------------------

/** 公式CSVとして受け付けるバイト数の範囲（実際は約21KB） */
export const CSV_MIN_BYTES = 2_000;
export const CSV_MAX_BYTES = 1_000_000;

/** 公式CSV（Shift_JIS。UTF-8になった場合も読める）を文字列にする。読めなければ OfficialDataError */
export function decodeOfficialBytes(bytes: Uint8Array): string {
  if (bytes.length < CSV_MIN_BYTES || bytes.length > CSV_MAX_BYTES) {
    throw new OfficialDataError([`ファイルの大きさが想定の範囲外です（${bytes.length}バイト。想定: ${CSV_MIN_BYTES}〜${CSV_MAX_BYTES}）`]);
  }
  const head = String.fromCharCode(...bytes.subarray(0, 20)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml") || head.startsWith("{")) {
    throw new OfficialDataError(["CSVではなく、Webページ（HTML）などが返されました"]);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    // UTF-8として読めなければ、Shift_JIS（内閣府の配布形式）として読む
  }
  try {
    return new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  } catch {
    throw new OfficialDataError(["文字コード（Shift_JIS・UTF-8）として読み取れませんでした"]);
  }
}

/** 祝日名に使ってよい文字（かな・漢字・括弧・中黒・数字・空白）。PDF・Excelの字体で表示できる範囲に限る */
const NAME_PATTERN = /^[぀-ヿ㐀-鿿々-〇（）()・0-9０-９ ]{1,30}$/;
const ROW_PATTERN = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),([^,]*)$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

function isValidDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * 公式CSVの本文を、行（日付と名称）にする。形式が少しでもおかしければ OfficialDataError。
 * 1行目はヘッダー（「国民の祝日…」）、以降は「Y/M/D,名称」で、日付は実在し、重複せず昇順であること。
 */
export function parseOfficialCsv(text: string): OfficialRow[] {
  const problems: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) throw new OfficialDataError(["CSVが空です"]);
  if (!lines[0].includes("国民の祝日") || ROW_PATTERN.test(lines[0])) {
    throw new OfficialDataError([`1行目が想定のヘッダー（「国民の祝日…」）ではありません: ${JSON.stringify(lines[0].slice(0, 40))}`]);
  }
  const rows: OfficialRow[] = [];
  let prev = "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const m = ROW_PATTERN.exec(line);
    if (!m) {
      problems.push(`${i + 1}行目の形式が不正です: ${JSON.stringify(line.slice(0, 40))}`);
      continue;
    }
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const name = m[4].trim();
    if (!isValidDate(y, mo, d)) {
      problems.push(`${i + 1}行目の日付が実在しません: ${m[1]}/${m[2]}/${m[3]}`);
      continue;
    }
    if (y < 1948 || y > HOLIDAY_MAX_YEAR) problems.push(`${i + 1}行目の年が範囲外です: ${y}`);
    if (!NAME_PATTERN.test(name)) problems.push(`${i + 1}行目の祝日名が不正です（使えない文字・長さ）: ${JSON.stringify(name.slice(0, 40))}`);
    const iso = `${y}-${pad2(mo)}-${pad2(d)}`;
    if (iso <= prev) problems.push(`${i + 1}行目の日付が、重複または昇順でありません: ${iso}`);
    prev = iso;
    rows.push({ iso, name });
  }
  if (rows.length < 100) problems.push(`祝日の行数が少なすぎます（${rows.length}行）`);
  if (problems.length) throw new OfficialDataError(problems.slice(0, 30));
  return rows;
}

/** 行を、テスト用の控え（UTF-8・LF・ヘッダーなし・日付はゼロ埋めなしのY/M/D）の文字列にする */
export function formatSnapshotCsv(rows: readonly OfficialRow[]): string {
  return rows.map((r) => `${Number(r.iso.slice(0, 4))}/${Number(r.iso.slice(5, 7))}/${Number(r.iso.slice(8, 10))},${r.name}`).join("\n") + "\n";
}

/** テスト用の控え（formatSnapshotCsv の形）を行にする。ヘッダーは不要 */
export function parseSnapshotCsv(text: string): OfficialRow[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\d{4}\//.test(l))
    .map((l) => {
      const [date, name] = l.split(",");
      const [y, m, d] = date.split("/").map(Number);
      return { iso: `${y}-${pad2(m)}-${pad2(d)}`, name: name.trim() };
    });
}

// ---------------------------------------------------------------------------------------------
// 公式の表記と、実装の表記の対応
// ---------------------------------------------------------------------------------------------

/**
 * 公式CSVは、振替休日と国民の休日をどちらも「休日」と書き、2019年の即位に伴う2日を「休日（祝日扱い）」と書く。
 * 実装は区別して表示するため、名前の一致は「公式の表記が、実装の種別（kind）と矛盾しないか」で判定する。
 */
export function nameMatches(official: string, mine: { name: string; kind: string }): boolean {
  if (official === "休日") return mine.kind === "substitute" || mine.kind === "citizens";
  if (official.startsWith("休日（祝日扱い）")) return mine.kind === "special";
  if (official === "体育の日（スポーツの日）") return mine.name === "体育の日"; // 2019年: 名称変更の前年
  return official === mine.name;
}

export interface YearDiff {
  year: number;
  /** 公式にあって、実装にない日 */
  added: string[];
  /** 実装にあって、公式にない日 */
  removed: string[];
  /** 日付は同じで、名称が違う日 */
  renamed: string[];
}

export const isEmptyDiff = (d: YearDiff) => d.added.length === 0 && d.removed.length === 0 && d.renamed.length === 0;

/** 1年分の公式の行と、実装の祝日を突き合わせる */
export function diffYear(year: number, official: readonly OfficialRow[], mine: readonly Holiday[]): YearDiff {
  const mineByIso = new Map(mine.map((h) => [h.iso, h]));
  const officialIso = new Set(official.map((r) => r.iso));
  return {
    year,
    added: official.filter((r) => !mineByIso.has(r.iso)).map((r) => `${r.iso} ${r.name}`),
    removed: mine.filter((h) => !officialIso.has(h.iso)).map((h) => `${h.iso} ${h.name}`),
    renamed: official.filter((r) => mineByIso.has(r.iso) && !nameMatches(r.name, mineByIso.get(r.iso)!)).map((r) => `${r.iso} ${mineByIso.get(r.iso)!.name} → ${r.name}`),
  };
}

/** 公式の「休日」を、振替休日・国民の休日・その他に分類する */
function classifyHoliday(row: OfficialRow, allDates: ReadonlySet<string>): OfficialHoliday {
  if (row.name === "休日") {
    // 振替休日: 直前に連続する祝日の中に、日曜日の祝日がある
    let back = addDaysIso(row.iso, -1);
    while (allDates.has(back)) {
      if (weekdayOfIso(back) === 0) return { iso: row.iso, name: "振替休日", kind: "substitute" };
      back = addDaysIso(back, -1);
    }
    // 国民の休日: 前日も翌日も祝日
    if (allDates.has(addDaysIso(row.iso, -1)) && allDates.has(addDaysIso(row.iso, 1))) return { iso: row.iso, name: "国民の休日", kind: "citizens" };
    return { iso: row.iso, name: "休日", kind: "special" };
  }
  const kind: OfficialHolidayKind = row.name.startsWith("休日（祝日扱い）") ? "special" : "national";
  return { iso: row.iso, name: row.name, kind };
}

// ---------------------------------------------------------------------------------------------
// 更新の計画
// ---------------------------------------------------------------------------------------------

export interface PlanInput {
  /** 検証済みの公式CSVの全行（parseOfficialCsv の結果） */
  rows: readonly OfficialRow[];
  /** 現在の祝日データ（実データ） */
  current: HolidayData;
  /** 現在のテスト用の控え（公式CSVの2000年以降）。なければ null */
  currentSnapshot: readonly OfficialRow[] | null;
  /** 今日（日本時間）YYYY-MM-DD。過去の年の判定に使う */
  today: string;
}

export type SyncPlan =
  | { status: "no-change"; confirmedThroughYear: number }
  | {
      status: "update";
      data: GeneratedData;
      /** テスト用の控えにする行（公式CSVの2000年〜確定済みの最終年） */
      snapshotRows: OfficialRow[];
      /** 更新前の実データ（いま画面に出ている祝日）からの変化 */
      changes: YearDiff[];
      /** 新しく確定した年 */
      newYears: number[];
      /** 公式CSVと計算ルールが食い違うため、公式の一覧を使う年 */
      overrideYears: number[];
      /** 計算ルールの見直しが必要かもしれない理由（空なら不要） */
      ruleReview: string[];
    }
  | { status: "invalid"; problems: string[] };

/** 公式CSVに全部の年が揃っているとみなす最後の年（その年の11月23日以降の行がある年）。 */
function completeThroughYearOf(rows: readonly OfficialRow[]): number {
  const last = rows[rows.length - 1].iso;
  const y = Number(last.slice(0, 4));
  return last >= `${y}-11-23` ? y : y - 1;
}

const yearOf = (iso: string) => Number(iso.slice(0, 4));

/** 更新前後の祝日データを比べるための文字列（日付の更新日は含めない） */
function fingerprint(d: { confirmedThroughYear: number; equinoxDays: Record<number, { spring: number; autumn: number }> | Readonly<Record<number, { spring: number; autumn: number }>>; overrides: Record<number, readonly OfficialHoliday[]> | Readonly<Record<number, readonly OfficialHoliday[]>> }): string {
  const sortKeys = <T,>(o: Readonly<Record<number, T>>) => Object.keys(o).map(Number).sort((a, b) => a - b).map((k) => [k, o[k]]);
  return JSON.stringify([d.confirmedThroughYear, sortKeys(d.equinoxDays), sortKeys(d.overrides)]);
}

/** 1回の更新で変わってよい行数の上限（毎年の追加は約17行。これを超える変化は、取得データの異常とみなして止める） */
export const MAX_CHANGED_ROWS = 80;

/**
 * 公式CSVの行から、更新後の祝日データを決める。
 *   1. 公式CSVに揃っている最後の年（確定済みの最終年）を決める。後退・異常な先の年は不正。
 *   2. 今年以降の年の春分・秋分を、公式から取り出して確定表にする。
 *   3. 年ごとに、計算ルールの結果と公式を突き合わせる。食い違う年は、公式の一覧をその年のデータ（override）にする。
 *      過去の年（今年より前）が食い違うときは、取得データの異常とみなして止める（過去の祝日は変わらない）。
 *   4. 最後に、更新後のデータで公式と全年一致することを自己検証する。
 */
export function planSync(input: PlanInput): SyncPlan {
  const { current, today } = input;
  const thisYear = Number(today.slice(0, 4));
  const problems: string[] = [];

  const rows = input.rows.filter((r) => r.iso >= `${HOLIDAY_MIN_YEAR}-01-01`);
  if (rows.length === 0) return { status: "invalid", problems: ["2000年以降の行がありません"] };

  const complete = completeThroughYearOf(rows);
  if (complete < current.confirmedThroughYear) problems.push(`公式CSVの最終年（${complete}年）が、現在の確定済みの最終年（${current.confirmedThroughYear}年）より前です（データが減っています）`);
  if (complete > thisYear + 3) problems.push(`公式CSVの最終年（${complete}年）が、今年（${thisYear}年）から3年を超えて先です`);
  if (complete > HOLIDAY_MAX_YEAR) problems.push(`公式CSVの最終年が対応範囲（〜${HOLIDAY_MAX_YEAR}年）を超えています`);
  if (problems.length) return { status: "invalid", problems };

  const official = rows.filter((r) => yearOf(r.iso) <= complete);
  const byYear = new Map<number, OfficialRow[]>();
  for (const r of official) byYear.set(yearOf(r.iso), [...(byYear.get(yearOf(r.iso)) ?? []), r]);
  for (let y = HOLIDAY_MIN_YEAR; y <= complete; y++) {
    const n = byYear.get(y)?.length ?? 0;
    if (n < 10 || n > 30) problems.push(`${y}年の祝日の数が想定の範囲外です（${n}日。想定: 10〜30日）`);
  }
  if (problems.length) return { status: "invalid", problems };
  const allDates = new Set(official.map((r) => r.iso));

  // --- 今年以降の春分・秋分を、公式から確定表に取り出す ---
  const equinoxDays: Record<number, { spring: number; autumn: number }> = { ...current.equinoxDays };
  for (let y = Math.max(HOLIDAY_MIN_YEAR, thisYear); y <= complete; y++) {
    const list = byYear.get(y) ?? [];
    const spring = list.filter((r) => r.name === "春分の日" && r.iso.slice(5, 7) === "03");
    const autumn = list.filter((r) => r.name === "秋分の日" && r.iso.slice(5, 7) === "09");
    if (spring.length === 1 && autumn.length === 1) equinoxDays[y] = { spring: Number(spring[0].iso.slice(8)), autumn: Number(autumn[0].iso.slice(8)) };
    else delete equinoxDays[y]; // 取り出せない年は、計算式のまま（その年は下の突き合わせで、公式の一覧を使う年になる）
  }

  // --- 年ごとの突き合わせ ---
  const candidate: HolidayData = { confirmedThroughYear: complete, equinoxDays, overrides: {} };
  const overrides: Record<number, OfficialHoliday[]> = {};
  for (let y = HOLIDAY_MIN_YEAR; y <= complete; y++) {
    const rowsOfYear = byYear.get(y) ?? [];
    if (y < thisYear) {
      // 過去の年は変わらないはず。現在のデータ（override を含む）と一致しなければ異常
      const diff = diffYear(y, rowsOfYear, computeHolidays(y, { ...candidate, overrides: current.overrides }));
      if (!isEmptyDiff(diff)) problems.push(`過去の年（${y}年）の公式データが、現在の祝日と一致しません: ${[...diff.added.map((s) => `+${s}`), ...diff.removed.map((s) => `-${s}`), ...diff.renamed.map((s) => `~${s}`)].join(" / ")}`);
      if (current.overrides[y]) overrides[y] = [...current.overrides[y]];
      continue;
    }
    if (!isEmptyDiff(diffYear(y, rowsOfYear, computeHolidays(y, candidate)))) overrides[y] = rowsOfYear.map((r) => classifyHoliday(r, allDates));
  }
  if (problems.length) return { status: "invalid", problems };

  const data: GeneratedData = { confirmedThroughYear: complete, equinoxDays, overrides };

  // --- 自己検証: 更新後のデータで、全年が公式と一致する ---
  const after: HolidayData = { confirmedThroughYear: complete, equinoxDays, overrides };
  for (let y = HOLIDAY_MIN_YEAR; y <= complete; y++) {
    const diff = diffYear(y, byYear.get(y) ?? [], computeHolidays(y, after));
    if (!isEmptyDiff(diff)) problems.push(`更新後のデータが公式と一致しません（${y}年）: ${JSON.stringify(diff)}`);
  }
  if (problems.length) return { status: "invalid", problems };

  // --- 変更の有無（取得した日付などは含めない） ---
  const snapshotRows = official;
  const sameData = fingerprint(data) === fingerprint(current);
  const prevSnapshot = input.currentSnapshot;
  const prevLines = prevSnapshot ? formatSnapshotCsv(prevSnapshot) : null;
  const newLines = formatSnapshotCsv(snapshotRows);
  if (sameData && prevLines === newLines) return { status: "no-change", confirmedThroughYear: complete };

  if (prevSnapshot) {
    const before = new Set(prevSnapshot.map((r) => `${r.iso},${r.name}`));
    const nowSet = new Set(snapshotRows.map((r) => `${r.iso},${r.name}`));
    let changed = 0;
    for (const k of nowSet) if (!before.has(k)) changed++;
    for (const k of before) if (!nowSet.has(k)) changed++;
    if (changed > MAX_CHANGED_ROWS) return { status: "invalid", problems: [`公式CSVの変更行数（${changed}行）が上限（${MAX_CHANGED_ROWS}行）を超えています。取得データの異常の可能性があるため、自動では更新しません`] };
  }

  // --- いま画面に出ている祝日（更新前の実データ）からの変化 ---
  const changes: YearDiff[] = [];
  for (let y = HOLIDAY_MIN_YEAR; y <= complete; y++) {
    const before = y <= HOLIDAY_MAX_YEAR ? computeHolidays(y, current) : [];
    const now = computeHolidays(y, after);
    const d = diffYear(y, now.map((h) => ({ iso: h.iso, name: h.name })), before);
    // diffYear(official=now, mine=before) は「新しく増えた／なくなった／名称が変わった」になる。種別の違いだけの差は除く
    const nameChanged = d.renamed.filter((s) => !/ (振替休日|国民の休日) → 休日$/.test(s));
    const diff: YearDiff = { year: y, added: d.added, removed: d.removed, renamed: nameChanged };
    if (!isEmptyDiff(diff)) changes.push(diff);
  }

  const overrideYears = Object.keys(overrides).map(Number).sort((a, b) => a - b);
  const ruleReview = overrideYears.map((y) => {
    const d = diffYear(y, byYear.get(y) ?? [], computeHolidays(y, candidate));
    return `${y}年: 計算ルールの結果と公式CSVが食い違います（${[...d.added.map((s) => `公式のみ ${s}`), ...d.removed.map((s) => `ルールのみ ${s}`), ...d.renamed.map((s) => `名称 ${s}`)].join(" / ")}）`;
  });

  const newYears: number[] = [];
  for (let y = current.confirmedThroughYear + 1; y <= complete; y++) newYears.push(y);
  return { status: "update", data, snapshotRows, changes, newYears, overrideYears, ruleReview };
}

// ---------------------------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------------------------

const GENERATED_HEADER = `/**
 * 祝日データ（自動生成。手で編集しない）。
 *
 * 内閣府の公式CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv）から、
 * scripts/holidays/sync.ts が検証したうえで書き換える。書き換えの方法・検証の内容は holiday-data.ts を参照。
 */
`;

/** holiday-data.generated.ts の内容を作る（同じデータからは、いつも同じ文字列になる） */
export function renderGeneratedModule(data: GeneratedData, checkedAt: string): string {
  const years = Object.keys(data.equinoxDays).map(Number).sort((a, b) => a - b);
  const equinox = years.map((y) => `  ${y}: { spring: ${data.equinoxDays[y].spring}, autumn: ${data.equinoxDays[y].autumn} },`).join("\n");
  const overrideYears = Object.keys(data.overrides).map(Number).sort((a, b) => a - b);
  const overrides = overrideYears.length
    ? "{\n" +
      overrideYears
        .map((y) => `  ${y}: [\n${data.overrides[y].map((h) => `    { iso: ${JSON.stringify(h.iso)}, name: ${JSON.stringify(h.name)}, kind: ${JSON.stringify(h.kind)} },`).join("\n")}\n  ],`)
        .join("\n") +
      "\n}"
    : "{}";
  return `${GENERATED_HEADER}
/** 暦要項が公示済みで、祝日が確定している最後の年（西暦）。この年までの祝日は「確定」として扱う */
export const CONFIRMED_THROUGH_YEAR = ${data.confirmedThroughYear};

/** 公式CSVの内容を最後にこのデータへ反映（確認）した日 */
export const HOLIDAY_DATA_CHECKED_AT = ${JSON.stringify(checkedAt)};

/** 暦要項で公示済みの春分の日・秋分の日（日付のうちの「日」の部分）。春分は3月、秋分は9月 */
export const CONFIRMED_EQUINOX_DAYS: Readonly<Record<number, { spring: number; autumn: number }>> = {
${equinox}
};

export type OfficialHolidayKind = "national" | "substitute" | "citizens" | "special";

/** 公式CSVに載っている祝日 */
export interface OfficialHoliday {
  /** YYYY-MM-DD */
  iso: string;
  name: string;
  kind: OfficialHolidayKind;
}

/**
 * 公式CSVと、holidays.ts の計算ルールの結果が食い違う年の、公式の祝日一覧。
 * 祝日法の改正（祝日の新設・日付や名称の変更・廃止）があると、その年がここに入り、その年の祝日は公式の一覧そのままになる。
 * 計算ルールと一致している年は入らない（通常は空）。
 */
export const OFFICIAL_HOLIDAY_OVERRIDES: Readonly<Record<number, readonly OfficialHoliday[]>> = ${overrides};
`;
}

/** 変更内容の説明（コミットメッセージ・実行結果の要約・Issue に使う） */
export function describePlan(plan: Extract<SyncPlan, { status: "update" }>): string[] {
  const lines: string[] = [];
  if (plan.newYears.length) lines.push(`新しく確定した年: ${plan.newYears.join("・")}年（確定済みの最終年を ${plan.data.confirmedThroughYear} 年に更新）`);
  for (const c of plan.changes) {
    for (const s of c.added) lines.push(`${c.year}年: 追加 ${s}`);
    for (const s of c.removed) lines.push(`${c.year}年: 削除 ${s}`);
    for (const s of c.renamed) lines.push(`${c.year}年: 名称変更 ${s}`);
  }
  if (plan.overrideYears.length) lines.push(`公式の一覧をそのまま使う年: ${plan.overrideYears.join("・")}年`);
  return lines;
}
