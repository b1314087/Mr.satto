import { diffSequences, groupChunks } from "./sequence-diff";
import { cellValueText, columnToLetters, type DocxBlock, type DocxContent, type XlsxBook, type XlsxCell, type XlsxSheetData } from "./office-reader";

/**
 * 機能A：ファイル同士の差分（Excel同士・Word同士）。
 * 結果は、画面・Excel出力・Word出力のすべてで、この DiffRow の並びをそのまま使う（画面と出力の内容を一致させるため）。
 */

export type DiffKind =
  | "sheet-added"
  | "sheet-removed"
  | "row-added"
  | "row-removed"
  | "value-changed"
  | "value-added"
  | "value-removed"
  | "type-changed"
  | "formula-changed"
  | "result-changed"
  | "text-added"
  | "text-removed"
  | "text-changed"
  | "space-changed";

export const DIFF_KIND_LABEL: Record<DiffKind, string> = {
  "sheet-added": "シートが追加",
  "sheet-removed": "シートが削除",
  "row-added": "行が追加",
  "row-removed": "行が削除",
  "value-changed": "値が変更",
  "value-added": "値が追加",
  "value-removed": "値が削除",
  "type-changed": "値の種類が変更",
  "formula-changed": "数式が変更",
  "result-changed": "計算結果が変更",
  "text-added": "文章が追加",
  "text-removed": "文章が削除",
  "text-changed": "文章が変更",
  "space-changed": "空白・改行だけが変更",
};

export interface DiffRow {
  kind: DiffKind;
  /** Excel：シート名（Word：見出しなど、場所の補足。無ければ空） */
  group: string;
  /** Excel：セルの番地（行がずれたときは「B4 → B5」）・「4行目」など。Word：「第3段落」「表1・2行目」 */
  location: string;
  before: string;
  after: string;
  /** 補足（何を比べたか、など） */
  note: string;
}

export interface DiffResult {
  target: "xlsx" | "docx";
  rows: DiffRow[];
  /** 比べた範囲・扱いの説明（画面と出力に出す） */
  notes: string[];
  /** 比べた単位の数（Excel：セル、Word：段落・表の行） */
  comparedUnits: number;
}

export interface XlsxDiffOptions {
  /** true：数式と値の両方を比べる。false：値（計算結果）だけを比べる */
  compareFormulas: boolean;
  /** true：行の追加・削除を見つけ、行がずれても内容で対応づける。false：同じ番地どうしを比べる */
  alignRows: boolean;
}

const KIND_NAME: Record<XlsxCell["kind"], string> = { number: "数値", date: "日付", string: "文字", boolean: "真偽値", error: "エラー" };

function cellDisplay(cell: XlsxCell | undefined, showFormula: boolean): string {
  if (!cell) return "（空欄）";
  const value = cell.noCachedValue ? "（計算結果なし）" : cellValueText(cell);
  if (showFormula && cell.formula !== null) return `=${cell.formula}（結果：${value === "" ? "空" : value}）`;
  return value;
}

/** 値の比較用のかぎ（種類＋値）。数値の 1 と文字の "1" は別のものとして扱う */
function valueKey(cell: XlsxCell | undefined): string {
  if (!cell || (cell.noCachedValue && cell.formula === null)) return "";
  if (cell.noCachedValue) return "";
  return `${cell.kind === "date" ? "number" : cell.kind}:${String(cell.value)}`;
}

function compareCells(a: XlsxCell | undefined, b: XlsxCell | undefined, opts: XlsxDiffOptions): { kind: DiffKind; note: string } | null {
  const aEmpty = !a;
  const bEmpty = !b;
  if (aEmpty && bEmpty) return null;
  if (aEmpty) return { kind: "value-added", note: b && b.formula !== null && opts.compareFormulas ? "数式が入りました" : "" };
  if (bEmpty) return { kind: "value-removed", note: "" };
  if (opts.compareFormulas && (a.formula ?? "") !== (b.formula ?? "")) {
    if (a.formula === null || b.formula === null) {
      return { kind: "formula-changed", note: a.formula === null ? "値が数式に変わりました" : "数式が値に変わりました" };
    }
    return { kind: "formula-changed", note: "" };
  }
  // 計算結果がファイルに保存されていない数式は、数式だけを比べる
  if (a.noCachedValue || b.noCachedValue) {
    if (!opts.compareFormulas && (a.formula ?? "") !== (b.formula ?? "")) return { kind: "formula-changed", note: "計算結果が保存されていないため、数式で比べました" };
    return null;
  }
  const sameType = (a.kind === "date" ? "number" : a.kind) === (b.kind === "date" ? "number" : b.kind);
  if (!sameType) {
    return { kind: "type-changed", note: `${KIND_NAME[a.kind]} → ${KIND_NAME[b.kind]}` };
  }
  if (valueKey(a) !== valueKey(b)) {
    if (opts.compareFormulas && a.formula !== null) return { kind: "result-changed", note: "数式は同じで、計算結果が違います" };
    return { kind: "value-changed", note: "" };
  }
  return null;
}

function rowCells(sheet: XlsxSheetData): Map<number, XlsxCell[]> {
  const rows = new Map<number, XlsxCell[]>();
  for (const cell of sheet.cells.values()) {
    const list = rows.get(cell.row);
    if (list) list.push(cell);
    else rows.set(cell.row, [cell]);
  }
  for (const list of rows.values()) list.sort((x, y) => x.col - y.col);
  return rows;
}

function rowKey(cells: XlsxCell[] | undefined, opts: XlsxDiffOptions): string {
  if (!cells) return "";
  return cells.map((c) => `${c.col}=${valueKey(c)}${opts.compareFormulas && c.formula !== null ? `|${c.formula}` : ""}`).join("\u0001");
}

function rowSummary(cells: XlsxCell[] | undefined): string {
  if (!cells || cells.length === 0) return "（空の行）";
  const text = cells.map((c) => `${columnToLetters(c.col)}:${cellDisplay(c, false)}`).join("　");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function compareRowPair(
  sheetLabel: string,
  rowA: number,
  rowB: number,
  cellsA: XlsxCell[] | undefined,
  cellsB: XlsxCell[] | undefined,
  opts: XlsxDiffOptions,
  out: DiffRow[]
): number {
  const byColA = new Map((cellsA ?? []).map((c) => [c.col, c]));
  const byColB = new Map((cellsB ?? []).map((c) => [c.col, c]));
  const cols = Array.from(new Set([...byColA.keys(), ...byColB.keys()])).sort((x, y) => x - y);
  for (const col of cols) {
    const a = byColA.get(col);
    const b = byColB.get(col);
    const cmp = compareCells(a, b, opts);
    if (!cmp) continue;
    const letters = columnToLetters(col);
    const location = rowA === rowB ? `${letters}${rowA}` : `${letters}${rowA} → ${letters}${rowB}`;
    const showFormula = opts.compareFormulas;
    out.push({ kind: cmp.kind, group: sheetLabel, location, before: cellDisplay(a, showFormula), after: cellDisplay(b, showFormula), note: cmp.note });
  }
  return cols.length;
}

function sheetLabel(a: XlsxSheetData | undefined, b: XlsxSheetData | undefined): string {
  const s = a ?? b!;
  const hidden = (a?.hidden ?? false) || (b?.hidden ?? false);
  return hidden ? `${s.name}（非表示）` : s.name;
}

/** 行の先頭の値（最初の空でないセル）。行の組み合わせの目印にする */
function rowLabel(cells: XlsxCell[] | undefined): string {
  if (!cells || cells.length === 0) return "";
  return `${cells[0].col}:${valueKey(cells[0])}`;
}

/**
 * 違う部分の、削除された行と追加された行を組にする。
 * 1. 行の先頭の値が同じ行どうしを、順番を保って組にする（例：「B商品」の行の金額だけが変わった）
 * 2. その間に残った行は、前から順に組にする。余った行は、行の削除・追加として返す
 */
function pairRowsByLabel(
  del: number[],
  ins: number[],
  rowsA: Map<number, XlsxCell[]>,
  rowsB: Map<number, XlsxCell[]>
): { pairs: [number, number][]; deleted: number[]; inserted: number[] } {
  const la = del.map((i) => rowLabel(rowsA.get(i + 1)));
  const lb = ins.map((i) => rowLabel(rowsB.get(i + 1)));
  const ops = diffSequences(la, lb, (x, y) => x !== "" && x === y, 500);
  const pairs: [number, number][] = [];
  const deleted: number[] = [];
  const inserted: number[] = [];
  if (!ops) {
    const n = Math.min(del.length, ins.length);
    for (let i = 0; i < n; i++) pairs.push([del[i], ins[i]]);
    return { pairs, deleted: del.slice(n), inserted: ins.slice(n) };
  }
  for (const chunk of groupChunks(ops)) {
    if (chunk.type === "equal") {
      pairs.push([del[chunk.a], ins[chunk.b]]);
      continue;
    }
    // 先頭の値が違う行どうしは、両方に同じ数だけあるときだけ、前から順に組にする（数が違えば、追加・削除として出す）
    if (chunk.deleted.length === chunk.inserted.length) {
      chunk.deleted.forEach((d, i) => pairs.push([del[d], ins[chunk.inserted[i]]]));
    } else {
      deleted.push(...chunk.deleted.map((d) => del[d]));
      inserted.push(...chunk.inserted.map((i) => ins[i]));
    }
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return { pairs, deleted, inserted };
}

export function diffXlsx(bookA: XlsxBook, bookB: XlsxBook, opts: XlsxDiffOptions): DiffResult {
  const rows: DiffRow[] = [];
  const notes: string[] = [];
  let compared = 0;
  let alignFallback = false;
  const sheetsB = new Map(bookB.sheets.map((s) => [s.name, s]));
  const namesA = new Set(bookA.sheets.map((s) => s.name));

  for (const sa of bookA.sheets) {
    const sb = sheetsB.get(sa.name);
    if (!sb) {
      rows.push({ kind: "sheet-removed", group: sheetLabel(sa, undefined), location: "-", before: `あり（値のあるセル${sa.cells.size}個）`, after: "なし", note: "" });
      continue;
    }
    const label = sheetLabel(sa, sb);
    const rowsA = rowCells(sa);
    const rowsB = rowCells(sb);
    const maxRow = Math.max(sa.maxRow, sb.maxRow);
    let aligned = false;
    if (opts.alignRows) {
      const seqA = Array.from({ length: sa.maxRow }, (_, i) => rowKey(rowsA.get(i + 1), opts));
      const seqB = Array.from({ length: sb.maxRow }, (_, i) => rowKey(rowsB.get(i + 1), opts));
      const ops = diffSequences(seqA, seqB, (x, y) => x === y, 2000);
      if (ops) {
        aligned = true;
        for (const chunk of groupChunks(ops)) {
          if (chunk.type === "equal") {
            compared += rowsA.get(chunk.a + 1)?.length ?? 0;
            continue;
          }
          // 違う部分：行の先頭の値（「B商品」など）が同じ行どうしを、順番を保って組にする。残りは前から順に組にし、
          // 余った行は、行の追加・削除にする
          const { pairs, deleted, inserted } = pairRowsByLabel(chunk.deleted, chunk.inserted, rowsA, rowsB);
          for (const [ia, ib] of pairs) {
            compared += compareRowPair(label, ia + 1, ib + 1, rowsA.get(ia + 1), rowsB.get(ib + 1), opts, rows);
          }
          for (const idx of deleted) {
            const r = idx + 1;
            if (!rowsA.get(r)) continue;
            rows.push({ kind: "row-removed", group: label, location: `${r}行目`, before: rowSummary(rowsA.get(r)), after: "（行なし）", note: "" });
          }
          for (const idx of inserted) {
            const r = idx + 1;
            if (!rowsB.get(r)) continue;
            rows.push({ kind: "row-added", group: label, location: `${r}行目`, before: "（行なし）", after: rowSummary(rowsB.get(r)), note: "" });
          }
        }
      } else {
        alignFallback = true;
      }
    }
    if (!aligned) {
      for (let r = 1; r <= maxRow; r++) compared += compareRowPair(label, r, r, rowsA.get(r), rowsB.get(r), opts, rows);
    }
  }
  for (const sb of bookB.sheets) {
    if (!namesA.has(sb.name)) {
      rows.push({ kind: "sheet-added", group: sheetLabel(undefined, sb), location: "-", before: "なし", after: `あり（値のあるセル${sb.cells.size}個）`, note: "" });
    }
  }

  notes.push(
    opts.compareFormulas
      ? "数式と値の両方を比べました（数式のセルは「=数式（結果：計算結果）」と表示します）。"
      : "セルの値（数式のセルは、ファイルに保存されている計算結果）だけを比べました。数式の違いは見ていません。"
  );
  notes.push(
    opts.alignRows
      ? "行の追加・削除を見つけて、行がずれても内容で対応づけました（行がずれたセルは「B4 → B5」のように表示します）。列の追加・削除は、セルごとの変更として出ます。"
      : "同じ番地のセルどうしを比べました（行を追加・削除した場合は、それより下のセルがすべて違いとして出ます）。"
  );
  if (alignFallback) notes.push("違いが多すぎるシートは、行の対応づけをせず、同じ番地のセルどうしで比べました。");
  notes.push("数値の 1 と文字の「1」は、別の値として扱います（「値の種類が変更」）。日付は、Excelの日付の値で比べ、yyyy/mm/dd で表示します。空の文字だけのセルは、空欄として扱います。");
  notes.push("表示形式（桁区切り・小数の桁数・色など）や、罫線・塗りつぶしなどの書式の違いは比べません。値が同じで見た目だけが違うセルは、違いとして出ません。");
  const merges = bookA.sheets.some((s) => s.mergeCount > 0) || bookB.sheets.some((s) => s.mergeCount > 0);
  if (merges) notes.push("結合セルは、左上のセルの値で比べます（結合の範囲の違いは比べません）。");
  if (bookA.sheets.some((s) => s.hidden) || bookB.sheets.some((s) => s.hidden)) notes.push("非表示のシートも比べました（シート名に「（非表示）」と付けています）。");
  if (bookA.macro || bookB.macro) notes.push("マクロ有効ブック（.xlsm）は、セルの値と数式だけを読み取りました。マクロ（VBA）は比べていません。元のファイルは変更しません。");
  if (bookA.definedNameCount > 0 || bookB.definedNameCount > 0) notes.push("名前の定義・入力規則・条件付き書式・グラフ・図形・コメントは比べていません。");
  if (bookA.sheets.length > 0 && bookA.sheets.every((s) => !sheetsB.has(s.name)) && bookB.sheets.length > 0) {
    notes.push("同じ名前のシートが1つもありません。シート名を変えた場合は、削除と追加として出ます。");
  }
  return { target: "xlsx", rows, notes, comparedUnits: compared };
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

interface WordUnit {
  text: string;
  location: string;
  group: string;
}

function wordUnits(content: DocxContent): WordUnit[] {
  const units: WordUnit[] = [];
  let paragraphNo = 0;
  for (const block of content.blocks) {
    if (block.kind === "paragraph") {
      if (block.text.trim() === "") continue;
      paragraphNo++;
      const isHeading = block.headingLevel !== null;
      units.push({
        text: block.text,
        location: isHeading ? `第${paragraphNo}段落（見出し）` : `第${paragraphNo}段落`,
        group: isHeading ? "" : block.heading ? `見出し「${truncate(block.heading, 30)}」の下` : "",
      });
    } else {
      block.rows.forEach((row, ri) => {
        const text = row.join(" | ");
        if (row.every((c) => c.trim() === "")) return;
        units.push({ text, location: `表${block.tableIndex}・${ri + 1}行目`, group: block.heading ? `見出し「${truncate(block.heading, 30)}」の下` : "" });
      });
    }
  }
  return units;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function onlySpaceDiffers(a: string, b: string): boolean {
  return a.replace(/[\s　]+/g, "") === b.replace(/[\s　]+/g, "");
}

export function diffDocx(a: DocxContent, b: DocxContent): DiffResult {
  const unitsA = wordUnits(a);
  const unitsB = wordUnits(b);
  const rows: DiffRow[] = [];
  const notes: string[] = [];
  const ops = diffSequences(
    unitsA.map((u) => u.text),
    unitsB.map((u) => u.text),
    (x, y) => x === y,
    3000
  );
  // 違いが多すぎて対応づけられないときは、前から順に同じ番目どうしを比べる（その旨を表示する）
  const chunks = ops
    ? groupChunks(ops)
    : [{ type: "change" as const, deleted: unitsA.map((_, i) => i), inserted: unitsB.map((_, i) => i) }];
  if (!ops) notes.push("違いが多すぎるため、段落の対応づけをせず、前から順に同じ番目の段落どうしを比べました。");
  for (const chunk of chunks) {
    if (chunk.type === "equal") continue;
    const pairCount = Math.min(chunk.deleted.length, chunk.inserted.length);
    for (let i = 0; i < pairCount; i++) {
      const ua = unitsA[chunk.deleted[i]];
      const ub = unitsB[chunk.inserted[i]];
      if (ua.text === ub.text) continue;
      const location = ua.location === ub.location ? ua.location : `${ua.location} → ${ub.location}`;
      rows.push({
        kind: onlySpaceDiffers(ua.text, ub.text) ? "space-changed" : "text-changed",
        group: ub.group || ua.group,
        location,
        before: ua.text,
        after: ub.text,
        note: "",
      });
    }
    for (const idx of chunk.deleted.slice(pairCount)) {
      const u = unitsA[idx];
      rows.push({ kind: "text-removed", group: u.group, location: `${u.location}（比較元）`, before: u.text, after: "", note: "" });
    }
    for (const idx of chunk.inserted.slice(pairCount)) {
      const u = unitsB[idx];
      rows.push({ kind: "text-added", group: u.group, location: `${u.location}（比較先）`, before: "", after: u.text, note: "" });
    }
  }
  notes.push("本文の段落と、表の行（セルを「 | 」でつないだ文）を、文書の順に比べました。段落の番号は、空の段落を数えない番号です。");
  notes.push("文字は書き換えずにそのまま比べます。空白・改行だけが違う段落は「空白・改行だけが変更」として出します。");
  notes.push("太字・色・文字の大きさなどの書式の違いは比べません。");
  const limits: string[] = [];
  if (a.hasHeaderFooter || b.hasHeaderFooter) limits.push("ヘッダー・フッター");
  if (a.hasFootnotes || b.hasFootnotes) limits.push("脚注・文末脚注");
  if (a.hasComments || b.hasComments) limits.push("コメント");
  if (a.imageCount + b.imageCount > 0) limits.push("画像・図形（の中の文字）");
  if (limits.length > 0) notes.push(`${limits.join("・")}は比べていません。`);
  else notes.push("ヘッダー・フッター・脚注・コメント・画像の中の文字は比べません。");
  if (a.hasTrackedChanges || b.hasTrackedChanges) notes.push("変更履歴がある文書は、すべての変更を承認した後の文として読み取りました（削除の記録は含めません）。");
  return { target: "docx", rows, notes, comparedUnits: Math.max(unitsA.length, unitsB.length) };
}

export function countByKind(rows: DiffRow[]): Partial<Record<DiffKind, number>> {
  const out: Partial<Record<DiffKind, number>> = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

export type { DocxBlock };
