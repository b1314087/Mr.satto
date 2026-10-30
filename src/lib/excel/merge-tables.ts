/**
 * 複数の表（Excelのシート・CSV）を、見出しの名前で列を揃えて1つの表に結合する（純粋な処理だけ。通信も保存もしない）。
 *
 * 決まり（画面の説明・テストと同じ）:
 * - 各表の最初の空でない行を見出し行とし、それ以降をデータ行とする。
 * - 同じ名前の見出しの列を同じ列に揃える。名前は前後の空白を除き、全角・半角の違いを無視して照合する
 *   （例: 「ＡＢＣ」と「ABC」は同じ列）。結合後の見出しは、最初にその名前が出たファイルの表記を使う。
 * - 他のファイルに無い列は、新しい列として右に足し、そのファイルに無い行のセルは空にする。
 * - 見出しが空の列は「列C」のようにExcelの列記号で名前をつける。同じ表の中で見出しが重なる場合は
 *   「氏名(2)」のように番号をつける（データを失わないため）。
 * - 完全に空の行は取り除く。
 * - 「同じ行を除く」を選ぶと、見た目の値（前後の空白を除いた文字、日付は yyyy-mm-dd）が全部同じ行の2行目以降を除く。
 *   結合元の列は比べない。
 * - 入力の表は書き換えない。
 */
import { columnIndexToLetter, type XlsxCellValue } from "./xlsx-simple-io";

export const MERGE_MIN_SOURCES = 2;
export const MERGE_MAX_SOURCES = 20;
/** Excelの1シートの最大行数（1,048,576）から見出し行の分を引いた、結合後のデータ行の上限 */
export const MERGE_MAX_ROWS = 1_048_575;
/** Excelの1シートの最大列数 */
export const MERGE_MAX_COLUMNS = 16_384;
/** 「結合元」の列の既定の名前 */
export const MERGE_SOURCE_COLUMN_NAME = "結合元";

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export interface MergeSource {
  /** 画面と「結合元」の列に出す名前（ファイル名など） */
  label: string;
  /** 1行目から順の表。セルの値はそのまま使う */
  rows: XlsxCellValue[][];
}

export interface MergeOptions {
  /** 結合元（どのファイルの行か）の列を、右端に足す */
  addSourceColumn: boolean;
  /** 見た目の値が全部同じ行の、2行目以降を除く */
  removeDuplicates: boolean;
}

export interface MergeColumnInfo {
  /** 結合後の見出し */
  name: string;
  /** 各ファイルにこの列があったか（ファイルの順）。結合元の列は常に全部 false */
  presentIn: boolean[];
  /** 結合元の列か */
  isSource: boolean;
}

export interface MergeResult {
  /** 結合後の見出し（結合元の列を含む） */
  header: string[];
  /** 結合後のデータ行（見出しを除く）。各行の長さは header と同じ */
  rows: XlsxCellValue[][];
  /** rows の各行が、何番目のファイル（0始まり）から来たか */
  rowSourceIndex: number[];
  columns: MergeColumnInfo[];
  stats: {
    /** 各ファイルのデータ行の数（空行を除いた数） */
    inputRows: number[];
    /** 各ファイルで取り除いた空行の数の合計 */
    blankRowsSkipped: number;
    duplicatesRemoved: number;
    /** 最初のファイルに無かった列の数（結合元の列は含まない） */
    addedColumns: number;
  };
}

/** セルの値を、見た目の文字にする（日付は yyyy-mm-dd） */
export function cellToText(value: XlsxCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** 見出しを照合するための形（前後と途中の空白をそろえ、全角・半角の違いを無視する） */
export function headerKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function isBlankCell(value: XlsxCellValue | undefined): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function isBlankRow(row: XlsxCellValue[]): boolean {
  return row.every(isBlankCell);
}

interface PreparedSource {
  label: string;
  /** 各列の（この表の中で重ならない）見出し */
  names: string[];
  keys: string[];
  dataRows: XlsxCellValue[][];
  blankSkipped: number;
}

/** 1つの表を、見出しとデータ行に分ける */
function prepareSource(source: MergeSource): PreparedSource {
  const headerIndex = source.rows.findIndex((row) => !isBlankRow(row));
  if (headerIndex < 0) {
    throw new MergeError(`「${source.label}」に表のデータがありません。見出し行のある表を選んでください。`);
  }
  const headerRow = source.rows[headerIndex];
  const body = source.rows.slice(headerIndex + 1);
  // 行数が多くても安全なように、スプレッド構文は使わず1行ずつ調べる
  const width = body.reduce((max, r) => (r.length > max ? r.length : max), headerRow.length);

  const names: string[] = [];
  const keys: string[] = [];
  const used = new Set<string>();
  for (let c = 0; c < width; c++) {
    const raw = cellToText(headerRow[c]).replace(/\s+/g, " ").trim();
    const base = raw === "" ? `列${columnIndexToLetter(c)}` : raw;
    let name = base;
    let n = 2;
    while (used.has(headerKey(name))) {
      name = `${base}(${n})`;
      n++;
    }
    used.add(headerKey(name));
    names.push(name);
    keys.push(headerKey(name));
  }

  const dataRows: XlsxCellValue[][] = [];
  let blankSkipped = 0;
  for (const row of body) {
    if (isBlankRow(row)) blankSkipped++;
    else dataRows.push(row);
  }
  return { label: source.label, names, keys, dataRows, blankSkipped };
}

/** 複数の表を、見出しの名前で列を揃えて結合する。入力は書き換えない */
export function mergeTables(sources: MergeSource[], options: MergeOptions): MergeResult {
  if (sources.length < MERGE_MIN_SOURCES) {
    throw new MergeError(`結合するには、${MERGE_MIN_SOURCES}件以上のファイルを選んでください。`);
  }
  if (sources.length > MERGE_MAX_SOURCES) {
    throw new MergeError(`一度に結合できるのは${MERGE_MAX_SOURCES}件までです。件数を減らしてください。`);
  }

  const prepared = sources.map(prepareSource);

  // 列を、最初に出てきた順に集める
  const unionKeys: string[] = [];
  const unionNames: string[] = [];
  const indexByKey = new Map<string, number>();
  for (const p of prepared) {
    p.keys.forEach((key, c) => {
      if (!indexByKey.has(key)) {
        indexByKey.set(key, unionKeys.length);
        unionKeys.push(key);
        unionNames.push(p.names[c]);
      }
    });
  }
  if (unionNames.length === 0) {
    throw new MergeError("結合できる列がありません。見出し行のある表を選んでください。");
  }

  // 結合元の列の名前は、他の列と重ならないようにする
  let sourceColumnName = MERGE_SOURCE_COLUMN_NAME;
  if (options.addSourceColumn) {
    let n = 2;
    while (indexByKey.has(headerKey(sourceColumnName))) {
      sourceColumnName = `${MERGE_SOURCE_COLUMN_NAME}(${n})`;
      n++;
    }
  }
  const totalColumns = unionNames.length + (options.addSourceColumn ? 1 : 0);
  if (totalColumns > MERGE_MAX_COLUMNS) {
    throw new MergeError(`結合後の列数が多すぎます（上限${MERGE_MAX_COLUMNS.toLocaleString("ja-JP")}列）。`);
  }

  const width = unionNames.length;
  const rows: XlsxCellValue[][] = [];
  const rowSourceIndex: number[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;

  prepared.forEach((p, fileIndex) => {
    const columnMap = p.keys.map((key) => indexByKey.get(key) as number);
    for (const source of p.dataRows) {
      const row: XlsxCellValue[] = new Array<XlsxCellValue>(totalColumns).fill(null);
      for (let c = 0; c < columnMap.length; c++) {
        const value = source[c];
        row[columnMap[c]] = value === undefined ? null : value;
      }
      if (options.removeDuplicates) {
        const key = row
          .slice(0, width)
          .map((v) => cellToText(v).trim())
          .join("\u0001");
        if (seen.has(key)) {
          duplicatesRemoved++;
          continue;
        }
        seen.add(key);
      }
      if (options.addSourceColumn) row[width] = p.label;
      rows.push(row);
      rowSourceIndex.push(fileIndex);
      if (rows.length > MERGE_MAX_ROWS) {
        throw new MergeError(
          `結合後の行数が多すぎます（Excelの上限は${MERGE_MAX_ROWS.toLocaleString("ja-JP")}行）。ファイルを分けて結合してください。`
        );
      }
    }
  });

  const header = options.addSourceColumn ? [...unionNames, sourceColumnName] : unionNames;
  const keySets = prepared.map((p) => new Set(p.keys));
  const columns: MergeColumnInfo[] = unionKeys.map((key, i) => ({
    name: unionNames[i],
    presentIn: keySets.map((set) => set.has(key)),
    isSource: false,
  }));
  if (options.addSourceColumn) {
    columns.push({ name: sourceColumnName, presentIn: prepared.map(() => false), isSource: true });
  }

  const firstKeys = keySets[0];
  return {
    header,
    rows,
    rowSourceIndex,
    columns,
    stats: {
      inputRows: prepared.map((p) => p.dataRows.length),
      blankRowsSkipped: prepared.reduce((sum, p) => sum + p.blankSkipped, 0),
      duplicatesRemoved,
      addedColumns: unionKeys.filter((k) => !firstKeys.has(k)).length,
    },
  };
}
