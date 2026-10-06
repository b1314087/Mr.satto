/**
 * ラベル作成の共通ロジック（Word出力・Excel出力・プレビューが同じ計算を使う）。
 *
 * - 用紙・ラベルの大きさ・行数列数・余白・間隔(すべてmm)の検証
 * - ラベルに入れる内容(全ラベル同じ / ラベルごとに違う)から、1ページ分ずつの中身を作る
 */

export type LabelPaperId = "A4" | "A5" | "B5" | "A3" | "Letter" | "Postcard";

export const LABEL_PAPERS: { id: LabelPaperId; label: string; widthMm: number; heightMm: number }[] = [
  { id: "A4", label: "A4 (210×297mm)", widthMm: 210, heightMm: 297 },
  { id: "A5", label: "A5 (148×210mm)", widthMm: 148, heightMm: 210 },
  { id: "B5", label: "B5 (182×257mm)", widthMm: 182, heightMm: 257 },
  { id: "A3", label: "A3 (297×420mm)", widthMm: 297, heightMm: 420 },
  { id: "Letter", label: "レター (215.9×279.4mm)", widthMm: 215.9, heightMm: 279.4 },
  { id: "Postcard", label: "はがき (100×148mm)", widthMm: 100, heightMm: 148 },
];

export function paperSizeMm(paper: LabelPaperId, landscape: boolean): { widthMm: number; heightMm: number } {
  const p = LABEL_PAPERS.find((x) => x.id === paper) ?? LABEL_PAPERS[0];
  return landscape ? { widthMm: p.heightMm, heightMm: p.widthMm } : { widthMm: p.widthMm, heightMm: p.heightMm };
}

export interface LabelGeometry {
  paper: LabelPaperId;
  landscape: boolean;
  labelWidthMm: number;
  labelHeightMm: number;
  columns: number;
  rows: number;
  /** 用紙の上端から最初のラベルまで */
  marginTopMm: number;
  /** 用紙の左端から最初のラベルまで */
  marginLeftMm: number;
  gapHMm: number;
  gapVMm: number;
}

export type LabelFontKey = "gothic" | "mincho" | "meiryo";
export type LabelHAlign = "left" | "center" | "right";
export type LabelVAlign = "top" | "middle" | "bottom";

export const LABEL_FONTS: { key: LabelFontKey; label: string; name: string; css: string }[] = [
  { key: "gothic", label: "ゴシック体", name: "游ゴシック", css: '"Yu Gothic", "Hiragino Sans", "Meiryo", sans-serif' },
  { key: "mincho", label: "明朝体", name: "游明朝", css: '"Yu Mincho", "Hiragino Mincho ProN", "MS PMincho", serif' },
  { key: "meiryo", label: "メイリオ", name: "メイリオ", css: '"Meiryo", "Hiragino Sans", sans-serif' },
];

export interface LabelStyle {
  fontSizePt: number;
  fontKey: LabelFontKey;
  bold: boolean;
  hAlign: LabelHAlign;
  vAlign: LabelVAlign;
  /** 行の間隔(%)。100=標準 */
  lineSpacingPct: number;
  /** ラベルの縁から文字までの余白(mm) */
  paddingMm: number;
  /** ラベルの枠線を印刷するか */
  border: boolean;
}

export type LabelContentMode = "same" | "different";
export type LabelSplitMode = "blank" | "line";

export interface LabelContent {
  mode: LabelContentMode;
  /** mode="same": 全ラベルに入る文字 */
  sameText: string;
  /** mode="different": ラベルごとの文字をまとめて入力した欄 */
  listText: string;
  /** "blank": 空行で区切る / "line": 1行を1ラベルにする(タブ区切りは改行に変換) */
  splitMode: LabelSplitMode;
  /** mode="different": 1ページ目の何枚目から使い始めるか(使いかけのシート用) */
  startPosition: number;
}

export interface LabelSettings {
  geometry: LabelGeometry;
  style: LabelStyle;
  content: LabelContent;
}

export const MAX_LABELS_PER_PAGE = 500;
export const MAX_PAGES = 100;

export const DEFAULT_GEOMETRY: LabelGeometry = {
  paper: "A4",
  landscape: false,
  labelWidthMm: 70,
  labelHeightMm: 42.3,
  columns: 2,
  rows: 6,
  marginTopMm: 21.6,
  marginLeftMm: 33.5,
  gapHMm: 3,
  gapVMm: 0,
};

export const DEFAULT_STYLE: LabelStyle = {
  fontSizePt: 12,
  fontKey: "gothic",
  bold: false,
  hAlign: "center",
  vAlign: "middle",
  lineSpacingPct: 100,
  paddingMm: 2,
  border: true,
};

export const DEFAULT_CONTENT: LabelContent = {
  mode: "same",
  sameText: "見本ラベル",
  listText: "",
  splitMode: "blank",
  startPosition: 1,
};

/** 市販ラベル用紙でよくある寸法の目安。お手持ちの用紙の寸法に合わせて数値を直して使う */
export const LABEL_PRESETS: { id: string; label: string; geometry: Partial<LabelGeometry> }[] = [
  {
    id: "a4-12",
    label: "A4 12面（2列×6行・70×42.3mm）",
    geometry: { paper: "A4", landscape: false, labelWidthMm: 70, labelHeightMm: 42.3, columns: 2, rows: 6, marginTopMm: 21.6, marginLeftMm: 33.5, gapHMm: 3, gapVMm: 0 },
  },
  {
    id: "a4-8",
    label: "A4 8面（2列×4行・99.1×67.7mm）",
    geometry: { paper: "A4", landscape: false, labelWidthMm: 99.1, labelHeightMm: 67.7, columns: 2, rows: 4, marginTopMm: 13.1, marginLeftMm: 4.65, gapHMm: 2.5, gapVMm: 0 },
  },
  {
    id: "a4-21",
    label: "A4 21面（3列×7行・63.5×38.1mm）",
    geometry: { paper: "A4", landscape: false, labelWidthMm: 63.5, labelHeightMm: 38.1, columns: 3, rows: 7, marginTopMm: 15.15, marginLeftMm: 7.2, gapHMm: 2.5, gapVMm: 0 },
  },
  {
    id: "a4-24",
    label: "A4 24面（3列×8行・63.5×33.9mm）",
    geometry: { paper: "A4", landscape: false, labelWidthMm: 63.5, labelHeightMm: 33.9, columns: 3, rows: 8, marginTopMm: 12.9, marginLeftMm: 7.2, gapHMm: 2.5, gapVMm: 0 },
  },
  {
    id: "a4-65",
    label: "A4 65面（5列×13行・38.1×21.2mm）",
    geometry: { paper: "A4", landscape: false, labelWidthMm: 38.1, labelHeightMm: 21.2, columns: 5, rows: 13, marginTopMm: 10.7, marginLeftMm: 4.75, gapHMm: 2.5, gapVMm: 0 },
  },
  {
    id: "a4-card10",
    label: "名刺サイズ 10面（2列×5行・91×55mm）",
    geometry: { paper: "A4", landscape: false, labelWidthMm: 91, labelHeightMm: 55, columns: 2, rows: 5, marginTopMm: 11, marginLeftMm: 14, gapHMm: 0, gapVMm: 0 },
  },
];

export type AxisSegment = { kind: "margin" | "gap" | "label"; mm: number };

/**
 * 1方向(縦または横)の並び: [先頭余白] ラベル [間隔] ラベル ... 。
 * 0mmの余白・間隔は含めない(Word/Excelに大きさ0の行・列を作らないため)。
 */
export function buildAxisPlan(count: number, labelMm: number, gapMm: number, marginStartMm: number): AxisSegment[] {
  const plan: AxisSegment[] = [];
  if (marginStartMm > 0) plan.push({ kind: "margin", mm: marginStartMm });
  for (let i = 0; i < count; i++) {
    if (i > 0 && gapMm > 0) plan.push({ kind: "gap", mm: gapMm });
    plan.push({ kind: "label", mm: labelMm });
  }
  return plan;
}

const EPS = 0.01;

export function labelsPerPage(g: LabelGeometry): number {
  return g.rows * g.columns;
}

/** 配置全体の大きさ(先頭余白を含む。用紙の右端・下端までの余りは含まない) */
export function usedSizeMm(g: LabelGeometry): { widthMm: number; heightMm: number } {
  return {
    widthMm: g.marginLeftMm + g.columns * g.labelWidthMm + Math.max(0, g.columns - 1) * g.gapHMm,
    heightMm: g.marginTopMm + g.rows * g.labelHeightMm + Math.max(0, g.rows - 1) * g.gapVMm,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function validateGeometry(g: LabelGeometry): string | null {
  const nums = [g.labelWidthMm, g.labelHeightMm, g.marginTopMm, g.marginLeftMm, g.gapHMm, g.gapVMm];
  if (nums.some((v) => !Number.isFinite(v))) return "数値が入力されていない欄があります";
  if (!(g.labelWidthMm > 0) || !(g.labelHeightMm > 0)) return "ラベルの幅・高さは0より大きい値を指定してください";
  if (!Number.isInteger(g.rows) || g.rows < 1 || !Number.isInteger(g.columns) || g.columns < 1) {
    return "行数・列数は1以上の整数で指定してください";
  }
  if (g.rows * g.columns > MAX_LABELS_PER_PAGE) {
    return `1ページのラベル数が多すぎます(最大${MAX_LABELS_PER_PAGE}枚まで)。行数・列数を見直してください`;
  }
  if (nums.slice(2).some((v) => v < 0)) return "余白・間隔にマイナスの値は指定できません";
  const paper = paperSizeMm(g.paper, g.landscape);
  const used = usedSizeMm(g);
  if (used.widthMm > paper.widthMm + EPS) {
    return `ラベルが用紙の横幅に収まりません(必要 ${round1(used.widthMm)}mm / 用紙 ${paper.widthMm}mm)。幅・列数・間隔・左余白を見直してください`;
  }
  if (used.heightMm > paper.heightMm + EPS) {
    return `ラベルが用紙の高さに収まりません(必要 ${round1(used.heightMm)}mm / 用紙 ${paper.heightMm}mm)。高さ・行数・間隔・上余白を見直してください`;
  }
  return null;
}

export function validateStyle(s: LabelStyle): string | null {
  if (!Number.isFinite(s.fontSizePt) || s.fontSizePt < 1 || s.fontSizePt > 500) return "文字の大きさは1〜500ptの範囲で指定してください";
  if (!Number.isFinite(s.lineSpacingPct) || s.lineSpacingPct < 50 || s.lineSpacingPct > 400) return "行の間隔は50〜400%の範囲で指定してください";
  if (!Number.isFinite(s.paddingMm) || s.paddingMm < 0) return "ラベル内の余白は0以上で指定してください";
  return null;
}

/** "different" モードの入力欄を、ラベル1枚ぶんずつの文字に分ける */
export function parseLabelEntries(listText: string, splitMode: LabelSplitMode): string[] {
  const text = listText.replace(/\r\n?/g, "\n");
  if (splitMode === "line") {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.split("\t").map((cell) => cell.trim()).join("\n"));
  }
  return text
    .split(/\n[ \t　]*\n/)
    .map((chunk) => chunk.replace(/^\n+|\n+$/g, ""))
    .filter((chunk) => chunk.trim() !== "");
}

export interface LabelPlan {
  /** ページごとの、ラベルごとの文字(左上から右へ、次の行へ…の順)。空のラベルは "" */
  pages: string[][];
  /** 文字が入るラベルの数 */
  filledCount: number;
}

export function validateContent(c: LabelContent, g: LabelGeometry): string | null {
  const perPage = labelsPerPage(g);
  if (c.mode === "different") {
    if (!Number.isInteger(c.startPosition) || c.startPosition < 1 || c.startPosition > perPage) {
      return `使い始める位置は1〜${perPage}の整数で指定してください`;
    }
    const entries = parseLabelEntries(c.listText, c.splitMode);
    if (entries.length === 0) return "ラベルに入れる文字を入力してください(1枚ごとに空行で区切ります)";
    const pageCount = Math.ceil((c.startPosition - 1 + entries.length) / perPage);
    if (pageCount > MAX_PAGES) return `ページ数が多すぎます(最大${MAX_PAGES}ページまで)。件数を減らしてください`;
  }
  return null;
}

/** 設定から、ページごとの中身を作る。設定に問題があるときは例外を投げる */
export function planLabelPages(g: LabelGeometry, c: LabelContent): LabelPlan {
  const geometryError = validateGeometry(g);
  if (geometryError) throw new Error(geometryError);
  const contentError = validateContent(c, g);
  if (contentError) throw new Error(contentError);
  const perPage = labelsPerPage(g);
  if (c.mode === "same") {
    return { pages: [Array.from({ length: perPage }, () => c.sameText)], filledCount: perPage };
  }
  const entries = parseLabelEntries(c.listText, c.splitMode);
  const slots: string[] = [...Array.from({ length: c.startPosition - 1 }, () => ""), ...entries];
  const pages: string[][] = [];
  for (let i = 0; i < slots.length; i += perPage) {
    const page = slots.slice(i, i + perPage);
    while (page.length < perPage) page.push("");
    pages.push(page);
  }
  return { pages, filledCount: entries.length };
}

export function mmToTwips(mm: number): number {
  return Math.round((mm / 25.4) * 1440);
}
