import { unzipSync, zipSync, type Zippable } from "fflate";
import { cellValueText, columnToLetters, readXlsxBook } from "@/lib/compare/office-reader";
import {
  adjustFormula,
  byLocal,
  childrenByLocal,
  MAIN_NS,
  parseCellRef,
  parseXml,
  processSheetFormulas,
  REL_NS,
  resolveTarget,
  serialize,
  sheetRefPatterns,
  toCellRef,
  type AxisMaps,
  type RefBox,
} from "@/lib/excel/xlsx-column-edit";

/**
 * Excel（.xlsx）の「左に詰める」「上に詰める」（新工程1：Excel空白行・空白列削除に追加）。
 *
 * 選んだ範囲の中だけで、空白のセルを詰める（Excelの「セルを削除して左方向／上方向にシフト」を、範囲の中に限って行う）。
 * - 左に詰める：範囲の中の各行で、値のあるセルを左へ寄せる（並びは変えない）。空白のセルは、その行の範囲の右端へ移る。
 * - 上に詰める：範囲の中の各列で、値のあるセルを上へ寄せる。空白のセルは、その列の範囲の下端へ移る。
 * - 範囲の外のセルは動かさない（値・書式・数式・幅などはそのまま）。
 * - セルは、値・型（数値・日付・文字・真偽値）・書式（スタイル番号）・数式を持ったまま移す（文字への変換はしない）。
 * - 結合したセルが範囲にかかる行（上に詰めるときは列）は、詰めずにそのまま残し、理由を知らせる。
 * - 数式の参照は、参照先のセルが移った先に合わせて書き直す（列編集と同じ adjustFormula を使う）。
 *   参照する範囲の一部だけが動くなど、安全に直せない数式だけを計算結果の値に置き換え、その数を知らせる。
 * - Excelの「テーブル」・メモ（コメント）があるシートは、位置を正しく直せないため、理由を表示して止める。
 * 処理はすべてブラウザの中で行い、ファイルは送信しない。
 *
 * 「空白」の決め方：値も数式もないセル（書式だけのセル・空の文字も空白）。プレビューと出力で同じ決め方（readXlsxBook）を使う。
 */

export type ShiftDirection = "left" | "up";

/** 範囲（1始まり・両端を含む） */
export interface ShiftRange {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

interface Box {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

export interface XlsxShiftSheet {
  name: string;
  /** 値のあるセル（番地 → 表示用の文字） */
  texts: Map<string, string>;
  maxRow: number;
  maxCol: number;
  merges: Box[];
}

/** 範囲を「B2:E10」の形にする */
export function rangeLabel(range: ShiftRange): string {
  const a = toCellRef({ row: range.r1, col: range.c1 });
  const b = toCellRef({ row: range.r2, col: range.c2 });
  return a === b ? a : `${a}:${b}`;
}

export function directionLabel(direction: ShiftDirection): string {
  return direction === "left" ? "左に詰める" : "上に詰める";
}

/** 範囲の値が正しいか（正しくなければ、日本語の理由） */
export function validateShiftRange(range: ShiftRange): string | null {
  const { r1, r2, c1, c2 } = range;
  if (![r1, r2, c1, c2].every((n) => Number.isInteger(n) && n >= 1)) return "範囲の行・列は1以上の整数で指定してください。";
  if (r1 > r2 || c1 > c2) return "範囲の開始行・開始列は、終了行・終了列以下にしてください。";
  if (r2 > 1_048_576 || c2 > 16_384) return "範囲がExcelのシートの大きさを超えています。";
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200_000) return "範囲が広すぎます（20万セルまで）。範囲を狭めてください。";
  return null;
}

// ---------------------------------------------------------------------------
// 詰め方の計算（純粋な関数。プレビューと出力で共通に使う）
// ---------------------------------------------------------------------------

export interface ShiftPlan {
  range: ShiftRange;
  direction: ShiftDirection;
  /** 結合セルがかかるため詰めなかった行（左）・列（上）の番号 */
  skippedLines: number[];
  /** 位置が変わる、値のあるセルの数 */
  movedCells: number;
  /** 元の番地 → 新しい番地（位置が変わるセルだけ。空白のセル＝書式だけのセルも含む） */
  moves: Map<string, { row: number; col: number }>;
}

const key = (row: number, col: number) => `${row},${col}`;

export function planShift(
  isFilled: (row: number, col: number) => boolean,
  merges: Box[],
  range: ShiftRange,
  direction: ShiftDirection,
): ShiftPlan {
  const { r1, r2, c1, c2 } = range;
  const left = direction === "left";
  // 結合セルがかかる行（左に詰める）・列（上に詰める）は詰めない
  const skipped = new Set<number>();
  for (const m of merges) {
    if (m.r2 < r1 || m.r1 > r2 || m.c2 < c1 || m.c1 > c2) continue;
    const [a, b] = left ? [Math.max(m.r1, r1), Math.min(m.r2, r2)] : [Math.max(m.c1, c1), Math.min(m.c2, c2)];
    for (let n = a; n <= b; n++) skipped.add(n);
  }
  const moves = new Map<string, { row: number; col: number }>();
  let movedCells = 0;
  const [lineFrom, lineTo, posFrom, posTo] = left ? [r1, r2, c1, c2] : [c1, c2, r1, r2];
  for (let line = lineFrom; line <= lineTo; line++) {
    if (skipped.has(line)) continue;
    const filled: number[] = [];
    const blank: number[] = [];
    for (let pos = posFrom; pos <= posTo; pos++) {
      const [row, col] = left ? [line, pos] : [pos, line];
      (isFilled(row, col) ? filled : blank).push(pos);
    }
    [...filled, ...blank].forEach((oldPos, i) => {
      const newPos = posFrom + i;
      if (newPos === oldPos) return;
      const [row, col] = left ? [line, oldPos] : [oldPos, line];
      moves.set(key(row, col), left ? { row: line, col: newPos } : { row: newPos, col: line });
      if (isFilled(row, col)) movedCells++;
    });
  }
  return { range, direction, skippedLines: [...skipped].sort((a, b) => a - b), movedCells, moves };
}

/** セルの新しい位置（動かないセルは元の位置） */
export function shiftedPosition(plan: ShiftPlan, row: number, col: number): { row: number; col: number } {
  return plan.moves.get(key(row, col)) ?? { row, col };
}

/**
 * 数式の参照（範囲）を、詰めたあとの位置に合わせるときのずれ。直せないときは null。
 * - 範囲にかからない参照・中のセルが動かない参照：そのまま
 * - 参照するセル（範囲）が、すべて同じだけずれる（並びも変わらない）：そのずれの分だけ動かす
 * - 参照する範囲の中だけで並びが変わる（範囲の行・列をまるごと含む）：そのまま（中の値の集まりは変わらない）
 * - それ以外（参照の一部だけが動く・外から入ってくる）：null（計算結果の値に置き換える）
 */
export function remapRefForShift(plan: ShiftPlan, box: RefBox): { rows: number; cols: number } | null {
  const R = plan.range;
  const br1 = box.r1 ?? 1;
  const br2 = box.r2 ?? 1_048_576;
  const bc1 = box.c1 ?? 1;
  const bc2 = box.c2 ?? 16_384;
  const ir1 = Math.max(br1, R.r1);
  const ir2 = Math.min(br2, R.r2);
  const ic1 = Math.max(bc1, R.c1);
  const ic2 = Math.min(bc2, R.c2);
  if (ir1 > ir2 || ic1 > ic2) return { rows: 0, cols: 0 };
  let dr: number | null = null;
  let dc: number | null = null;
  let allSame = true;
  let anyMove = false;
  let staysInside = true;
  for (let r = ir1; r <= ir2; r++) {
    for (let c = ic1; c <= ic2; c++) {
      const to = shiftedPosition(plan, r, c);
      const d = [to.row - r, to.col - c];
      if (d[0] !== 0 || d[1] !== 0) anyMove = true;
      if (dr === null) [dr, dc] = d;
      else if (d[0] !== dr || d[1] !== dc) allSame = false;
      if (to.row < br1 || to.row > br2 || to.col < bc1 || to.col > bc2) staysInside = false;
    }
  }
  if (!anyMove) return { rows: 0, cols: 0 };
  const boxInsideRange = br1 >= R.r1 && br2 <= R.r2 && bc1 >= R.c1 && bc2 <= R.c2 && box.r1 !== null && box.c1 !== null;
  if (allSame && boxInsideRange) return { rows: dr!, cols: dc! };
  // 範囲の中だけで並びが変わる：参照の中から出るセルが無く、外から入ってくるセルも無い
  if (staysInside) {
    for (const [from, to] of plan.moves) {
      const [r, c] = from.split(",").map(Number);
      const fromIn = r >= br1 && r <= br2 && c >= bc1 && c <= bc2;
      const toIn = to.row >= br1 && to.row <= br2 && to.col >= bc1 && to.col <= bc2;
      if (fromIn !== toIn) return null;
    }
    return { rows: 0, cols: 0 };
  }
  return null;
}

/** プレビュー用：詰めたあとの値（表示用の文字）の表。範囲の外はそのまま */
export function shiftedTexts(sheet: XlsxShiftSheet, plan: ShiftPlan): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ref, text] of sheet.texts) {
    const pos = parseCellRef(ref);
    if (!pos) continue;
    const to = shiftedPosition(plan, pos.row, pos.col);
    out.set(toCellRef(to), text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 読み込み（プレビュー・出力で共通）
// ---------------------------------------------------------------------------

function parseBox(ref: string): Box | null {
  const parts = ref.split(":");
  const a = parseCellRef(parts[0] ?? "");
  const b = parts[1] ? parseCellRef(parts[1]) : a;
  if (!a || !b) return null;
  return { r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row), c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) };
}

interface SheetLocation {
  name: string;
  path: string;
}

function sheetLocations(zip: Record<string, Uint8Array>): { workbook: Document; wbRels: Document; sheets: SheetLocation[] } {
  const workbook = parseXml(zip["xl/workbook.xml"], "ブックの情報");
  const wbRels = parseXml(zip["xl/_rels/workbook.xml.rels"], "ブックの関連情報");
  const relTarget = new Map<string, string>();
  for (const r of byLocal(wbRels, "Relationship")) relTarget.set(r.getAttribute("Id") ?? "", resolveTarget("xl/workbook.xml", r.getAttribute("Target") ?? ""));
  const sheets = byLocal(workbook, "sheet").map((el, i) => ({
    name: el.getAttribute("name") ?? `Sheet${i + 1}`,
    path: relTarget.get(el.getAttributeNS(REL_NS, "id") ?? el.getAttribute("r:id") ?? "") ?? "",
  }));
  return { workbook, wbRels, sheets };
}

function unzipFile(bytes: Uint8Array, name: string): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error(`${name} を読み込めませんでした。Excelファイル(.xlsx)が破損している可能性があります。`);
  }
}

/** 全シートの値と結合セルを読む（元のファイルは変更しない） */
export async function loadXlsxForShift(file: File): Promise<XlsxShiftSheet[]> {
  const book = await readXlsxBook(file, false);
  const zip = unzipFile(new Uint8Array(await file.arrayBuffer()), file.name);
  const { sheets: locs } = sheetLocations(zip);
  return book.sheets.map((sheet, i) => {
    const texts = new Map<string, string>();
    for (const cell of sheet.cells.values()) texts.set(cell.ref, cellValueText(cell) || (cell.formula !== null ? `=${cell.formula}` : ""));
    let merges: Box[] = [];
    const path = locs[i]?.path;
    if (path && zip[path] && sheet.mergeCount > 0) {
      const xml = parseXml(zip[path], "シートのデータ");
      merges = byLocal(xml, "mergeCell")
        .map((m) => parseBox(m.getAttribute("ref") ?? ""))
        .filter((b): b is Box => b !== null);
    }
    return { name: sheet.name, texts, maxRow: sheet.maxRow, maxCol: sheet.maxCol, merges };
  });
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

export interface XlsxShiftInput {
  file: File;
  sheetIndex: number;
  range: ShiftRange;
  direction: ShiftDirection;
}

export interface XlsxShiftOutput {
  blob: Blob;
  sheetName: string;
  movedCells: number;
  skippedLines: number[];
  /** 数式のまま残した数・値に置き換えた数（このシートとほかのシート） */
  formulasKept: number;
  formulasConverted: number;
  otherAdjusted: number;
  otherConverted: number;
  notices: string[];
}

export async function shiftXlsxCells(input: XlsxShiftInput): Promise<XlsxShiftOutput> {
  const { file, sheetIndex, range, direction } = input;
  const rangeError = validateShiftRange(range);
  if (rangeError) throw new Error(rangeError);
  const views = await loadXlsxForShift(file);
  const view = views[sheetIndex];
  if (!view) throw new Error("対象のシートが見つかりませんでした。ファイルを選び直してください。");
  const plan = planShift((r, c) => view.texts.has(toCellRef({ row: r, col: c })), view.merges, range, direction);

  const zip = unzipFile(new Uint8Array(await file.arrayBuffer()), file.name);
  const { workbook, wbRels, sheets: locs } = sheetLocations(zip);
  const sheetPath = locs[sheetIndex]?.path;
  if (!sheetPath || !zip[sheetPath]) throw new Error("対象のシートのデータが見つかりませんでした。");
  const sheetBytes = zip[sheetPath];
  const sheet = parseXml(sheetBytes, "シートのデータ");
  const notices: string[] = [];
  const label = directionLabel(direction);

  if (byLocal(sheet, "tablePart").length > 0) {
    throw new Error(`シート「${view.name}」にはExcelの「テーブル」があるため、「${label}」には対応していません。Excelで「範囲に変換」してから選ぶか、ほかのシートを選んでください。`);
  }
  if (plan.moves.size > 0 && byLocal(sheet, "legacyDrawing").length > 0) {
    throw new Error(`シート「${view.name}」にはメモ（コメント）があるため、「${label}」には対応していません（メモの位置を正しく直せないため）。メモを削除してから選んでください。`);
  }
  if (plan.skippedLines.length > 0) {
    const what = direction === "left" ? "行" : "列";
    const names = plan.skippedLines.map((n) => (direction === "left" ? `${n}` : columnToLetters(n)));
    notices.push(
      `結合したセルがかかる${what}（${names.slice(0, 10).join("、")}${names.length > 10 ? "…" : ""}${what === "行" ? "行目" : "列"}）は、詰めずにそのまま残しました（結合の形が崩れるため）。`,
    );
  }

  const empty: XlsxShiftOutput = {
    blob: file,
    sheetName: view.name,
    movedCells: 0,
    skippedLines: plan.skippedLines,
    formulasKept: 0,
    formulasConverted: 0,
    otherAdjusted: 0,
    otherConverted: 0,
    notices,
  };
  if (plan.moves.size === 0) {
    return { ...empty, blob: new Blob([new Uint8Array(await file.arrayBuffer())], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) };
  }
  if (byLocal(sheet, "drawing").length > 0) notices.push("このシートの画像・グラフの位置は変更していません。必要に応じてExcelで確認してください。");

  const sheetData = byLocal(sheet, "sheetData")[0];
  if (!sheetData) throw new Error("シートのデータが見つかりませんでした。");
  const cache = new Map<string, { rows: number; cols: number } | null>();
  const remapRef = (box: RefBox) => {
    const k = `${box.r1}:${box.r2}:${box.c1}:${box.c2}`;
    if (!cache.has(k)) cache.set(k, remapRefForShift(plan, box));
    return cache.get(k)!;
  };
  const identity: AxisMaps = { row: (r) => r, col: (c) => c };

  // 0) 数式：セルを動かす前に、参照を新しい位置に合わせる（直せないものだけ値に置き換える）
  const edited = processSheetFormulas(sheet, identity, view.name, true, remapRef);

  // 1) セルを新しい位置へ移す（値・型・書式・数式はそのまま）
  const rowEls = new Map<number, Element>();
  let implicitRow = 0;
  for (const rowEl of childrenByLocal(sheetData, "row")) {
    const r = Number(rowEl.getAttribute("r") ?? implicitRow + 1);
    implicitRow = r;
    rowEl.setAttribute("r", String(r));
    rowEls.set(r, rowEl);
  }
  const moving: { el: Element; row: number; col: number }[] = [];
  for (const [r, rowEl] of rowEls) {
    let implicitCol = 0;
    for (const c of childrenByLocal(rowEl, "c")) {
      const pos = parseCellRef(c.getAttribute("r") ?? "");
      const col = pos ? pos.col : implicitCol + 1;
      implicitCol = col;
      const to = plan.moves.get(key(r, col));
      if (!to) continue;
      rowEl.removeChild(c);
      moving.push({ el: c, row: to.row, col: to.col });
    }
  }
  const ensureRow = (r: number): Element => {
    let el = rowEls.get(r);
    if (!el) {
      el = sheet.createElementNS(MAIN_NS, "row");
      el.setAttribute("r", String(r));
      rowEls.set(r, el);
      sheetData.appendChild(el);
    }
    return el;
  };
  for (const m of moving) {
    m.el.setAttribute("r", toCellRef({ row: m.row, col: m.col }));
    ensureRow(m.row).appendChild(m.el);
  }
  // 行の中のセル・行の並びを番号の順にする
  for (const rowEl of rowEls.values()) {
    rowEl.removeAttribute("spans");
    const cells = childrenByLocal(rowEl, "c").sort((a, b) => (parseCellRef(a.getAttribute("r") ?? "")?.col ?? 0) - (parseCellRef(b.getAttribute("r") ?? "")?.col ?? 0));
    for (const c of cells) rowEl.appendChild(c);
  }
  for (const el of [...rowEls.entries()].sort((a, b) => a[0] - b[0]).map(([, el]) => el)) sheetData.appendChild(el);

  // 2) セルに付く情報（ハイパーリンク）は、セルと一緒に移す。範囲で持つ書式（条件付き書式・入力規則）は、位置に付くため変えない
  for (const h of byLocal(sheet, "hyperlink")) {
    const pos = parseCellRef(h.getAttribute("ref") ?? "");
    if (pos) h.setAttribute("ref", toCellRef(shiftedPosition(plan, pos.row, pos.col)));
  }
  const R = range;
  const touches = (sq: string) =>
    sq
      .trim()
      .split(/\s+/)
      .map(parseBox)
      .some((b) => b !== null && !(b.r2 < R.r1 || b.r1 > R.r2 || b.c2 < R.c1 || b.c1 > R.c2));
  if (["conditionalFormatting", "dataValidation"].some((local) => byLocal(sheet, local).some((el) => touches(el.getAttribute("sqref") ?? "")))) {
    notices.push("範囲にかかる条件付き書式・入力規則は、セルの位置に付くため、範囲を変えていません（詰めたあとの位置で働きます）。");
  }
  for (const sel of byLocal(sheet, "selection")) {
    sel.setAttribute("activeCell", toCellRef({ row: R.r1, col: R.c1 }));
    sel.setAttribute("sqref", rangeLabel(R));
  }

  const out: Record<string, Uint8Array> = { ...zip, [sheetPath]: serialize(sheet, sheetBytes) };

  // 3) 計算の順番の情報（calcChain）は、数式の番地を指しているため取り除く（Excelが開くときに作り直す）
  const wbRelsBytes = zip["xl/_rels/workbook.xml.rels"];
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

  // 4) ほかのシートの数式・名前の定義のうち、このシートを参照しているもの
  const patterns = sheetRefPatterns(view.name).map((p) => p.toLowerCase());
  let otherAdjusted = 0;
  let otherConverted = 0;
  locs.forEach((loc, i) => {
    if (i === sheetIndex || !loc.path || !zip[loc.path]) return;
    const other = parseXml(zip[loc.path], "シートのデータ");
    if (!byLocal(other, "f").some((f) => patterns.some((p) => (f.textContent ?? "").toLowerCase().includes(p)))) return;
    const r = processSheetFormulas(other, identity, view.name, false, remapRef);
    otherAdjusted += r.adjusted;
    otherConverted += r.converted;
    if (r.adjusted > 0 || r.converted > 0) out[loc.path] = serialize(other, zip[loc.path]);
  });
  let workbookChanged = false;
  let referencingNames = 0;
  for (const dn of byLocal(workbook, "definedName")) {
    const text = dn.textContent ?? "";
    if (!patterns.some((p) => text.toLowerCase().includes(p))) continue;
    const adjusted = adjustFormula(text, { maps: identity, sheetName: view.name, localIsEdited: false, remapRef });
    if (adjusted.ok) {
      if (adjusted.text !== text) {
        dn.textContent = adjusted.text;
        workbookChanged = true;
      }
    } else {
      referencingNames++;
    }
  }
  if (edited.kept > 0 || otherAdjusted > 0) {
    let calcPr = byLocal(workbook, "calcPr")[0];
    if (!calcPr) {
      calcPr = workbook.createElementNS(MAIN_NS, "calcPr");
      const after = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
      const before = Array.from(workbook.documentElement.children).find((el) => after.includes(el.localName)) ?? null;
      workbook.documentElement.insertBefore(calcPr, before);
    }
    calcPr.setAttribute("fullCalcOnLoad", "1");
    workbookChanged = true;
  }
  if (workbookChanged) out["xl/workbook.xml"] = serialize(workbook, zip["xl/workbook.xml"]);
  if (referencingNames > 0) {
    notices.push(`名前の定義${referencingNames}個が、詰めたセルを参照していますが、新しい位置に合わせて書き直せませんでした。正しい範囲になっているか、Excelで確認してください。`);
  }

  const zipped = zipSync(out as Zippable, { level: 6 });
  return {
    ...empty,
    blob: new Blob([new Uint8Array(zipped)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    movedCells: plan.movedCells,
    formulasKept: edited.kept,
    formulasConverted: edited.converted,
    otherAdjusted,
    otherConverted,
  };
}
