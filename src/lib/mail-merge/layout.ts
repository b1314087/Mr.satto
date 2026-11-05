/**
 * 差し込み印刷・レイアウト作成：用紙・差し込み項目・文字の配置の計算（画面のプレビューとPDF出力で共通）。
 * ブラウザ内の計算だけ（ライブラリに依存しない）。
 *
 * 座標の決まり：
 * - 項目の位置・大きさは mm で持つ（画面の拡大率に左右されない）。原点は用紙の左上、右・下が正。
 * - 文字の配置は pt（1pt＝1/72インチ）で計算する。PDF（原点は左下）へは y を「用紙の高さ − 上からの位置」に直して描く。
 * - 画面のプレビューは、同じ計算結果を「1pt あたりの画面のピクセル数」を掛けて描くだけ（位置がずれない）。
 */

export const PT_PER_MM = 72 / 25.4;
export const mmToPt = (mm: number) => mm * PT_PER_MM;
export const ptToMm = (pt: number) => pt / PT_PER_MM;

// ---------------------------------------------------------------------------
// 用紙
// ---------------------------------------------------------------------------

export type PaperPresetId = "A4" | "A3" | "B5" | "chou3" | "you2" | "custom";

/** 用紙の大きさ（縦向きの値、mm） */
export const PAPER_PRESETS: { id: PaperPresetId; label: string; widthMm: number; heightMm: number }[] = [
  { id: "A4", label: "A4（210×297mm）", widthMm: 210, heightMm: 297 },
  { id: "A3", label: "A3（297×420mm）", widthMm: 297, heightMm: 420 },
  { id: "B5", label: "B5（182×257mm）", widthMm: 182, heightMm: 257 },
  { id: "chou3", label: "長形3号の封筒（120×235mm）", widthMm: 120, heightMm: 235 },
  { id: "you2", label: "洋形2号の封筒（114×162mm）", widthMm: 114, heightMm: 162 },
  { id: "custom", label: "自由なサイズ（mmで指定）", widthMm: 100, heightMm: 148 },
];

export const PAPER_MIN_MM = 20;
export const PAPER_MAX_MM = 1200;

export type Orientation = "portrait" | "landscape";

export interface PaperSetting {
  /** pdf：PDFを背景にする、blank：白紙 */
  mode: "pdf" | "blank";
  presetId: PaperPresetId;
  orientation: Orientation;
  /** 自由なサイズのときの幅・高さ（mm。縦向きの値） */
  widthMm: number;
  heightMm: number;
}

export const DEFAULT_PAPER: PaperSetting = { mode: "blank", presetId: "A4", orientation: "portrait", widthMm: 210, heightMm: 297 };

/** 白紙のときの用紙の大きさ（向きを反映した pt） */
export function blankPageSizePt(p: PaperSetting): { width: number; height: number } {
  const preset = PAPER_PRESETS.find((x) => x.id === p.presetId) ?? PAPER_PRESETS[0];
  const w = p.presetId === "custom" ? p.widthMm : preset.widthMm;
  const h = p.presetId === "custom" ? p.heightMm : preset.heightMm;
  const cw = clampPaperMm(w);
  const ch = clampPaperMm(h);
  // 入力どおり（既定の用紙は縦向きの値）を「縦」とし、横にすると幅と高さを入れ替える
  const [width, height] = p.orientation === "landscape" ? [ch, cw] : [cw, ch];
  return { width: mmToPt(width), height: mmToPt(height) };
}

export function clampPaperMm(v: number): number {
  if (!Number.isFinite(v)) return PAPER_MIN_MM;
  return Math.min(PAPER_MAX_MM, Math.max(PAPER_MIN_MM, v));
}

// ---------------------------------------------------------------------------
// 差し込み項目
// ---------------------------------------------------------------------------

export type FontId = "gothic" | "mincho";
export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";
export type Direction = "horizontal" | "vertical";

export const FONT_OPTIONS: { value: FontId; label: string }[] = [
  { value: "gothic", label: "ゴシック体（Noto Sans JP）" },
  { value: "mincho", label: "明朝体（Noto Serif JP）" },
];

export interface MergeField {
  id: string;
  /** 項目名（氏名・住所など。Excelの列との自動の紐付けにも使う） */
  name: string;
  /** 文字の枠の左上（用紙の左上から、mm） */
  xMm: number;
  yMm: number;
  sizePt: number;
  font: FontId;
  /** 文字色（#rrggbb） */
  color: string;
  /** 横位置（最大幅の中での揃え。最大幅がないときは、複数行のそろえ方） */
  align: HAlign;
  /** 縦方向（最大高さの中での位置） */
  vAlign: VAlign;
  direction: Direction;
  /** 最大幅・最大高さ（mm。0 のときは指定なし）。最大幅を超える横書きは折り返す */
  maxWidthMm: number;
  maxHeightMm: number;
  /** 枠に入らないときだけ、文字を小さくして収める（初期はオフ。オンにしたときだけ小さくする） */
  shrinkToFit: boolean;
  /** 前後に付ける文字（「〒」「様」など） */
  prefix: string;
  suffix: string;
}

export const FIELD_LIMITS = {
  sizePt: [4, 200] as const,
  mm: [-50, PAPER_MAX_MM] as const,
  boxMm: [0, PAPER_MAX_MM] as const,
  name: 30,
  affix: 20,
};

export function newField(id: string, name: string, xMm: number, yMm: number): MergeField {
  return {
    id,
    name,
    xMm: round1(xMm),
    yMm: round1(yMm),
    sizePt: 12,
    font: "gothic",
    color: "#111111",
    align: "left",
    vAlign: "top",
    direction: "horizontal",
    maxWidthMm: 0,
    maxHeightMm: 0,
    shrinkToFit: false,
    prefix: "",
    suffix: "",
  };
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// 文字の配置（プレビュー・PDF共通）
// ---------------------------------------------------------------------------

/** 文字の幅を測る関数（PDFと同じフォントの幅。pt） */
export type MeasureFn = (text: string, font: FontId, sizePt: number) => number;

export interface GlyphRun {
  text: string;
  /** 左端（pt、用紙の左から） */
  x: number;
  /** ベースライン（pt、用紙の上から） */
  baseline: number;
  sizePt: number;
  font: FontId;
  color: string;
}

export interface FieldLayout {
  runs: GlyphRun[];
  /** 文字の枠（pt、用紙の左上から）。画面で項目をつかむ・はみ出しを確かめるのに使う */
  box: { x: number; y: number; w: number; h: number };
  /** 実際に使った文字サイズ（「小さくして収める」のときだけ、設定より小さくなる） */
  usedSizePt: number;
  /** 枠（最大幅・最大高さ）に入らない */
  overflowBox: boolean;
  /** 用紙からはみ出す */
  overflowPage: boolean;
}

/** 横書きの行の間隔（文字サイズに対する倍率） */
export const LINE_HEIGHT = 1.35;
/** 文字の上端からベースラインまで（文字サイズに対する倍率。Noto Sans JP / Serif JP の目安） */
export const ASCENT = 0.88;
/** 縦書きの1文字の送り・列の間隔 */
const V_ADVANCE = 1.08;
const V_COLUMN = 1.5;

/** 縦書き用に文字を直す：半角数字は全角に、横棒（ハイフン・長音）は縦棒にする（縦書きの字形を持たないPDFでも縦に見えるように） */
const FULL_WIDTH_DIGIT = (s: string) =>
  s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)).replace(/[-‐−－ー―─]/g, "｜");

/** 横書き：文字の幅で折り返す（日本語は1文字ずつ。英単語の途中でも折り返す） */
export function wrapLine(text: string, font: FontId, sizePt: number, maxWidth: number, measure: MeasureFn): string[] {
  if (maxWidth <= 0) return [text];
  const out: string[] = [];
  let current = "";
  for (const ch of Array.from(text)) {
    const candidate = current + ch;
    if (current !== "" && measure(candidate, font, sizePt) > maxWidth) {
      out.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
}

function layoutAt(field: MergeField, text: string, sizePt: number, page: { width: number; height: number }, measure: MeasureFn): FieldLayout {
  const x0 = mmToPt(field.xMm);
  const y0 = mmToPt(field.yMm);
  const maxW = mmToPt(Math.max(0, field.maxWidthMm));
  const maxH = mmToPt(Math.max(0, field.maxHeightMm));
  const runs: GlyphRun[] = [];
  let boxW = 0;
  let boxH = 0;
  let overflowBox = false;

  if (field.direction === "vertical") {
    const adv = sizePt * V_ADVANCE;
    const colGap = sizePt * V_COLUMN;
    const colHeight = maxH > 0 ? maxH : Math.max(adv, page.height - y0);
    const perCol = Math.max(1, Math.floor(colHeight / adv));
    const columns: string[][] = [];
    for (const para of FULL_WIDTH_DIGIT(text).split(/\r\n|\r|\n/)) {
      const chars = Array.from(para);
      if (chars.length === 0) {
        columns.push([]);
        continue;
      }
      for (let i = 0; i < chars.length; i += perCol) columns.push(chars.slice(i, i + perCol));
    }
    const nCols = Math.max(1, columns.length);
    const used = (nCols - 1) * colGap + sizePt;
    boxW = maxW > 0 ? maxW : used;
    const tallest = Math.max(0, ...columns.map((c) => c.length)) * adv;
    boxH = maxH > 0 ? maxH : tallest;
    if (maxW > 0 && used > maxW + 0.01) overflowBox = true;
    if (maxH > 0 && tallest > maxH + 0.01) overflowBox = true;
    columns.forEach((chars, col) => {
      const colH = chars.length * adv;
      const offsetY = field.vAlign === "middle" ? (boxH - colH) / 2 : field.vAlign === "bottom" ? boxH - colH : 0;
      // 列は右から左へ。1列目の中心は、枠の右端から文字半分ぶん内側
      const cx = x0 + boxW - sizePt / 2 - col * colGap;
      chars.forEach((ch, row) => {
        const w = measure(ch, field.font, sizePt);
        runs.push({ text: ch, x: cx - w / 2, baseline: y0 + offsetY + row * adv + sizePt * ASCENT, sizePt, font: field.font, color: field.color });
      });
    });
  } else {
    const lineH = sizePt * LINE_HEIGHT;
    const lines = text.split(/\r\n|\r|\n/).flatMap((l) => wrapLine(l, field.font, sizePt, maxW, measure));
    const widths = lines.map((l) => measure(l, field.font, sizePt));
    const widest = Math.max(0, ...widths);
    boxW = maxW > 0 ? maxW : widest;
    const textH = lines.length > 0 ? (lines.length - 1) * lineH + sizePt : 0;
    boxH = maxH > 0 ? maxH : textH;
    if (maxH > 0 && textH > maxH + 0.01) overflowBox = true;
    if (maxW > 0 && widest > maxW + 0.01) overflowBox = true;
    const offsetY = field.vAlign === "middle" ? (boxH - textH) / 2 : field.vAlign === "bottom" ? boxH - textH : 0;
    lines.forEach((line, i) => {
      if (line === "") return;
      const w = widths[i];
      const x = field.align === "center" ? x0 + (boxW - w) / 2 : field.align === "right" ? x0 + boxW - w : x0;
      runs.push({ text: line, x, baseline: y0 + offsetY + i * lineH + sizePt * ASCENT, sizePt, font: field.font, color: field.color });
    });
  }

  const box = { x: x0, y: y0, w: Math.max(boxW, 1), h: Math.max(boxH, sizePt) };
  const overflowPage = box.x < -0.01 || box.y < -0.01 || box.x + box.w > page.width + 0.01 || box.y + box.h > page.height + 0.01;
  return { runs, box, usedSizePt: sizePt, overflowBox, overflowPage };
}

/**
 * 1つの項目に、1件分の文字を配置する。
 * 「小さくして収める」がオンで枠に入らないときだけ、0.5pt ずつ小さくして収める（最小 4pt）。オフなら設定の大きさのまま。
 */
export function layoutField(field: MergeField, text: string, page: { width: number; height: number }, measure: MeasureFn): FieldLayout {
  let layout = layoutAt(field, text, field.sizePt, page, measure);
  if (field.shrinkToFit && layout.overflowBox) {
    for (let s = field.sizePt - 0.5; s >= FIELD_LIMITS.sizePt[0]; s -= 0.5) {
      const next = layoutAt(field, text, s, page, measure);
      layout = next;
      if (!next.overflowBox) break;
    }
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Excel・CSVのデータ
// ---------------------------------------------------------------------------

export type CellValue = string | number | boolean | Date | null | undefined;

/** セルの値を、差し込む文字にする（日付は yyyy/mm/dd、数値はそのまま） */
export function cellToText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    return `${v.getFullYear()}/${String(v.getMonth() + 1).padStart(2, "0")}/${String(v.getDate()).padStart(2, "0")}`;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v).replace(/\r\n|\r/g, "\n");
}

export interface MergeData {
  columns: string[];
  records: string[][];
  /** 列ごとの空欄の数 */
  blanks: number[];
}

/**
 * 表（1行目を列名とするのが基本）を、列名とデータの行にする。headerRow は列名の行（1から）。
 * 全部空の行は除く。列名が空の列は「列1」のように名前を付ける。同じ列名は「(2)」を付けて区別する。
 */
export function tableToData(rows: CellValue[][], headerRow: number): MergeData {
  const h = Math.max(1, Math.floor(headerRow)) - 1;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const header = rows[h] ?? [];
  const used = new Map<string, number>();
  const columns = Array.from({ length: width }, (_, i) => {
    const base = cellToText(header[i]).replace(/\s+/g, " ").trim() || `列${i + 1}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}(${n})`;
  });
  const records = rows
    .slice(h + 1)
    .map((r) => Array.from({ length: width }, (_, i) => cellToText(r[i])))
    .filter((r) => r.some((c) => c.trim() !== ""));
  const blanks = columns.map((_, i) => records.filter((r) => r[i].trim() === "").length);
  return { columns, records, blanks };
}

/** 名前の比べ方（全角半角・空白・大文字小文字の違いを無視） */
function nameKey(s: string): string {
  return s.normalize("NFKC").replace(/[\s　・_\-()（）]/g, "").toLowerCase();
}

/** 意味が同じ列名（自動の紐付けに使う） */
const SAME_MEANING: string[][] = [
  ["氏名", "名前", "お名前", "宛名", "name", "fullname"],
  ["郵便番号", "〒", "郵便", "zip", "zipcode", "postalcode"],
  ["住所", "所在地", "address"],
  ["会社名", "会社", "社名", "企業名", "法人名", "company"],
  ["部署", "部署名", "所属", "department"],
  ["役職", "肩書", "肩書き", "title"],
  ["電話番号", "電話", "tel", "phone"],
  ["メールアドレス", "メール", "email", "mail"],
];

/**
 * 項目名とExcelの列名を、自動で紐付ける。完全一致（表記ゆれを無視）か、意味が同じ名前のときだけ。
 * 迷う（あいまいな）ときは紐付けない（誤った列に紐付けるより、空のまま選んでもらう）。
 */
export function autoMap(fieldName: string, columns: string[]): string | null {
  const key = nameKey(fieldName);
  if (!key) return null;
  const exact = columns.filter((c) => nameKey(c) === key);
  if (exact.length >= 1) return exact[0];
  const group = SAME_MEANING.find((g) => g.some((n) => nameKey(n) === key));
  if (group) {
    const hits = columns.filter((c) => group.some((n) => nameKey(n) === nameKey(c)));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** 項目に差し込む文字の決め方：列から取る、または固定の文字 */
export type FieldSource = { kind: "column"; column: string } | { kind: "fixed"; text: string } | { kind: "none" };

/** 1件分の、項目に差し込む文字（前後の文字つき。値が空なら前後の文字も付けない） */
export function fieldText(field: MergeField, source: FieldSource | undefined, data: MergeData | null, recordIndex: number): string {
  let value = "";
  if (source?.kind === "fixed") value = source.text;
  else if (source?.kind === "column" && data) {
    const col = data.columns.indexOf(source.column);
    value = col >= 0 ? (data.records[recordIndex]?.[col] ?? "") : "";
  }
  if (value.trim() === "") return "";
  return `${field.prefix}${value}${field.suffix}`;
}
