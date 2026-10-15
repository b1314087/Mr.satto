import type { CellBorderStyles, CellRangeRef } from "@/lib/excel/ooxml-page-settings";

/**
 * Excelの「条件付き書式」をPDF変換で再現するための、規則の型と評価処理。
 *
 * 条件付き書式は、ExcelではセルのスタイルではなくシートXMLの<conditionalFormatting>に
 * 別途保存されており、セルの値(や他のセルの値)に応じて背景色・文字色・太字を上書きする
 * （例: 土日・休業日の行を濃いグレー背景＋白文字にする）。これを読み取らないと、
 * Excelでは色が付いている行がPDFでは白いままになる。
 *
 * 再現できるのは「数式で判定する規則(expression)」「セルの値で判定する規則(cellIs)」
 * 「指定の文字を含む規則(containsText)」のうち、下の小さな数式評価器で計算できるものだけ。
 * 色スケール・データバー・アイコンセット・上位下位・重複値、および未対応の関数を含む数式は
 * 再現せず、その件数を呼び出し側へ返す（「再現できなかった」ことを利用者へ伝えるため）。
 * 数式は再計算せず、Excelに保存されている値（キャッシュ値）で判定する。
 */

export interface DxfStyle {
  fillRgb: string | null;
  fontRgb: string | null;
  bold: boolean;
  italic?: boolean;
  underline?: "single" | "double" | null;
  strike?: boolean;
  /** 条件に合ったときの罫線(辺ごと) */
  borders?: CellBorderStyles | null;
}

export interface ColorScaleSpec {
  /** 各点の基準(min・max・num・percent・percentile)と値 */
  points: { type: string; val: number | null }[];
  /** 各点の色("#RRGGBB") */
  colors: string[];
}

export interface DataBarSpec {
  min: { type: string; val: number | null };
  max: { type: string; val: number | null };
  color: string;
}

export interface ConditionalRule {
  type:
    | "expression"
    | "cellIs"
    | "containsText"
    | "notContainsText"
    | "beginsWith"
    | "endsWith"
    | "containsBlanks"
    | "notContainsBlanks"
    | "duplicateValues"
    | "uniqueValues"
    | "top10"
    | "aboveAverage"
    | "colorScale"
    | "dataBar"
    | "unsupported";
  /** top10: 上位(下位)N件またはN% / aboveAverage: 平均より上(false=下)・平均を含むか */
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  aboveAverage?: boolean;
  equalAverage?: boolean;
  colorScale?: ColorScaleSpec;
  dataBar?: DataBarSpec;
  /** 規則が適用されるセル範囲(sqref。複数可) */
  ranges: CellRangeRef[];
  /** 数式の基準セル(sqrefの最初の範囲の左上)。相対参照はここからのずれで解決する */
  baseRow: number;
  baseCol: number;
  /** expression: 判定の数式 / cellIs: 比較対象の数式(1〜2個) */
  formulas: string[];
  operator: string | null;
  text: string | null;
  priority: number;
  stopIfTrue: boolean;
  dxf: DxfStyle | null;
}

export interface ConditionalResult {
  fills: Map<string, string>;
  fontColors: Map<string, string>;
  bold: Map<string, boolean>;
  italic: Map<string, boolean>;
  underline: Map<string, "single" | "double">;
  strike: Map<string, boolean>;
  borders: Map<string, CellBorderStyles>;
  /** データバー: セル内の左側に、値に比例した長さ(0〜1)の色付きの棒を描く */
  dataBars: Map<string, { ratio: number; color: string }>;
  /** 再現できなかった規則の数 */
  unsupportedCount: number;
}

type Value = number | string | boolean | null;

class UnsupportedFormula extends Error {}
/** 値の型が合わない・0で割る等、Excelでもエラー値(#VALUE!等)になる計算。そのセルでは書式を適用しない */
class FormulaValueError extends Error {}

// ---------------------------------------------------------------------------
// 数式のパース(字句解析＋再帰下降)
// ---------------------------------------------------------------------------
type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; col: number; row: number; colAbs: boolean; rowAbs: boolean }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function colLettersToIndex(letters: string): number {
  let col = 0;
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new UnsupportedFormula("unterminated string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      tokens.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const numMatch = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (numMatch && !/[A-Za-z$]/.test(src[i - 1] ?? "")) {
      tokens.push({ t: "num", v: Number(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    const refMatch = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(!.])/.exec(src.slice(i));
    if (refMatch) {
      tokens.push({
        t: "ref",
        colAbs: refMatch[1] === "$",
        col: colLettersToIndex(refMatch[2].toUpperCase()),
        rowAbs: refMatch[3] === "$",
        row: Number(refMatch[4]) - 1,
      });
      i += refMatch[0].length;
      continue;
    }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (idMatch) {
      tokens.push({ t: "id", v: idMatch[0].toUpperCase() });
      i += idMatch[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("=<>+-*/&(),%".includes(ch)) {
      tokens.push({ t: "op", v: ch });
      i++;
      continue;
    }
    // シート参照(Sheet1!A1)・範囲(A1:B2)・名前付き範囲・配列など、小さな評価器の対象外
    throw new UnsupportedFormula(`unsupported token: ${ch}`);
  }
  return tokens;
}

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "ref"; col: number; row: number; colAbs: boolean; rowAbs: boolean }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "fn"; name: string; args: Node[] };

function parseFormula(src: string): Node {
  const tokens = tokenize(src.replace(/^=/, ""));
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const take = () => tokens[pos++];

  function parseComparison(): Node {
    let left = parseConcat();
    while (peek()?.t === "op" && ["=", "<>", "<", ">", "<=", ">="].includes((peek() as { v: string }).v)) {
      const op = (take() as { v: string }).v;
      left = { k: "bin", op, a: left, b: parseConcat() };
    }
    return left;
  }
  function parseConcat(): Node {
    let left = parseAdd();
    while (isOp("&")) {
      take();
      left = { k: "bin", op: "&", a: left, b: parseAdd() };
    }
    return left;
  }
  function parseAdd(): Node {
    let left = parseMul();
    while (isOp("+") || isOp("-")) {
      const op = (take() as { v: string }).v;
      left = { k: "bin", op, a: left, b: parseMul() };
    }
    return left;
  }
  function parseMul(): Node {
    let left = parseUnary();
    while (isOp("*") || isOp("/")) {
      const op = (take() as { v: string }).v;
      left = { k: "bin", op, a: left, b: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Node {
    if (isOp("-") || isOp("+")) {
      const op = (take() as { v: string }).v;
      return { k: "un", op, a: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const tok = take();
    if (!tok) throw new UnsupportedFormula("unexpected end");
    if (tok.t === "num") return { k: "num", v: tok.v };
    if (tok.t === "str") return { k: "str", v: tok.v };
    if (tok.t === "ref") return { k: "ref", col: tok.col, row: tok.row, colAbs: tok.colAbs, rowAbs: tok.rowAbs };
    if (tok.t === "op" && tok.v === "(") {
      const inner = parseComparison();
      if (!isOp(")")) throw new UnsupportedFormula("missing )");
      take();
      return inner;
    }
    if (tok.t === "id") {
      if (tok.v === "TRUE" && !isOp("(")) return { k: "bool", v: true };
      if (tok.v === "FALSE" && !isOp("(")) return { k: "bool", v: false };
      if (!isOp("(")) throw new UnsupportedFormula(`unknown name: ${tok.v}`);
      take();
      const args: Node[] = [];
      if (!isOp(")")) {
        for (;;) {
          args.push(parseComparison());
          if (isOp(",")) {
            take();
            continue;
          }
          break;
        }
      }
      if (!isOp(")")) throw new UnsupportedFormula("missing )");
      take();
      return { k: "fn", name: tok.v, args };
    }
    throw new UnsupportedFormula("unexpected token");
  }

  const node = parseComparison();
  if (pos < tokens.length) throw new UnsupportedFormula("trailing tokens");
  return node;
}

// ---------------------------------------------------------------------------
// 評価
// ---------------------------------------------------------------------------
function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v.trim());
  if (v.trim() === "" || !Number.isFinite(n)) throw new FormulaValueError("#VALUE!");
  return n;
}

function toText(v: Value): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function toBool(v: Value): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const u = v.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  throw new FormulaValueError("#VALUE!");
}

/** Excelの比較順序: 数値 < 文字列 < 論理値。空白は、相手の型に合わせて0・""・FALSEとみなす */
function compare(a: Value, b: Value): number {
  let x = a;
  let y = b;
  if (x === null && y === null) return 0;
  if (x === null) x = typeof y === "string" ? "" : typeof y === "boolean" ? false : 0;
  if (y === null) y = typeof x === "string" ? "" : typeof x === "boolean" ? false : 0;
  const rank = (v: Value) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (typeof x === "number" && typeof y === "number") return x === y ? 0 : x < y ? -1 : 1;
  if (typeof x === "string" && typeof y === "string") {
    const xs = x.toLowerCase();
    const ys = y.toLowerCase();
    return xs === ys ? 0 : xs < ys ? -1 : 1;
  }
  return Number(x) - Number(y);
}

function evalNode(node: Node, getRef: (col: number, row: number, colAbs: boolean, rowAbs: boolean) => Value): Value {
  switch (node.k) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "ref":
      return getRef(node.col, node.row, node.colAbs, node.rowAbs);
    case "un": {
      const n = toNumber(evalNode(node.a, getRef));
      return node.op === "-" ? -n : n;
    }
    case "bin": {
      const a = evalNode(node.a, getRef);
      const b = evalNode(node.b, getRef);
      switch (node.op) {
        case "=":
          return compare(a, b) === 0;
        case "<>":
          return compare(a, b) !== 0;
        case "<":
          return compare(a, b) < 0;
        case ">":
          return compare(a, b) > 0;
        case "<=":
          return compare(a, b) <= 0;
        case ">=":
          return compare(a, b) >= 0;
        case "&":
          return toText(a) + toText(b);
        case "+":
          return toNumber(a) + toNumber(b);
        case "-":
          return toNumber(a) - toNumber(b);
        case "*":
          return toNumber(a) * toNumber(b);
        case "/": {
          const d = toNumber(b);
          if (d === 0) throw new FormulaValueError("#DIV/0!");
          return toNumber(a) / d;
        }
      }
      throw new UnsupportedFormula("operator");
    }
    case "fn": {
      const arg = (i: number) => evalNode(node.args[i], getRef);
      switch (node.name) {
        case "AND":
          if (node.args.length === 0) throw new UnsupportedFormula("args");
          return node.args.every((_, i) => toBool(arg(i)));
        case "OR":
          if (node.args.length === 0) throw new UnsupportedFormula("args");
          return node.args.some((_, i) => toBool(arg(i)));
        case "NOT":
          return !toBool(arg(0));
        case "IF":
          return toBool(arg(0)) ? (node.args[1] ? arg(1) : true) : node.args[2] ? arg(2) : false;
        case "ISBLANK":
          return arg(0) === null;
        case "ISNUMBER":
          return typeof arg(0) === "number";
        case "ISTEXT":
          return typeof arg(0) === "string";
        case "LEN":
          return toText(arg(0)).length;
        case "MOD": {
          const n = toNumber(arg(0));
          const d = toNumber(arg(1));
          if (d === 0) throw new FormulaValueError("#DIV/0!");
          return n - d * Math.floor(n / d);
        }
        case "ABS":
          return Math.abs(toNumber(arg(0)));
        case "TRUE":
          return true;
        case "FALSE":
          return false;
      }
      throw new UnsupportedFormula(`function ${node.name}`);
    }
  }
}

/** Dateを、Excelのシリアル値(1900年系)へ変換する(日付どうしの比較用) */
function dateToSerial(d: Date): number {
  return Math.floor(d.getTime() / 86_400_000) + 25569 + (d.getTime() % 86_400_000) / 86_400_000;
}

function normalizeCell(raw: unknown): Value {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return dateToSerial(raw);
  if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") return raw === "" ? null : raw;
  return String(raw);
}

const MAX_CELL_EVALUATIONS = 300_000;

/** 比較の基準(min・max・num・percent・percentile)から、実際の値を求める */
function resolveThreshold(point: { type: string; val: number | null }, sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  switch (point.type) {
    case "min":
      return min;
    case "max":
      return max;
    case "num":
      return point.val;
    case "percent":
      return point.val === null ? null : min + ((max - min) * point.val) / 100;
    case "percentile": {
      if (point.val === null) return null;
      const pos = ((sorted.length - 1) * point.val) / 100;
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }
    default:
      return null;
  }
}

function lerpHex(a: string, b: string, t: number): string {
  const c = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) =>
    Math.round(c(a, i) + (c(b, i) - c(a, i)) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

function cellKeyOfValue(v: Value): string | null {
  if (v === null) return null;
  return typeof v === "string" ? `s:${v.toLowerCase()}` : `n:${String(v)}`;
}

/**
 * 条件付き書式の規則を、描画対象のセル範囲(bounds)に対して評価し、
 * セルごとの背景色・文字色・太字・罫線などの上書きを返す。優先度(priority)の小さい規則が先に勝つ
 * (同じ属性を複数の規則が指定した場合は、優先度の高い規則の指定を採用する)。
 * stopIfTrueの規則が成立したセルは、それより優先度の低い規則を適用しない。
 * dataBoundsは、平均・順位・重複などの集計に使うセルの範囲(シートの実データの範囲)。
 */
export function evaluateConditionalFormats(
  rules: ConditionalRule[],
  getCellValue: (row: number, col: number) => unknown,
  bounds: CellRangeRef,
  dataBounds?: CellRangeRef
): ConditionalResult {
  const result: ConditionalResult = {
    fills: new Map(),
    fontColors: new Map(),
    bold: new Map(),
    italic: new Map(),
    underline: new Map(),
    strike: new Map(),
    borders: new Map(),
    dataBars: new Map(),
    unsupportedCount: 0,
  };
  const stopped = new Set<string>();
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  let evaluations = 0;
  const data = dataBounds ?? bounds;

  const clip = (range: CellRangeRef, to: CellRangeRef): CellRangeRef | null => {
    const r: CellRangeRef = {
      startRow: Math.max(range.startRow, to.startRow),
      endRow: Math.min(range.endRow, to.endRow),
      startCol: Math.max(range.startCol, to.startCol),
      endCol: Math.min(range.endCol, to.endCol),
    };
    return r.startRow <= r.endRow && r.startCol <= r.endCol ? r : null;
  };

  /** 規則の対象範囲にある値(集計用。セルの位置つき)を集める */
  const collect = (rule: ConditionalRule) => {
    const cells: { r: number; c: number; v: Value }[] = [];
    for (const range of rule.ranges) {
      const rr = clip(range, data);
      if (!rr) continue;
      for (let r = rr.startRow; r <= rr.endRow; r++) {
        for (let c = rr.startCol; c <= rr.endCol; c++) {
          if (++evaluations > MAX_CELL_EVALUATIONS * 3) return cells;
          cells.push({ r, c, v: normalizeCell(getCellValue(r, c)) });
        }
      }
    }
    return cells;
  };

  const apply = (rule: ConditionalRule, key: string) => {
    const dxf = rule.dxf;
    if (dxf) {
      if (dxf.fillRgb && !result.fills.has(key)) result.fills.set(key, dxf.fillRgb);
      if (dxf.fontRgb && !result.fontColors.has(key)) result.fontColors.set(key, dxf.fontRgb);
      if (dxf.bold && !result.bold.has(key)) result.bold.set(key, true);
      if (dxf.italic && !result.italic.has(key)) result.italic.set(key, true);
      if (dxf.underline && !result.underline.has(key)) result.underline.set(key, dxf.underline);
      if (dxf.strike && !result.strike.has(key)) result.strike.set(key, true);
      if (dxf.borders) result.borders.set(key, { ...dxf.borders, ...(result.borders.get(key) ?? {}) });
    }
    if (rule.stopIfTrue) stopped.add(key);
  };
  const inBounds = (r: number, c: number) => r >= bounds.startRow && r <= bounds.endRow && c >= bounds.startCol && c <= bounds.endCol;

  for (const rule of ordered) {
    if (rule.type === "unsupported") {
      result.unsupportedCount++;
      continue;
    }

    // --- 範囲全体の値で決まる規則(色スケール・データバー・平均・順位・重複) ---
    if (["colorScale", "dataBar", "duplicateValues", "uniqueValues", "top10", "aboveAverage"].includes(rule.type)) {
      const cells = collect(rule);
      const numeric = cells.filter((x): x is { r: number; c: number; v: number } => typeof x.v === "number");
      const sorted = numeric.map((x) => x.v).sort((a, b) => a - b);

      if (rule.type === "colorScale" && rule.colorScale) {
        const spec = rule.colorScale;
        const stops = spec.points.map((p) => resolveThreshold(p, sorted));
        if (stops.some((v) => v === null) || spec.colors.length !== stops.length || sorted.length === 0) {
          result.unsupportedCount++;
          continue;
        }
        for (const cell of numeric) {
          if (!inBounds(cell.r, cell.c)) continue;
          const key = `${cell.r}:${cell.c}`;
          if (stopped.has(key) || result.fills.has(key)) continue;
          const v = cell.v;
          const thresholds = stops as number[];
          let color: string;
          if (v <= thresholds[0]) color = spec.colors[0];
          else if (v >= thresholds[thresholds.length - 1]) color = spec.colors[spec.colors.length - 1];
          else {
            let i = 0;
            while (i < thresholds.length - 2 && v > thresholds[i + 1]) i++;
            const span = thresholds[i + 1] - thresholds[i];
            color = lerpHex(spec.colors[i], spec.colors[i + 1], span === 0 ? 0 : (v - thresholds[i]) / span);
          }
          result.fills.set(key, color);
        }
        continue;
      }

      if (rule.type === "dataBar" && rule.dataBar) {
        const lo = resolveThreshold(rule.dataBar.min, sorted);
        const hi = resolveThreshold(rule.dataBar.max, sorted);
        if (lo === null || hi === null) {
          result.unsupportedCount++;
          continue;
        }
        for (const cell of numeric) {
          if (!inBounds(cell.r, cell.c)) continue;
          const key = `${cell.r}:${cell.c}`;
          if (stopped.has(key)) continue;
          const ratio = hi === lo ? 1 : Math.min(1, Math.max(0, (cell.v - lo) / (hi - lo)));
          // Excelは最小値でも棒を少し(10%)表示し、最大値でも90%までにする
          result.dataBars.set(key, { ratio: 0.1 + ratio * 0.8, color: rule.dataBar.color });
        }
        continue;
      }

      if (rule.type === "duplicateValues" || rule.type === "uniqueValues") {
        const counts = new Map<string, number>();
        for (const cell of cells) {
          const k = cellKeyOfValue(cell.v);
          if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        for (const cell of cells) {
          if (!inBounds(cell.r, cell.c)) continue;
          const k = cellKeyOfValue(cell.v);
          if (!k) continue;
          const dup = (counts.get(k) ?? 0) > 1;
          if ((rule.type === "duplicateValues") === dup) {
            const key = `${cell.r}:${cell.c}`;
            if (!stopped.has(key)) apply(rule, key);
          }
        }
        continue;
      }

      if (rule.type === "top10") {
        if (sorted.length === 0) continue;
        const n = Math.max(1, rule.rank ?? 10);
        const count = rule.percent ? Math.max(1, Math.floor((sorted.length * n) / 100)) : Math.min(n, sorted.length);
        const threshold = rule.bottom ? sorted[count - 1] : sorted[sorted.length - count];
        for (const cell of numeric) {
          if (!inBounds(cell.r, cell.c)) continue;
          if (rule.bottom ? cell.v <= threshold : cell.v >= threshold) {
            const key = `${cell.r}:${cell.c}`;
            if (!stopped.has(key)) apply(rule, key);
          }
        }
        continue;
      }

      if (rule.type === "aboveAverage") {
        if (sorted.length === 0) continue;
        const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        const above = rule.aboveAverage !== false;
        for (const cell of numeric) {
          if (!inBounds(cell.r, cell.c)) continue;
          const hit = above ? (rule.equalAverage ? cell.v >= avg : cell.v > avg) : rule.equalAverage ? cell.v <= avg : cell.v < avg;
          if (hit) {
            const key = `${cell.r}:${cell.c}`;
            if (!stopped.has(key)) apply(rule, key);
          }
        }
        continue;
      }
      continue;
    }

    if (!rule.dxf) continue;

    let formulaNodes: Node[];
    try {
      formulaNodes = rule.formulas.map(parseFormula);
      if (rule.type === "expression" && formulaNodes.length !== 1) throw new UnsupportedFormula("formula count");
      if (rule.type === "cellIs" && formulaNodes.length < 1) throw new UnsupportedFormula("formula count");
    } catch {
      result.unsupportedCount++;
      continue;
    }

    let failed = false;
    for (const range of rule.ranges) {
      if (failed) break;
      const rr = clip(range, bounds);
      if (!rr) continue;
      for (let r = rr.startRow; r <= rr.endRow && !failed; r++) {
        for (let c = rr.startCol; c <= rr.endCol; c++) {
          if (++evaluations > MAX_CELL_EVALUATIONS) {
            failed = true;
            break;
          }
          const key = `${r}:${c}`;
          if (stopped.has(key)) continue;
          const dr = r - rule.baseRow;
          const dc = c - rule.baseCol;
          const getRef = (col: number, row: number, colAbs: boolean, rowAbs: boolean): Value => {
            const r2 = rowAbs ? row : row + dr;
            const c2 = colAbs ? col : col + dc;
            if (r2 < 0 || c2 < 0) return null;
            return normalizeCell(getCellValue(r2, c2));
          };
          let matched = false;
          try {
            const cur = normalizeCell(getCellValue(r, c));
            const curText = toText(cur).toLowerCase();
            if (rule.type === "expression") {
              matched = toBool(evalNode(formulaNodes[0], getRef));
            } else if (rule.type === "cellIs") {
              const v1 = evalNode(formulaNodes[0], getRef);
              const cmp = compare(cur, v1);
              switch (rule.operator) {
                case "equal":
                  matched = cmp === 0;
                  break;
                case "notEqual":
                  matched = cmp !== 0;
                  break;
                case "greaterThan":
                  matched = cmp > 0;
                  break;
                case "greaterThanOrEqual":
                  matched = cmp >= 0;
                  break;
                case "lessThan":
                  matched = cmp < 0;
                  break;
                case "lessThanOrEqual":
                  matched = cmp <= 0;
                  break;
                case "between":
                case "notBetween": {
                  if (formulaNodes.length < 2) throw new UnsupportedFormula("between");
                  const v2 = evalNode(formulaNodes[1], getRef);
                  const inside = cmp >= 0 && compare(cur, v2) <= 0;
                  matched = rule.operator === "between" ? inside : !inside;
                  break;
                }
                default:
                  throw new UnsupportedFormula("operator");
              }
            } else {
              const needle = (rule.text ?? "").toLowerCase();
              switch (rule.type) {
                case "containsText":
                  matched = rule.text !== null && curText.includes(needle);
                  break;
                case "notContainsText":
                  matched = rule.text !== null && !curText.includes(needle);
                  break;
                case "beginsWith":
                  matched = rule.text !== null && curText.startsWith(needle);
                  break;
                case "endsWith":
                  matched = rule.text !== null && curText.endsWith(needle);
                  break;
                case "containsBlanks":
                  matched = cur === null || curText.trim() === "";
                  break;
                case "notContainsBlanks":
                  matched = !(cur === null || curText.trim() === "");
                  break;
                default:
                  throw new UnsupportedFormula("type");
              }
            }
          } catch (e) {
            // エラー値になる計算(#VALUE!等)は、Excelと同じくそのセルだけ「成立しない」扱いにして続ける。
            // 未対応の関数・演算子は、規則ごと再現不能として数える。
            if (e instanceof FormulaValueError) continue;
            failed = true;
            break;
          }
          if (matched) apply(rule, key);
        }
      }
    }
    if (failed) result.unsupportedCount++;
  }
  return result;
}

/** 数式の基準セル(sqrefの最初の範囲の左上)を求める */
export function baseCellOf(ranges: CellRangeRef[]): { row: number; col: number } {
  const first = ranges[0];
  return first ? { row: first.startRow, col: first.startCol } : { row: 0, col: 0 };
}
