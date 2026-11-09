import { unzipSync, zipSync, type Zippable } from "fflate";
import { cellValueText, columnToLetters, readXlsxBook } from "@/lib/compare/office-reader";

/**
 * Excel（.xlsx）の列編集（工程3：CSV列編集のExcel対応）。
 *
 * read-excel-file / write-excel-file で読み直して書き出すと、ブック全体の書式・数式・ほかのシートまで作り直しになり、
 * 「対象外のシートやデータを維持する」ことができない。そのため、既存の Excel・Word の処理
 * （src/lib/word/docx-text-ops.ts・src/lib/compare/office-reader.ts）と同じく、既存の fflate（ZIP）と
 * ブラウザ標準の DOMParser / XMLSerializer だけで、選んだシートのXMLだけを書き換える（新しい依存は追加しない）。
 *
 * - 書き換えるのは、選んだシート（xl/worksheets/sheetN.xml）と、必要なときだけブックの名前の定義・計算の順番の情報。
 *   ほかのシート・書式（styles.xml）・共有文字列・画像などのファイルは、バイト列のまま保持する。
 * - セルの値（数値・日付・文字・真偽値）と書式（スタイル番号）は、そのままの形で新しい位置へ移す（文字への変換はしない）。
 * - 行・列の位置が変わるとき、選んだシートの数式は、計算結果の値に置き換える（参照先がずれて、違う値になるのを防ぐため）。
 *   位置が変わらない（列名の変更だけの）ときは、数式はそのまま残す。
 * - 列の幅・セルの結合・条件付き書式・入力規則・ハイパーリンク・オートフィルターなどの範囲は、新しい位置に合わせる
 *   （結合やオートフィルターが、削除・並び替えで1つの範囲にならないときは外し、その数を知らせる）。
 * - Excelの「テーブル」・メモ（コメント）があるシートで行・列の位置を変えることには対応しない（テーブルの定義・メモの位置を
 *   正しく直せないため。理由を表示して止める）。画像・グラフの位置は直さないため、その旨を知らせる。
 * 処理はすべてブラウザの中で行い、ファイルは送信しない。
 */

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface XlsxEditSheet {
  name: string;
  hidden: boolean;
  /** 表示用の値（文字）。1行目〜最後の行、A列〜最後の列。数式は計算結果の値、日付は yyyy/mm/dd */
  rows: string[][];
  formulaCount: number;
}

/** プレビュー・列の一覧用に、ブックの全シートの値を読む（元のファイルは変更しない） */
export async function loadXlsxForColumnEdit(file: File): Promise<XlsxEditSheet[]> {
  const book = await readXlsxBook(file, false);
  return book.sheets.map((sheet) => {
    const rows: string[][] = Array.from({ length: sheet.maxRow }, () => Array.from({ length: sheet.maxCol }, () => ""));
    let formulaCount = 0;
    for (const cell of sheet.cells.values()) {
      rows[cell.row - 1][cell.col - 1] = cellValueText(cell);
      if (cell.formula !== null) formulaCount++;
    }
    return { name: sheet.name, hidden: sheet.hidden, rows, formulaCount };
  });
}

export interface XlsxColumnEditInput {
  file: File;
  /** 編集するシートの番号（0始まり。loadXlsxForColumnEdit の並び） */
  sheetIndex: number;
  /** 残す列の元の番号（0始まり）を、出力したい順に並べたもの。含めなかった列は削除する */
  columnOrder: number[];
  /** 元の列の番号 → 新しい見出し名（見出しありのときだけ。見出しの行＝対象の範囲の最初の行） */
  renames?: Record<number, string>;
  hasHeader: boolean;
  /** 対象にする行の範囲（1始まり・両端を含む）。範囲外の行は出力に含めない。省略時はすべて */
  rowStart?: number;
  rowEnd?: number;
}

export interface XlsxColumnEditOutput {
  blob: Blob;
  rowCount: number;
  columnCount: number;
  /** 利用者に知らせること（数式を値にした数・外した結合の数など） */
  notices: string[];
}

// ---------------------------------------------------------------------------
// 番地・範囲の変換（DOMを使わない純粋な関数。テストしやすいように分けている）
// ---------------------------------------------------------------------------

interface CellPos {
  row: number; // 1始まり
  col: number; // 1始まり
}

export function letterToColumn(letters: string): number {
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

export function parseCellRef(ref: string): CellPos | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { col: letterToColumn(m[1]), row: Number(m[2]) };
}

export function toCellRef(pos: CellPos): string {
  return `${columnToLetters(pos.col)}${pos.row}`;
}

/** 行・列の対応（元の番号 → 新しい番号。削除するものは null） */
export interface AxisMaps {
  row: (r: number) => number | null;
  col: (c: number) => number | null;
}

/** 元の連続した番号 a..b を、新しい番号の「連続した区間」の並びにする（削除・並び替えで分かれる） */
export function mapRuns(a: number, b: number, map: (n: number) => number | null): [number, number][] {
  const mapped: number[] = [];
  for (let n = a; n <= b; n++) {
    const m = map(n);
    if (m !== null) mapped.push(m);
  }
  mapped.sort((x, y) => x - y);
  const runs: [number, number][] = [];
  for (const m of mapped) {
    const last = runs[runs.length - 1];
    if (last && m === last[1] + 1) last[1] = m;
    else if (!last || m !== last[1]) runs.push([m, m]);
  }
  return runs;
}

/** 範囲（"A1"・"A1:C3"）を、新しい位置の範囲の並びにする。読めない形の範囲は null（そのまま残す） */
export function remapRange(range: string, maps: AxisMaps): string[] | null {
  const parts = range.split(":");
  const a = parseCellRef(parts[0]);
  const b = parts.length === 2 ? parseCellRef(parts[1]) : a;
  if (!a || !b || parts.length > 2) return null;
  const rowRuns = mapRuns(Math.min(a.row, b.row), Math.max(a.row, b.row), maps.row);
  const colRuns = mapRuns(Math.min(a.col, b.col), Math.max(a.col, b.col), maps.col);
  const out: string[] = [];
  for (const [r1, r2] of rowRuns) {
    for (const [c1, c2] of colRuns) {
      const start = toCellRef({ row: r1, col: c1 });
      const end = toCellRef({ row: r2, col: c2 });
      out.push(start === end ? start : `${start}:${end}`);
    }
  }
  return out;
}

/** 空白区切りの範囲の並び（sqref）を変換する。すべて消えたら空文字 */
export function remapSqref(sqref: string, maps: AxisMaps): string {
  const out: string[] = [];
  for (const part of sqref.trim().split(/\s+/).filter(Boolean)) {
    const mapped = remapRange(part, maps);
    if (mapped === null) out.push(part);
    else out.push(...mapped);
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// XML の補助
// ---------------------------------------------------------------------------

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function parseXml(bytes: Uint8Array | undefined, what: string): Document {
  if (!bytes) throw new Error(`Excelファイルの中に${what}が見つかりませんでした（壊れているか、対応していない形式の可能性があります）`);
  const doc = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Excelファイルの${what}を読み取れませんでした（壊れているか、対応していない形式の可能性があります）`);
  }
  return doc;
}

function serialize(doc: Document, original: Uint8Array): Uint8Array {
  const text = new XMLSerializer().serializeToString(doc);
  const decl = /^<\?xml[^>]*\?>/.exec(decoder.decode(original.subarray(0, 200)))?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return encoder.encode(text.startsWith("<?xml") ? text : `${decl}\n${text}`);
}

function byLocal(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", local));
}

function childrenByLocal(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/");
  parts.pop();
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** シート名を、数式の中の書き方（'シート 1'! または Sheet1!）にする */
function sheetRefPatterns(name: string): string[] {
  const quoted = `'${name.replace(/'/g, "''")}'!`;
  // 空白や記号を含まない名前（日本語の名前を含む）は、引用符なしでも書ける
  return /^[^\s'!\[\]:*?/\\\-+,()&^=<>;{}%$#@"0-9][^\s'!\[\]:*?/\\\-+,()&^=<>;{}%$#@"]*$/u.test(name) ? [quoted, `${name}!`] : [quoted];
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export async function editXlsxColumns(input: XlsxColumnEditInput): Promise<XlsxColumnEditOutput> {
  const { file, sheetIndex, columnOrder, renames, hasHeader } = input;
  if (columnOrder.length === 0) throw new Error("残す列を1つ以上選択してください");
  const sheets = await loadXlsxForColumnEdit(file);
  const view = sheets[sheetIndex];
  if (!view) throw new Error("編集するシートが見つかりませんでした。ファイルを選び直してください。");
  const maxRow = view.rows.length;
  const maxCol = view.rows[0]?.length ?? 0;
  if (maxRow === 0 || maxCol === 0) throw new Error(`シート「${view.name}」には値の入ったセルがありません。`);
  if (new Set(columnOrder).size !== columnOrder.length || columnOrder.some((c) => !Number.isInteger(c) || c < 0 || c >= maxCol)) {
    throw new Error("列の指定が正しくありません。ファイルを選び直してください。");
  }
  const rowStart = input.rowStart ?? 1;
  const rowEnd = Math.min(input.rowEnd ?? maxRow, maxRow);
  if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd) || rowStart < 1 || rowStart > rowEnd) {
    throw new Error(`対象にする行の範囲が正しくありません（1〜${maxRow}行目の間で、開始行が終了行以下になるように指定してください）`);
  }
  const rowsLimited = rowStart !== 1 || rowEnd !== maxRow;

  // 列の対応：残す列は選んだ順に1列目から。値の範囲より右の列（書式だけの列）は、削除した列の数だけ左へ詰める
  const newColOf = new Map<number, number>();
  columnOrder.forEach((c, i) => newColOf.set(c + 1, i + 1));
  const keptCount = columnOrder.length;
  const colMap = (c: number): number | null => (c <= maxCol ? (newColOf.get(c) ?? null) : keptCount + (c - maxCol));
  // 行の対応：範囲を指定したときは、範囲の最初の行が1行目になる（範囲外の行は削除）。指定しないときはそのまま
  const rowMap = (r: number): number | null => (!rowsLimited ? r : r >= rowStart && r <= rowEnd ? r - rowStart + 1 : null);
  const maps: AxisMaps = { row: rowMap, col: colMap };
  const columnsChanged = keptCount !== maxCol || columnOrder.some((c, i) => c !== i);
  const positionsChanged = columnsChanged || rowsLimited;
  const headerRenames = hasHeader
    ? Object.entries(renames ?? {})
        .map(([k, v]) => [Number(k), v.trim()] as const)
        .filter(([c, v]) => v !== "" && newColOf.has(c + 1))
    : [];

  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error(`${file.name} を読み込めませんでした。Excelファイル(.xlsx)が破損している可能性があります。`);
  }

  const workbookBytes = zip["xl/workbook.xml"];
  const workbook = parseXml(workbookBytes, "ブックの情報");
  const wbRelsBytes = zip["xl/_rels/workbook.xml.rels"];
  const wbRels = parseXml(wbRelsBytes, "ブックの関連情報");
  const relTarget = new Map<string, string>();
  for (const r of byLocal(wbRels, "Relationship")) relTarget.set(r.getAttribute("Id") ?? "", resolveTarget("xl/workbook.xml", r.getAttribute("Target") ?? ""));
  const sheetEls = byLocal(workbook, "sheet");
  const sheetEl = sheetEls[sheetIndex];
  const sheetPath = sheetEl ? relTarget.get(sheetEl.getAttributeNS(REL_NS, "id") ?? sheetEl.getAttribute("r:id") ?? "") : undefined;
  if (!sheetEl || !sheetPath || !zip[sheetPath]) throw new Error("編集するシートのデータが見つかりませんでした。");
  const sheetBytes = zip[sheetPath];
  const sheet = parseXml(sheetBytes, "シートのデータ");
  const notices: string[] = [];

  // 正しく直せない要素があるシートは、位置を変える前に止める
  if (byLocal(sheet, "tablePart").length > 0) {
    throw new Error(
      `シート「${view.name}」にはExcelの「テーブル」があるため、列の編集には対応していません。Excelで「範囲に変換」してから選ぶか、ほかのシートを選んでください。`
    );
  }
  if (positionsChanged && byLocal(sheet, "legacyDrawing").length > 0) {
    throw new Error(
      `シート「${view.name}」にはメモ（コメント）があるため、列の削除・並び替えや行の範囲の指定には対応していません（メモの位置を正しく直せないため）。メモを削除してから選ぶか、列名の変更だけにしてください。`
    );
  }
  if (positionsChanged && byLocal(sheet, "drawing").length > 0) {
    notices.push("このシートの画像・グラフの位置や、グラフが参照する範囲は変更していません。必要に応じてExcelで確認してください。");
  }

  const sheetData = byLocal(sheet, "sheetData")[0];
  if (!sheetData) throw new Error("シートのデータが見つかりませんでした。");

  // 1) セル：新しい位置へ移す（値・書式はそのまま）。削除する行・列のセルは取り除く
  let convertedFormulas = 0;
  let formulasWithoutValue = 0;
  let implicitRow = 0;
  for (const rowEl of childrenByLocal(sheetData, "row")) {
    const r = Number(rowEl.getAttribute("r") ?? implicitRow + 1);
    implicitRow = r;
    const newR = rowMap(r);
    if (newR === null) {
      sheetData.removeChild(rowEl);
      continue;
    }
    rowEl.setAttribute("r", String(newR));
    rowEl.removeAttribute("spans");
    const cells: { el: Element; col: number }[] = [];
    let implicitCol = 0;
    for (const c of childrenByLocal(rowEl, "c")) {
      const pos = parseCellRef(c.getAttribute("r") ?? "");
      const col = pos ? pos.col : implicitCol + 1;
      implicitCol = col;
      const newC = colMap(col);
      rowEl.removeChild(c);
      if (newC === null) continue;
      c.setAttribute("r", toCellRef({ row: newR, col: newC }));
      if (positionsChanged) {
        const f = childrenByLocal(c, "f")[0];
        if (f) {
          c.removeChild(f);
          convertedFormulas++;
          const v = childrenByLocal(c, "v")[0];
          if (!v || (v.textContent ?? "") === "") {
            // 計算結果が保存されていない数式は、空欄にする（空の値の要素は残さない）
            formulasWithoutValue++;
            if (v) c.removeChild(v);
            c.removeAttribute("t");
          } else if (c.getAttribute("t") === "str") {
            // 数式の結果の文字は、数式なしのセルでは「文字」として持つ
            const text = v.textContent ?? "";
            c.removeChild(v);
            c.setAttribute("t", "inlineStr");
            const is = sheet.createElementNS(MAIN_NS, "is");
            const t = sheet.createElementNS(MAIN_NS, "t");
            t.setAttributeNS(XML_NS, "xml:space", "preserve");
            t.textContent = text;
            is.appendChild(t);
            c.appendChild(is);
          }
        }
      }
      cells.push({ el: c, col: newC });
    }
    cells.sort((a, b) => a.col - b.col);
    for (const { el } of cells) rowEl.appendChild(el);
  }
  // 行も新しい番号の順に並べ直す（並びは変わらないが、念のため）
  const rowEls = childrenByLocal(sheetData, "row").sort((a, b) => Number(a.getAttribute("r")) - Number(b.getAttribute("r")));
  for (const el of rowEls) sheetData.appendChild(el);

  // 2) 見出しの名前の変更（見出しの行＝対象の範囲の最初の行。出力では1行目になる）
  if (headerRenames.length > 0) {
    const headerRowNumber = 1;
    let headerRow = childrenByLocal(sheetData, "row").find((el) => Number(el.getAttribute("r")) === headerRowNumber);
    if (!headerRow) {
      headerRow = sheet.createElementNS(MAIN_NS, "row");
      headerRow.setAttribute("r", String(headerRowNumber));
      sheetData.insertBefore(headerRow, sheetData.firstChild);
    }
    for (const [oldColIndex, name] of headerRenames) {
      const newCol = newColOf.get(oldColIndex + 1)!;
      const ref = toCellRef({ row: headerRowNumber, col: newCol });
      let cell = childrenByLocal(headerRow, "c").find((c) => c.getAttribute("r") === ref);
      if (!cell) {
        cell = sheet.createElementNS(MAIN_NS, "c");
        cell.setAttribute("r", ref);
        const after = childrenByLocal(headerRow, "c").find((c) => (parseCellRef(c.getAttribute("r") ?? "")?.col ?? 0) > newCol);
        headerRow.insertBefore(cell, after ?? null);
      }
      for (const child of Array.from(cell.children)) cell.removeChild(child);
      cell.setAttribute("t", "inlineStr");
      const is = sheet.createElementNS(MAIN_NS, "is");
      const t = sheet.createElementNS(MAIN_NS, "t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.textContent = name;
      is.appendChild(t);
      cell.appendChild(is);
    }
  }

  if (positionsChanged) {
    // 3) 列の幅・書式（<cols>）を新しい列に合わせる
    const colsEl = byLocal(sheet, "cols")[0];
    if (colsEl && columnsChanged) {
      const defs = childrenByLocal(colsEl, "col").map((el) => ({ el, min: Number(el.getAttribute("min")), max: Number(el.getAttribute("max")) }));
      const defOf = (c: number) => defs.find((d) => c >= d.min && c <= d.max);
      const created: Element[] = [];
      for (let oldCol = 1; oldCol <= maxCol; oldCol++) {
        const newCol = colMap(oldCol);
        const def = defOf(oldCol);
        if (newCol === null || !def) continue;
        const el = def.el.cloneNode(true) as Element;
        el.setAttribute("min", String(newCol));
        el.setAttribute("max", String(newCol));
        created.push(el);
      }
      // 値の範囲より右の列の設定は、削除した列の数だけ左へ詰める
      for (const d of defs) {
        if (d.max <= maxCol) continue;
        const el = d.el.cloneNode(true) as Element;
        el.setAttribute("min", String(colMap(Math.max(d.min, maxCol + 1))));
        el.setAttribute("max", String(Math.min(16384, colMap(d.max) ?? d.max)));
        created.push(el);
      }
      for (const d of defs) colsEl.removeChild(d.el);
      created.sort((a, b) => Number(a.getAttribute("min")) - Number(b.getAttribute("min")));
      for (const el of created) colsEl.appendChild(el);
      if (created.length === 0) colsEl.parentNode?.removeChild(colsEl);
    }

    // 4) 範囲を持つ要素を新しい位置に合わせる
    let droppedMerges = 0;
    for (const mc of byLocal(sheet, "mergeCell")) {
      const mapped = remapRange(mc.getAttribute("ref") ?? "", maps);
      if (mapped && mapped.length === 1 && mapped[0].includes(":")) mc.setAttribute("ref", mapped[0]);
      else if (mapped !== null) {
        mc.parentNode?.removeChild(mc);
        droppedMerges++;
      }
    }
    const mergeCells = byLocal(sheet, "mergeCells")[0];
    if (mergeCells) {
      const n = childrenByLocal(mergeCells, "mergeCell").length;
      if (n === 0) mergeCells.parentNode?.removeChild(mergeCells);
      else mergeCells.setAttribute("count", String(n));
    }
    if (droppedMerges > 0) notices.push(`削除・並び替えで1つの範囲にならないセルの結合を${droppedMerges}か所外しました。`);

    for (const af of byLocal(sheet, "autoFilter")) {
      const mapped = remapRange(af.getAttribute("ref") ?? "", maps);
      if (mapped && mapped.length === 1) af.setAttribute("ref", mapped[0]);
      else if (mapped !== null) {
        af.parentNode?.removeChild(af);
        notices.push("オートフィルターの範囲が1つにまとまらないため、オートフィルターを外しました。");
      }
    }
    for (const local of ["conditionalFormatting", "dataValidation", "protectedRange", "ignoredError"]) {
      for (const el of byLocal(sheet, local)) {
        const sq = el.getAttribute("sqref");
        if (sq === null) continue;
        const mapped = remapSqref(sq, maps);
        if (mapped === "") el.parentNode?.removeChild(el);
        else el.setAttribute("sqref", mapped);
      }
    }
    for (const local of ["dataValidations", "ignoredErrors", "protectedRanges"]) {
      for (const el of byLocal(sheet, local)) {
        if (el.children.length === 0) el.parentNode?.removeChild(el);
        else if (el.hasAttribute("count")) el.setAttribute("count", String(el.children.length));
      }
    }
    for (const h of byLocal(sheet, "hyperlink")) {
      const mapped = remapRange(h.getAttribute("ref") ?? "", maps);
      if (mapped && mapped.length > 0) h.setAttribute("ref", mapped[0]);
      else if (mapped !== null) h.parentNode?.removeChild(h);
    }
    const hyperlinks = byLocal(sheet, "hyperlinks")[0];
    if (hyperlinks && hyperlinks.children.length === 0) hyperlinks.parentNode?.removeChild(hyperlinks);
    // 選択中のセル・表示の位置は、A1に戻す（消えた位置を指したままにしない）
    for (const sel of byLocal(sheet, "selection")) {
      sel.setAttribute("activeCell", "A1");
      sel.setAttribute("sqref", "A1");
    }
    for (const pane of byLocal(sheet, "pane")) {
      const tl = pane.getAttribute("topLeftCell");
      if (tl) {
        const mapped = remapRange(tl, maps);
        if (mapped && mapped.length === 1) pane.setAttribute("topLeftCell", mapped[0]);
      }
    }
    for (const local of ["rowBreaks", "colBreaks"]) {
      for (const el of byLocal(sheet, local)) el.parentNode?.removeChild(el);
    }
  }

  // 5) 使っている範囲（dimension）を新しい大きさにする
  const outRows = rowsLimited ? rowEnd - rowStart + 1 : maxRow;
  const dim = byLocal(sheet, "dimension")[0];
  if (dim) dim.setAttribute("ref", `A1:${toCellRef({ row: outRows, col: keptCount })}`);

  const out: Record<string, Uint8Array> = { ...zip, [sheetPath]: serialize(sheet, sheetBytes) };

  if (positionsChanged) {
    if (convertedFormulas > 0) {
      notices.push(
        `行・列の位置が変わるため、このシートの数式${convertedFormulas}個を、計算結果の値に置き換えました（参照先がずれて違う値になるのを防ぐため）。` +
          (formulasWithoutValue > 0 ? `そのうち${formulasWithoutValue}個は、計算結果がファイルに保存されていなかったため空欄になりました。` : "")
      );
      // 計算の順番の情報（calcChain）は、数式の場所を指しているため取り除く（Excelが開くときに作り直す）
      if (out["xl/calcChain.xml"]) {
        delete out["xl/calcChain.xml"];
        for (const r of byLocal(wbRels, "Relationship")) {
          if ((r.getAttribute("Target") ?? "").endsWith("calcChain.xml")) r.parentNode?.removeChild(r);
        }
        out["xl/_rels/workbook.xml.rels"] = serialize(wbRels, wbRelsBytes);
        const ctBytes = zip["[Content_Types].xml"];
        if (ctBytes) {
          const ct = parseXml(ctBytes, "ファイルの種類の情報");
          for (const o of byLocal(ct, "Override")) {
            if ((o.getAttribute("PartName") ?? "").endsWith("/calcChain.xml")) o.parentNode?.removeChild(o);
          }
          out["[Content_Types].xml"] = serialize(ct, ctBytes);
        }
      }
    }

    // ほかのシートの数式・名前の定義が、このシートを参照していないか
    const patterns = sheetRefPatterns(view.name);
    let externalRefs = 0;
    sheetEls.forEach((el, i) => {
      if (i === sheetIndex) return;
      const path = relTarget.get(el.getAttributeNS(REL_NS, "id") ?? el.getAttribute("r:id") ?? "");
      const bytes = path ? zip[path] : undefined;
      if (!bytes) return;
      // 数式の中の文字は、文字参照（&#21517; など）で書かれていることがあるため、XMLとして読んでから調べる
      for (const f of byLocal(parseXml(bytes, "シートのデータ"), "f")) {
        if (patterns.some((p) => (f.textContent ?? "").includes(p))) externalRefs++;
      }
    });
    let changedNames = 0;
    let referencingNames = 0;
    for (const dn of byLocal(workbook, "definedName")) {
      const text = dn.textContent ?? "";
      if (!patterns.some((p) => text.includes(p))) continue;
      // 「'シート'!$A$1:$D$10」のような、このシートの範囲だけの名前は、新しい位置に合わせる。それ以外は知らせるだけ
      const m = /^('(?:[^']|'')+'|[^\s'!:]+)!(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)$/.exec(text.trim());
      const mapped = m ? remapRange(m[2].replace(/\$/g, ""), maps) : null;
      if (m && mapped && mapped.length === 1) {
        const abs = mapped[0].split(":").map((ref) => ref.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2")).join(":");
        dn.textContent = `${m[1]}!${abs}`;
        changedNames++;
      } else {
        referencingNames++;
      }
    }
    if (changedNames > 0) out["xl/workbook.xml"] = serialize(workbook, workbookBytes);
    if (externalRefs > 0 || referencingNames > 0) {
      notices.push(
        `ほかのシートの数式${externalRefs > 0 ? `${externalRefs}個` : ""}${externalRefs > 0 && referencingNames > 0 ? "や" : ""}${
          referencingNames > 0 ? `名前の定義${referencingNames}個` : ""
        }が、このシートのセルを参照しています。行・列の位置が変わったため、正しい値にならない場合があります。Excelで確認してください。`
      );
    }
  }

  const zipped = zipSync(out as Zippable, { level: 6 });
  return {
    blob: new Blob([new Uint8Array(zipped)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    rowCount: outRows,
    columnCount: keptCount,
    notices,
  };
}
