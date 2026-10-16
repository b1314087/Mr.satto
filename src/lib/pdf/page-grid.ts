import {
  tryParseNumberCell,
  type ColumnInfo,
  type ReconstructedTable,
  type VerticalLabel,
} from "./table-reconstruction";

/**
 * PDF→Excelで、1ページ分の「推定した表」(ReconstructedTable)を、Excelに書き出す直前の
 * セルのグリッド(GridRow[])へ組み立てる。
 *
 * ここで次のような、PDFの見た目に合わせた整形を行う（すべて決定的な処理で、AIは使わない）:
 * - 罫線・結合セルの反映（セルごとに持たせ、行を並べ替えても罫線がずれないようにする）
 * - 左右に並んだ表（例: 号給1〜60の表と61〜120の表が横に並んでいる）を、縦に1つの表へ連結する
 * - 縦書きのラベル（1文字ずつ縦に並んでいた区分名）を、縦に結合した1つのセルにする
 */

export interface GridBorders {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

export interface GridCell {
  text: string;
  /** 横方向の結合数(2以上)。結合の先頭のセルだけに付く */
  columnSpan?: number;
  /** 縦方向の結合数(2以上)。結合の先頭のセルだけに付く */
  rowSpan?: number;
  /** 他のセルの結合に含まれるセル（出力時は結合に吸収されるため、値を持たない） */
  covered?: boolean;
  /** 文字を1文字ずつ縦に積んで表示するセル（縦書きのラベル） */
  vertical?: boolean;
  borders?: GridBorders;
  /** 見出しの行のセル(複数行の見出しを1行にまとめたもの) */
  header?: boolean;
  /** セル内の文字の左端・右端のx座標(見出しの結合判定用。連結後の行では使わない) */
  extent?: { left: number; right: number };
}

export type GridRow = GridCell[];

/** ページを画像にして調べた、行・列の境界線に実際に線が引かれているか */
export interface BorderPresence {
  /** 長さ = 行数+1。rowBorderPresent[i] = 行iの「上」(=行i-1の下)に線があるか */
  rowBorderPresent: boolean[];
  /** 長さ = 列数+1。colBorderPresent[j] = 列jの「左」(=列j-1の右)に線があるか */
  colBorderPresent: boolean[];
}

export interface BuildGridOptions {
  /** 左右に並んだ表を検出できたとき、縦に連結するか */
  stackSideBySide: boolean;
  /** 複数行に割れた見出しを、1行にまとめるか */
  collapseHeader: boolean;
}

export interface PageGrid {
  rows: GridRow[];
  columnCount: number;
  /** このページで、左右に並んだ表を縦に連結した */
  stacked: boolean;
  /** このページに、左右に並んだ表が見つかった(連結するかどうかにかかわらず) */
  sideBySideDetected: boolean;
  /** 縦書きのラベルをセルにした数 */
  verticalLabelCount: number;
  /** 複数行の見出しを1行にまとめた場合の、元の行数(まとめていなければ0) */
  collapsedHeaderRows: number;
  /** ページ番号・ヘッダー/フッターとして取り除いた行数(呼び出し側が設定する) */
  furnitureRemoved: number;
}

function emptyCell(): GridCell {
  return { text: "" };
}

function isEmptyCell(cell: GridCell | undefined): boolean {
  return !cell || (cell.text.trim() === "" && !cell.covered && !cell.rowSpan && !cell.columnSpan);
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// 基本のグリッド（文字・罫線・横の結合）
// ---------------------------------------------------------------------------

function buildBaseRows(table: ReconstructedTable, borders: BorderPresence | null): GridRow[] {
  const spanByRow = new Map<number, { col: number; span: number }>();
  for (const s of table.columnSpans) if (s.span >= 2) spanByRow.set(s.row, { col: s.col, span: s.span });

  return table.rows.map((row, r) => {
    const cells: GridRow = row.map((text, c) => ({
      text,
      extent: table.cellExtents[r]?.[c] ?? undefined,
      borders: borders
        ? {
            top: borders.rowBorderPresent[r] ?? false,
            bottom: borders.rowBorderPresent[r + 1] ?? false,
            left: borders.colBorderPresent[c] ?? false,
            right: borders.colBorderPresent[c + 1] ?? false,
          }
        : undefined,
    }));
    const s = spanByRow.get(r);
    if (s) {
      const end = Math.min(table.columnCount, s.col + s.span);
      // 結合先に別のテキストが入っている場合は、内容を失わないよう結合しない
      let canMerge = end - s.col >= 2;
      for (let c = s.col + 1; c < end; c++) if (cells[c].text.trim() !== "") canMerge = false;
      if (canMerge) {
        cells[s.col].columnSpan = end - s.col;
        for (let c = s.col + 1; c < end; c++) cells[c].covered = true;
        const first = cells[s.col].borders;
        const last = cells[end - 1].borders;
        if (first && last) first.right = last.right;
      }
    }
    return cells;
  });
}

// ---------------------------------------------------------------------------
// 左右に並んだ表の検出と、縦への連結
// ---------------------------------------------------------------------------

export interface SideBySideLayout {
  /** 右側の表の先頭の列(元のグリッドでの列番号) */
  split: number;
  /** 左側の表の先頭の列。右側の表の列kは、左側の表の列keyCol+kと対応する */
  keyCol: number;
  /** 右側の表の列数 */
  width: number;
  /** 表の本体(数値の行)の先頭・末尾の行番号 */
  dataStart: number;
  dataEnd: number;
  /** 右側の表のx座標を、左側の表のx座標へ変換するための差(右 − 左) */
  offsetX: number;
}

const MIN_SIDE_BY_SIDE_WIDTH = 3;
const MIN_SIDE_BY_SIDE_DATA_LINES = 4;
const OFFSET_TOLERANCE_PT = 8;

function isNumericColumn(info: ColumnInfo): boolean {
  return info.filled >= 3 && info.numeric / info.filled >= 0.8;
}

function anchorOf(info: ColumnInfo): number {
  // 数値は右揃えのことが多いので右端、文字は左端を、その列の位置の代表にする
  return isNumericColumn(info) ? info.right : info.left;
}

function keyValues(table: ReconstructedTable, col: number): number[] {
  const values: number[] = [];
  for (const row of table.rows) {
    const n = tryParseNumberCell(row[col] ?? "");
    if (n !== null) values.push(n);
  }
  return values;
}

function mostlyNonDecreasing(values: number[]): boolean {
  if (values.length < MIN_SIDE_BY_SIDE_DATA_LINES) return false;
  let ok = 0;
  for (let i = 1; i < values.length; i++) if (values[i] >= values[i - 1]) ok++;
  return ok / (values.length - 1) >= 0.9;
}

/**
 * 表が「同じ列構成の表が左右に並んでいる」レイアウトかを調べる。
 * 通常の横長の表(例: 4月〜9月の数値が並ぶ表)と区別するため、次をすべて満たしたときだけ検出する:
 * - 右側の表の各列の位置(列間隔)・型(数値/文字)が、左側の表の同じ並びの列と一致する
 * - 2つの表の間の空きが、表の内側の列と列の間よりはっきり広い
 * - 各表の先頭の列が、増えていく番号(例: 1〜60と61〜120)になっている
 */
export function detectSideBySide(table: ReconstructedTable): SideBySideLayout | null {
  const n = table.columnCount;
  const info = table.columnInfo;
  if (n < MIN_SIDE_BY_SIDE_WIDTH * 2) return null;

  let best: SideBySideLayout | null = null;
  for (let split = MIN_SIDE_BY_SIDE_WIDTH; split <= n - MIN_SIDE_BY_SIDE_WIDTH; split++) {
    const width = n - split;
    for (let keyCol = 0; keyCol + width <= split; keyCol++) {
      // 右側の表の先頭の列と、左側の表の先頭の列が、番号の列であること
      if (!isNumericColumn(info[split]) || !isNumericColumn(info[keyCol])) continue;

      // 型と位置の一致
      let sameShape = true;
      const offsets: number[] = [];
      for (let k = 0; k < width; k++) {
        const r = info[split + k];
        const l = info[keyCol + k];
        if (r.filled < 3 || l.filled < 3) {
          sameShape = false;
          break;
        }
        if (isNumericColumn(r) !== isNumericColumn(l)) {
          sameShape = false;
          break;
        }
        offsets.push(anchorOf(r) - anchorOf(l));
      }
      if (!sameShape) continue;
      if (Math.max(...offsets) - Math.min(...offsets) > OFFSET_TOLERANCE_PT) continue;

      // 2つの表の間の空きが、左側の表の内側の列間より十分に広い
      const interiorGaps: number[] = [];
      for (let c = keyCol; c < split - 1; c++) interiorGaps.push(info[c + 1].left - info[c].right);
      const blockGap = info[split].left - info[split - 1].right;
      if (!(blockGap >= Math.max(14, 2 * median(interiorGaps)))) continue;

      // 各表の先頭の列が増えていく番号になっている
      const leftKeys = keyValues(table, keyCol);
      const rightKeys = keyValues(table, split);
      if (!mostlyNonDecreasing(leftKeys) || !mostlyNonDecreasing(rightKeys)) continue;
      if (rightKeys.length < MIN_SIDE_BY_SIDE_DATA_LINES) continue;

      // 表の本体の範囲（左右どちらかの番号がある行）
      let dataStart = -1;
      let dataEnd = -1;
      table.rows.forEach((row, r) => {
        const hasKey =
          tryParseNumberCell(row[keyCol] ?? "") !== null || tryParseNumberCell(row[split] ?? "") !== null;
        if (!hasKey) return;
        if (dataStart < 0) dataStart = r;
        dataEnd = r;
      });
      if (dataStart < 0) continue;

      const layout: SideBySideLayout = {
        split,
        keyCol,
        width,
        dataStart,
        dataEnd,
        offsetX: median(offsets),
      };
      // 幅の広い(列数の多い)一致を優先する
      if (!best || layout.width > best.width) best = layout;
    }
  }
  return best;
}

/** 結合セルがsplitをまたぐ場合は、左側の表の中に収まるよう結合の範囲を縮める */
function clipSpans(cells: GridRow, limit: number): GridRow {
  const out = cells.slice(0, limit).map((c) => ({ ...c, borders: c.borders ? { ...c.borders } : undefined }));
  for (let c = 0; c < out.length; c++) {
    const span = out[c].columnSpan;
    if (span && c + span > limit) {
      const clipped = limit - c;
      if (clipped >= 2) out[c].columnSpan = clipped;
      else delete out[c].columnSpan;
    }
  }
  return out;
}

interface StackedResult {
  rows: GridRow[];
  columnCount: number;
  /** 元の行番号 → 連結後の行番号（左側の表・右側の表それぞれ） */
  leftMap: Map<number, number>;
  rightMap: Map<number, number>;
  /** 連結後の、左側の表の行範囲・右側の表の行範囲(含む)。該当する行が無ければnull */
  leftRange: [number, number] | null;
  rightRange: [number, number] | null;
  /** 連結後の「表の本体より後」の行の先頭の行番号 */
  afterStart: number;
}

function stackSideBySide(base: GridRow[], layout: SideBySideLayout): StackedResult {
  const { split, keyCol, width, dataStart, dataEnd } = layout;
  const newCols = split;
  const before: GridRow[] = [];
  const leftRows: GridRow[] = [];
  const rightRows: GridRow[] = [];
  const after: GridRow[] = [];
  const leftMap = new Map<number, number>();
  const rightMap = new Map<number, number>();
  // 連結後の行番号は、前 → 左 → 右 → 後の順に並べて最後に確定する
  const leftOrig: number[] = [];
  const rightOrig: number[] = [];
  const beforeOrig: number[] = [];
  const afterOrig: number[] = [];

  const hasContent = (cells: GridRow) => cells.some((c) => c.text.trim() !== "");

  base.forEach((cells, r) => {
    if (r < dataStart || r > dataEnd) {
      // 表の本体より前(タイトル・見出し)・後(注記など)の行は、そのまま
      const rightPart = cells.slice(split);
      if (!hasContent(rightPart)) {
        const target = r < dataStart ? before : after;
        (r < dataStart ? beforeOrig : afterOrig).push(r);
        target.push(clipSpans(cells, newCols));
      } else {
        const target = r < dataStart ? before : after;
        (r < dataStart ? beforeOrig : afterOrig).push(r);
        target.push(cells.map((c) => ({ ...c, borders: c.borders ? { ...c.borders } : undefined })));
      }
      return;
    }

    const left = clipSpans(cells.slice(0, split), newCols);
    if (hasContent(left)) {
      leftRows.push(left);
      leftOrig.push(r);
    }

    const rightPart = cells.slice(split);
    if (hasContent(rightPart)) {
      const row: GridRow = Array.from({ length: newCols }, emptyCell);
      for (let k = 0; k < width; k++) {
        const target = keyCol + k;
        if (target >= newCols) break;
        const src = rightPart[k];
        row[target] = { ...src, borders: src.borders ? { ...src.borders } : undefined };
        // 結合セルが表の右端を越える場合は縮める
        const span = row[target].columnSpan;
        if (span && target + span > newCols) {
          const clipped = newCols - target;
          if (clipped >= 2) row[target].columnSpan = clipped;
          else delete row[target].columnSpan;
        }
      }
      rightRows.push(row);
      rightOrig.push(r);
    }
  });

  const rows = [...before, ...leftRows, ...rightRows, ...after];
  let idx = beforeOrig.length;
  const leftFirst = idx;
  leftOrig.forEach((orig) => leftMap.set(orig, idx++));
  const rightFirst = idx;
  rightOrig.forEach((orig) => rightMap.set(orig, idx++));
  return {
    rows,
    columnCount: Math.max(newCols, ...rows.map((r) => r.length)),
    leftMap,
    rightMap,
    leftRange: leftOrig.length > 0 ? [leftFirst, rightFirst - 1] : null,
    rightRange: rightOrig.length > 0 ? [rightFirst, idx - 1] : null,
    afterStart: idx,
  };
}

// ---------------------------------------------------------------------------
// 縦書きラベルの配置
// ---------------------------------------------------------------------------

function overlapWidth(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** 全行の指定した位置に、空の列を1つ挿入する（結合セルがまたぐ位置なら結合を1つ広げる） */
function insertColumn(rows: GridRow[], at: number): void {
  for (const row of rows) {
    // この位置が、左のセルの結合の内側(先頭ではなく中間)かどうか
    let spannedBy = -1;
    for (let c = 0; c < Math.min(at, row.length); c++) {
      const span = row[c].columnSpan;
      if (span && c < at && at < c + span) spannedBy = c;
    }
    const cell: GridCell = emptyCell();
    if (spannedBy >= 0) {
      cell.covered = true;
      row[spannedBy].columnSpan = (row[spannedBy].columnSpan ?? 1) + 1;
    }
    // 行がatより短いときは、atまで空のセルで埋めてから挿入する
    while (row.length < at) row.push(emptyCell());
    row.splice(at, 0, cell);
  }
}

interface LabelPlacementContext {
  rows: GridRow[];
  /** 列ごとの位置の統計（挿入に合わせて更新していく） */
  colInfo: ColumnInfo[];
}

/**
 * 縦書きラベルを、rowStart〜rowEndの行にまたがる縦結合のセルとして置く。
 * ラベルのx座標(x, 幅width)が重なる列があり、その行範囲が空いていればその列に置く。
 * 重なる列が無い(列と列の間の余白にあった)場合は、新しい列を挿入して置く。
 */
function placeVerticalLabel(
  ctx: LabelPlacementContext,
  label: { text: string; x: number; width: number },
  rowStart: number,
  rowEnd: number
): GridCell {
  const { rows, colInfo } = ctx;
  const cellsFree = (col: number) => {
    for (let r = rowStart; r <= rowEnd; r++) {
      if (!isEmptyCell(rows[r]?.[col])) return false;
    }
    return true;
  };

  let targetCol = -1;
  let bestOverlap = 0;
  colInfo.forEach((info, c) => {
    if (!Number.isFinite(info.left) || !Number.isFinite(info.right)) return;
    const ov = overlapWidth(label.x, label.x + label.width, info.left, info.right);
    if (ov >= label.width * 0.5 && ov > bestOverlap && cellsFree(c)) {
      bestOverlap = ov;
      targetCol = c;
    }
  });

  if (targetCol < 0) {
    // どの列にも重ならない: ラベルの中心より左にある列の数の位置に、新しい列を挿入する
    const center = label.x + label.width / 2;
    let insertAt = 0;
    colInfo.forEach((info, c) => {
      if (Number.isFinite(info.left) && (info.left + info.right) / 2 < center) insertAt = c + 1;
    });
    insertColumn(rows, insertAt);
    colInfo.splice(insertAt, 0, { left: label.x, right: label.x + label.width, filled: 1, numeric: 0 });
    targetCol = insertAt;
  }

  const first = rows[rowStart][targetCol];
  first.text = label.text;
  first.vertical = true;
  const span = rowEnd - rowStart + 1;
  if (span >= 2) {
    first.rowSpan = span;
    for (let r = rowStart + 1; r <= rowEnd; r++) {
      rows[r][targetCol] = { text: "", covered: true };
    }
    // 結合したセルの下の罫線は、最後の行のものを使う
    const lastBorders = rows[rowEnd][targetCol]?.borders;
    if (first.borders && lastBorders) first.borders.bottom = lastBorders.bottom;
  }
  return first;
}

function numericCount(row: GridRow): number {
  return row.filter((c) => !c.covered && tryParseNumberCell(c.text) !== null).length;
}

/** 数値が2つ以上入っている行を、表の本体のデータ行とみなす */
function isDataRow(row: GridRow | undefined): boolean {
  return !!row && numericCount(row) >= 2;
}

/**
 * 縦書きのラベルは、PDFでは「表の本体全体にまたがる大きなセル」の中央に書かれていることが多い
 * (文字が書かれていたのは一部の行だけ)。同じ列が空いているデータ行が続く限り、
 * ラベルの縦結合を上下に広げる。同じ列に別のラベルがある場合は、その手前までにとどめる。
 */
function expandVerticalLabels(rows: GridRow[], cells: GridCell[], domains: [number, number][]): void {
  type Placed = { cell: GridCell; row: number; col: number; end: number };
  const placed: Placed[] = [];
  for (const cell of cells) {
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(cell);
      if (c >= 0) {
        placed.push({ cell, row: r, col: c, end: r + (cell.rowSpan ?? 1) - 1 });
        break;
      }
    }
  }
  const byCol = new Map<number, Placed[]>();
  for (const p of placed) byCol.set(p.col, [...(byCol.get(p.col) ?? []), p]);

  for (const [col, list] of byCol) {
    list.sort((a, b) => a.row - b.row);
    list.forEach((p, i) => {
      // 左右に連結した表のように、ラベルが属する範囲が決まっている場合は、その範囲の中でだけ広げる
      const domain = domains.find(([from, to]) => p.row >= from && p.row <= to) ?? [0, rows.length - 1];
      const prevRaw = list[i - 1];
      const nextRaw = list[i + 1];
      const prev = prevRaw && prevRaw.row >= domain[0] ? prevRaw : undefined;
      const next = nextRaw && nextRaw.row <= domain[1] ? nextRaw : undefined;
      // 同じ範囲に別のラベルがある場合、その間は中間で分ける
      const upLimit = prev ? prev.end + Math.floor((p.row - prev.end - 1) / 2) + 1 : domain[0];
      const downLimit = next ? p.end + Math.ceil((next.row - p.end - 1) / 2) : domain[1];
      const free = (r: number) => isDataRow(rows[r]) && isEmptyCell(rows[r][col]);
      let start = p.row;
      while (start - 1 >= upLimit && free(start - 1)) start--;
      let end = p.end;
      while (end + 1 <= downLimit && free(end + 1)) end++;
      if (start === p.row && end === p.end) return;
      // 結合の先頭を上へ移す
      const moved = rows[p.row][col];
      rows[p.row][col] = { text: "", covered: true };
      rows[start][col] = moved;
      for (let r = start + 1; r <= end; r++) rows[r][col] = { text: "", covered: true };
      moved.rowSpan = end - start + 1;
      p.row = start;
      p.end = end;
    });
  }
}

// ---------------------------------------------------------------------------
// 複数行に割れた見出しの結合
// ---------------------------------------------------------------------------

/** 見出しの行の判定: 表の本体(最初のデータ行)の直前から、行間が詰まっている行をさかのぼる */
function findHeaderBand(table: ReconstructedTable, rows: GridRow[], firstDataRow: number): { start: number; end: number } | null {
  if (firstDataRow < 2) return null;
  // データ行どうしの行間の代表値
  const pitches: number[] = [];
  for (let r = firstDataRow; r < Math.min(table.rowYs.length - 1, firstDataRow + 12); r++) {
    pitches.push(table.rowYs[r] - table.rowYs[r + 1]);
  }
  const pitch = median(pitches);
  if (!Number.isFinite(pitch) || pitch <= 0) return null;
  const limit = pitch * 1.3;

  let start = firstDataRow;
  for (let r = firstDataRow - 1; r >= 0; r--) {
    if (table.rowYs[r] - table.rowYs[r + 1] > limit) break;
    // 文字の列をまたぐセル(タイトル・注記)や数値の行は、見出しの一部としては扱わない
    if (rows[r].some((c) => c.columnSpan || c.covered)) break;
    if (isDataRow(rows[r])) break;
    start = r;
  }
  // 見出しの行は、最初のデータ行の直前の行まで
  const band = { start, end: firstDataRow - 1 };
  if (band.end - band.start + 1 < 2) return null;
  return band;
}

/** 縦に重なった2つの断片を、折り返された1つの語句(位置が揃っている)としてつなぐか */
function isWrappedContinuation(
  prev: { text: string; extent?: { left: number; right: number }; y: number; fontHeight: number },
  next: { text: string; extent?: { left: number; right: number }; y: number; fontHeight: number }
): boolean {
  if (!prev.extent || !next.extent) return false;
  const gapY = prev.y - next.y;
  if (gapY > Math.max(prev.fontHeight, next.fontHeight) * 1.6) return false;
  const centerDiff = Math.abs((prev.extent.left + prev.extent.right) / 2 - (next.extent.left + next.extent.right) / 2);
  const leftDiff = Math.abs(prev.extent.left - next.extent.left);
  return centerDiff <= 1.5 || leftDiff <= 1.5;
}

function collapseHeaderBand(
  table: ReconstructedTable,
  baseRows: GridRow[],
  band: { start: number; end: number },
  currentRows: GridRow[],
  currentStart: number
): GridRow {
  // 左右の表を連結したページでは、見出しの行も連結後の列数に合わせる
  const columnCount = currentRows[currentStart]?.length ?? Math.max(...baseRows.slice(band.start, band.end + 1).map((r) => r.length));
  const merged: GridRow = [];
  for (let c = 0; c < columnCount; c++) {
    let text = "";
    let last: { text: string; extent?: { left: number; right: number }; y: number; fontHeight: number } | null = null;
    for (let r = band.start; r <= band.end; r++) {
      const cell = baseRows[r][c];
      if (!cell || cell.text.trim() === "") continue;
      const frag = {
        text: cell.text,
        extent: cell.extent,
        y: table.rowYs[r],
        fontHeight: table.rowFontHeights[r],
      };
      if (last === null) text = cell.text;
      else {
        // 折り返された語句は空白なしでつなぐ。ただし英数字どうしがつながる場合は、語が1つにならないよう空白を入れる
        const latinBoundary = /[A-Za-z0-9]$/.test(last.text) && /^[A-Za-z0-9]/.test(cell.text);
        text += isWrappedContinuation(last, frag) && !latinBoundary ? cell.text : ` ${cell.text}`;
      }
      last = frag;
    }
    const top = baseRows[band.start][c]?.borders;
    const bottom = baseRows[band.end][c]?.borders;
    merged.push({
      text,
      header: text !== "",
      borders: top && bottom ? { top: top.top, bottom: bottom.bottom, left: top.left, right: top.right } : top,
    });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// ページのグリッドの組み立て
// ---------------------------------------------------------------------------

const MAX_HEADER_BAND_ROWS = 8;

export function buildPageGrid(
  table: ReconstructedTable,
  labels: VerticalLabel[],
  borders: BorderPresence | null,
  options: BuildGridOptions
): PageGrid {
  const baseRows = buildBaseRows(table, borders);
  let rows = baseRows;
  const layout = detectSideBySide(table);
  const sideBySideDetected = layout !== null;

  // 複数行に割れた見出しの範囲(元の行番号)。ラベルの配置・連結で行が変わる前に、元の行で調べておく
  const bands: { start: number; end: number }[] = [];
  if (options.collapseHeader) {
    const isData = table.rows.map((_, r) => isDataRow(baseRows[r]));
    for (let r = 1; r < table.rows.length; r++) {
      if (!isData[r] || isData[r - 1]) continue;
      const band = findHeaderBand(table, baseRows, r);
      if (!band || band.end - band.start + 1 > MAX_HEADER_BAND_ROWS) continue;
      // 左右の表を連結する場合、連結する範囲の内側の行は対象外
      if (layout && options.stackSideBySide && band.start >= layout.dataStart && band.end <= layout.dataEnd) continue;
      bands.push(band);
    }
  }

  let colInfo: ColumnInfo[] = table.columnInfo.map((c) => ({ ...c }));
  let leftRowOf: (orig: number) => number | undefined = (r) => r;
  let rightRowOf: (orig: number) => number | undefined = (r) => r;
  let newIndexOf: (orig: number) => number = (r) => r;
  let domains: [number, number][] = [];
  let stacked = false;

  if (layout && options.stackSideBySide) {
    const result = stackSideBySide(baseRows, layout);
    rows = result.rows;
    leftRowOf = (orig) => result.leftMap.get(orig);
    rightRowOf = (orig) => result.rightMap.get(orig);
    newIndexOf = (orig) =>
      orig < layout.dataStart ? orig : orig > layout.dataEnd ? result.afterStart + (orig - layout.dataEnd - 1) : orig;
    domains = [result.leftRange, result.rightRange].filter((d): d is [number, number] => d !== null);
    colInfo = colInfo.slice(0, layout.split);
    stacked = true;
  }

  // 縦書きラベルの配置
  const placedCells: GridCell[] = [];
  for (const label of labels) {
    const tolerance = label.fontHeight * 0.6;
    // 右側の表のラベルは、左側の表のラベルと同じ列に置く(x座標を左側の表の位置へ変換する)
    const isRight = stacked && layout !== null && label.x > colInfo[colInfo.length - 1].right;
    const mapRow = isRight ? rightRowOf : leftRowOf;
    const covered: number[] = [];
    table.rowYs.forEach((y, orig) => {
      if (y <= label.yTop + tolerance && y >= label.yBottom - tolerance) {
        const mapped = mapRow(orig);
        if (mapped !== undefined) covered.push(mapped);
      }
    });
    if (covered.length === 0) continue;
    const x = isRight && layout ? label.x - layout.offsetX : label.x;
    placedCells.push(
      placeVerticalLabel({ rows, colInfo }, { text: label.text, x, width: label.width }, Math.min(...covered), Math.max(...covered))
    );
  }
  expandVerticalLabels(rows, placedCells, domains);

  // 複数行に割れた見出しを1行にまとめる。後ろの帯から処理して、前の帯の行番号がずれないようにする
  let collapsedHeaderRows = 0;
  for (const band of [...bands].sort((a, b) => b.start - a.start)) {
    const start = newIndexOf(band.start);
    const end = newIndexOf(band.end);
    if (end < start || end - start !== band.end - band.start) continue;
    const header = collapseHeaderBand(table, baseRows, band, rows, start);
    rows.splice(start, end - start + 1, header);
    collapsedHeaderRows += band.end - band.start + 1;
  }

  // extent(見出しの結合判定用)は、出力用のセルには持ち越さない
  for (const row of rows) for (const cell of row) delete cell.extent;

  const columnCount = Math.max(1, ...rows.map((r) => r.length));
  return {
    rows,
    columnCount,
    stacked,
    sideBySideDetected,
    verticalLabelCount: placedCells.length,
    collapsedHeaderRows,
    furnitureRemoved: 0,
  };
}
