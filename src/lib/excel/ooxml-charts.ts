/**
 * Excelのグラフ(xl/charts/chartN.xml。DrawingMLのグラフ形式)の読み取り。
 *
 * 新しいライブラリは使わず、既存のZIP解凍(fflate)とブラウザ標準のDOMParserで、グラフの定義を直接読む
 * (ooxml-page-settings.ts・ooxml-drawings.ts と同じ方針)。描画は src/lib/excel/chart-render.ts。
 *
 * 対応する種類: 縦棒・横棒(集合・積み上げ・100%積み上げ)、折れ線(マーカーあり/なし・積み上げ)、
 *   円、ドーナツ、面(標準・積み上げ・100%積み上げ)、散布図(マーカーのみ・直線・平滑線)、
 *   およびこれらを組み合わせた複合グラフ(第2軸を含む)。
 * 対応しない種類(3-Dグラフ・レーダー・株価・バブル・等高線・補助円付き円・Excel 2016以降の新しいグラフ
 *   (ウォーターフォール・ツリーマップ等))は、種類の名前を付けて「未対応」として返す(描画側で警告と枠を出す)。
 *
 * データは、グラフの中に保存されている値(numCache・strCache。Excelは保存時に必ず書く)を使う。
 * 値が保存されていない(他のソフトで作ったファイル等)ときは、参照先のセル範囲(例: 'Sheet1'!$B$2:$B$7)を
 * 描画側でシートの値から読み直す(valuesRef・categoriesRef)。
 */

export type ChartKind = "bar" | "line" | "pie" | "doughnut" | "area" | "scatter";

export interface ChartTextStyle {
  /** pt。指定が無ければnull(描画側の既定) */
  sizePt: number | null;
  bold: boolean | null;
  color: string | null;
}

export interface ChartLine {
  /** null = 線なし(noFill)。undefined = 指定なし(既定の線) */
  color: string | null | undefined;
  widthPt: number | null;
  dash: "solid" | "dash" | "dot" | null;
}

export interface ChartMarker {
  symbol: "none" | "auto" | "circle" | "square" | "diamond" | "triangle" | "x" | "star" | "dot" | "dash" | "plus";
  sizePt: number | null;
  fill: string | null | undefined;
  line: string | null | undefined;
}

export interface ChartDataLabels {
  showVal: boolean;
  showPercent: boolean;
  showSerName: boolean;
  showCatName: boolean;
  position: "ctr" | "inEnd" | "inBase" | "outEnd" | "t" | "b" | "l" | "r" | "bestFit" | null;
  numFmt: string | null;
  separator: string | null;
  text: ChartTextStyle;
  /** このグラフで実際にラベルを出すか(どれかの表示項目がtrue) */
  any: boolean;
  /** 個別に消されたデータ点(dLbl/delete) */
  deletedPoints: Set<number>;
}

export interface ChartSeries {
  name: string | null;
  nameRef: string | null;
  categories: (string | number)[] | null;
  categoriesRef: string | null;
  /** 分類の値が数値で、日付などの表示形式が付いているとき */
  categoriesFormat: string | null;
  values: (number | null)[] | null;
  valuesRef: string | null;
  valuesFormat: string | null;
  /** 散布図のX値(xVal)。無ければ1,2,3… */
  xValues: (number | null)[] | null;
  xValuesRef: string | null;
  fill: string | null | undefined;
  line: ChartLine;
  marker: ChartMarker | null;
  smooth: boolean;
  /** 個別の色が付いたデータ点(dPt)。円グラフの扇形ごとの色など */
  pointFills: Map<number, string>;
  dataLabels: ChartDataLabels | null;
  /** 系列の並び順(order)と色の自動割り当て用の番号(idx) */
  order: number;
  idx: number;
}

export interface ChartGroup {
  kind: ChartKind;
  /** 棒グラフの向き: col=縦棒、bar=横棒 */
  barDir: "col" | "bar";
  grouping: "clustered" | "stacked" | "percentStacked" | "standard";
  varyColors: boolean;
  gapWidth: number;
  overlap: number;
  holeSize: number;
  firstSliceAngle: number;
  /** 折れ線グラフのマーカーの既定(lineChart/marker) */
  markerDefault: boolean;
  scatterStyle: string | null;
  catAxisId: string | null;
  valAxisId: string | null;
  series: ChartSeries[];
  dataLabels: ChartDataLabels | null;
}

export interface ChartAxis {
  id: string;
  kind: "cat" | "val" | "date";
  position: "b" | "l" | "r" | "t";
  deleted: boolean;
  title: { text: string; style: ChartTextStyle } | null;
  min: number | null;
  max: number | null;
  majorUnit: number | null;
  reversed: boolean;
  logScale: boolean;
  numFmt: string | null;
  /** 表示形式を元のセルに合わせる(sourceLinked) */
  numFmtLinked: boolean;
  majorGridlines: ChartLine | null;
  minorGridlines: ChartLine | null;
  tickLabelPosition: "nextTo" | "low" | "high" | "none";
  line: ChartLine;
  text: ChartTextStyle;
  crossAxisId: string | null;
  crosses: "autoZero" | "min" | "max";
  /** 値の軸の設定: between=分類の間(目盛りの間に点を置く)、midCat=目盛りの上。nullは種類ごとの既定 */
  crossBetween: "between" | "midCat" | null;
}

export interface ChartModel {
  title: { text: string | null; ref: string | null; style: ChartTextStyle; auto: boolean } | null;
  legend: { position: "r" | "l" | "t" | "b" | "tr"; overlay: boolean; text: ChartTextStyle; deletedEntries: Set<number> } | null;
  groups: ChartGroup[];
  axes: Map<string, ChartAxis>;
  background: string | null | undefined;
  border: ChartLine;
  plotBackground: string | null | undefined;
  plotBorder: ChartLine;
  /** プロットエリアの手動の位置(グラフ全体に対する割合) */
  plotLayout: { x: number; y: number; w: number; h: number } | null;
  /** グラフ全体の文字の既定(chartSpace/txPr) */
  text: ChartTextStyle;
  /** 空のセルの扱い: gap=線を切る、zero=0として描く、span=線をつなぐ */
  dispBlanksAs: "gap" | "zero" | "span";
  /** 再現していない装飾(近似曲線・誤差範囲・データテーブル・対数目盛り等)。警告に使う */
  unsupportedDecorations: string[];
  /** テーマのアクセント色1〜6(系列に色の指定が無いときに、Excelと同じ順で使う) */
  accents: string[];
}

export interface SheetChart {
  fromCol: number;
  fromRow: number;
  fromColOffPt: number;
  fromRowOffPt: number;
  toCol: number | null;
  toRow: number | null;
  toColOffPt: number;
  toRowOffPt: number;
  extWidthPt: number | null;
  extHeightPt: number | null;
  /** 読み取れたグラフ。読めない・対応していない種類のときはnullで、unsupportedReasonに理由 */
  model: ChartModel | null;
  unsupportedReason: string | null;
}

const EMU_PER_PT = 12700;
/** テーマが読めないときのアクセント色(Office 2013以降の既定のテーマ) */
const DEFAULT_ACCENTS = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];

// ---------------------------------------------------------------------------
// XMLの小さな道具(名前空間の接頭辞 c: a: に依存せず、ローカル名で探す)
// ---------------------------------------------------------------------------
function child(el: Element | null | undefined, local: string): Element | undefined {
  if (!el) return undefined;
  for (const c of Array.from(el.children)) if (c.localName === local) return c;
  return undefined;
}
function children(el: Element | null | undefined, local: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => c.localName === local);
}
function descendant(el: Element | null | undefined, local: string): Element | undefined {
  if (!el) return undefined;
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) if (all[i].localName === local) return all[i];
  return undefined;
}
function valOf(el: Element | null | undefined, local: string): string | null {
  return child(el, local)?.getAttribute("val") ?? null;
}
function boolVal(el: Element | null | undefined, local: string, dflt: boolean): boolean {
  const e = child(el, local);
  if (!e) return dflt;
  const v = e.getAttribute("val");
  // OOXMLの真偽値の要素は、val属性が無ければ true の意味
  return v === null ? true : v === "1" || v === "true";
}
function numVal(el: Element | null | undefined, local: string): number | null {
  const v = valOf(el, local);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 色(DrawingMLの色指定。テーマ色の明暗・透明度の指定を含む)
// ---------------------------------------------------------------------------
const SCHEME_INDEX: Record<string, number> = {
  lt1: 0, bg1: 0, dk1: 1, tx1: 1, lt2: 2, bg2: 2, dk2: 3, tx2: 3,
  accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11,
};
const PRESET_COLORS: Record<string, string> = {
  black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#008000", blue: "#0000FF", yellow: "#FFFF00",
  gray: "#808080", grey: "#808080", orange: "#FFA500", purple: "#800080", lightGray: "#D3D3D3", darkGray: "#A9A9A9",
};

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const x = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${x(r)}${x(g)}${x(b)}`;
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

/** 明度の変更(lumMod・lumOff)・濃淡(shade・tint)・透明度(alpha)を加味した色。透明度は白と混ぜて近似する */
export function adjustColor(hex: string, mods: { lumMod?: number; lumOff?: number; shade?: number; tint?: number; alpha?: number }): string {
  let [r, g, b] = hexToRgb(hex);
  if (mods.lumMod !== undefined || mods.lumOff !== undefined) {
    const [h, s, l] = rgbToHsl(r, g, b);
    [r, g, b] = hslToRgb(h, s, Math.min(1, Math.max(0, l * (mods.lumMod ?? 1) + (mods.lumOff ?? 0))));
  }
  if (mods.shade !== undefined) {
    r *= mods.shade;
    g *= mods.shade;
    b *= mods.shade;
  }
  if (mods.tint !== undefined) {
    r = r + (1 - r) * (1 - mods.tint);
    g = g + (1 - g) * (1 - mods.tint);
    b = b + (1 - b) * (1 - mods.tint);
  }
  if (mods.alpha !== undefined && mods.alpha < 1) {
    // PDFの透明度は使わず、白い背景の上の色として混ぜる(グラフの背景はほぼ白のため)
    r = r * mods.alpha + (1 - mods.alpha);
    g = g * mods.alpha + (1 - mods.alpha);
    b = b * mods.alpha + (1 - mods.alpha);
  }
  return rgbToHex(r, g, b);
}

function readColor(container: Element | undefined, theme: string[] | null): string | null {
  if (!container) return null;
  const colorEl = Array.from(container.children).find((c) => ["srgbClr", "schemeClr", "prstClr", "sysClr", "scrgbClr"].includes(c.localName));
  if (!colorEl) return null;
  let hex: string | null = null;
  switch (colorEl.localName) {
    case "srgbClr":
      hex = `#${(colorEl.getAttribute("val") ?? "000000").slice(-6)}`;
      break;
    case "schemeClr": {
      const idx = SCHEME_INDEX[colorEl.getAttribute("val") ?? ""];
      hex = idx !== undefined && theme ? (theme[idx] ?? null) : null;
      break;
    }
    case "prstClr":
      hex = PRESET_COLORS[colorEl.getAttribute("val") ?? ""] ?? null;
      break;
    case "sysClr":
      hex = `#${(colorEl.getAttribute("lastClr") ?? (colorEl.getAttribute("val") === "window" ? "FFFFFF" : "000000")).slice(-6)}`;
      break;
    case "scrgbClr": {
      const pct = (a: string) => Math.min(1, Math.max(0, Number(colorEl.getAttribute(a) ?? "0") / 100000));
      hex = rgbToHex(pct("r"), pct("g"), pct("b"));
      break;
    }
  }
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const mod = (local: string) => {
    const v = child(colorEl, local)?.getAttribute("val");
    return v !== null && v !== undefined ? Number(v) / 100000 : undefined;
  };
  return adjustColor(hex.toUpperCase(), { lumMod: mod("lumMod"), lumOff: mod("lumOff"), shade: mod("shade"), tint: mod("tint"), alpha: mod("alpha") });
}

/** spPr(図形の書式)の塗りつぶし。null=塗りなし、undefined=指定なし */
function readFill(spPr: Element | undefined, theme: string[] | null): string | null | undefined {
  if (!spPr) return undefined;
  if (child(spPr, "noFill")) return null;
  const solid = child(spPr, "solidFill");
  if (solid) return readColor(solid, theme) ?? undefined;
  const grad = child(spPr, "gradFill");
  if (grad) {
    // グラデーションは、最初の色で塗る(グラフの棒のグラデーションは細かい再現をしない)
    const gs = descendant(grad, "gs");
    return readColor(gs, theme) ?? undefined;
  }
  const patt = child(spPr, "pattFill");
  if (patt) return readColor(child(patt, "fgClr"), theme) ?? undefined;
  return undefined;
}

function readLine(spPr: Element | undefined, theme: string[] | null): ChartLine {
  const ln = child(spPr, "ln");
  if (!ln) return { color: undefined, widthPt: null, dash: null };
  const w = ln.getAttribute("w");
  const widthPt = w !== null ? Number(w) / EMU_PER_PT : null;
  const dashVal = valOf(ln, "prstDash");
  const dash = !dashVal || dashVal === "solid" ? (dashVal ? "solid" : null) : /dot/i.test(dashVal) && !/dash/i.test(dashVal) ? "dot" : "dash";
  if (child(ln, "noFill")) return { color: null, widthPt, dash };
  const solid = child(ln, "solidFill");
  const color = solid ? (readColor(solid, theme) ?? undefined) : undefined;
  return { color, widthPt: widthPt !== null && Number.isFinite(widthPt) ? widthPt : null, dash };
}

/** txPr・rich の最初の段落の文字の書式(defRPr / rPr) */
function readTextStyle(container: Element | undefined, theme: string[] | null): ChartTextStyle {
  const style: ChartTextStyle = { sizePt: null, bold: null, color: null };
  if (!container) return style;
  const rPr = descendant(container, "defRPr") ?? descendant(container, "rPr");
  const runPr = descendant(container, "rPr");
  for (const pr of [rPr, runPr]) {
    if (!pr) continue;
    const sz = pr.getAttribute("sz");
    if (sz !== null && Number(sz) > 0) style.sizePt = Number(sz) / 100;
    const b = pr.getAttribute("b");
    if (b !== null) style.bold = b === "1" || b === "true";
    const fill = child(pr, "solidFill");
    if (fill) style.color = readColor(fill, theme) ?? style.color;
  }
  return style;
}

function richText(tx: Element | undefined): string | null {
  const rich = child(tx, "rich");
  if (!rich) return null;
  const paras = children(rich, "p").map((p) =>
    Array.from(p.children)
      .filter((c) => c.localName === "r" || c.localName === "fld")
      .map((r) => child(r, "t")?.textContent ?? "")
      .join("")
  );
  return paras.join("\n");
}

// ---------------------------------------------------------------------------
// データ(numCache・strCache・参照)
// ---------------------------------------------------------------------------
function readCachePoints(cache: Element | undefined): { count: number; points: Map<number, string> } | null {
  if (!cache) return null;
  const count = numVal(cache, "ptCount") ?? 0;
  const points = new Map<number, string>();
  for (const pt of children(cache, "pt")) {
    const idx = Number(pt.getAttribute("idx") ?? "-1");
    const v = child(pt, "v")?.textContent;
    if (idx >= 0 && v !== undefined && v !== null) points.set(idx, v);
  }
  return { count: Math.max(count, points.size ? Math.max(...points.keys()) + 1 : 0), points };
}

interface DataSource {
  strings: (string | number)[] | null;
  numbers: (number | null)[] | null;
  ref: string | null;
  format: string | null;
}

/** <c:cat>・<c:val>・<c:xVal>・<c:yVal>・<c:tx> の中のデータ(参照＋保存された値、または直接の値) */
function readDataSource(el: Element | undefined): DataSource {
  const empty: DataSource = { strings: null, numbers: null, ref: null, format: null };
  if (!el) return empty;
  const numRef = child(el, "numRef");
  const strRef = child(el, "strRef");
  const multi = child(el, "multiLvlStrRef");
  const numLit = child(el, "numLit");
  const strLit = child(el, "strLit");
  const holder = numRef ?? strRef ?? multi;
  const ref = holder ? (child(holder, "f")?.textContent ?? null) : null;
  const numCache = child(numRef, "numCache") ?? numLit;
  const strCache = child(strRef, "strCache") ?? strLit;
  if (numCache) {
    const pts = readCachePoints(numCache);
    if (pts) {
      const numbers: (number | null)[] = [];
      for (let i = 0; i < pts.count; i++) {
        const v = pts.points.get(i);
        const n = v === undefined ? NaN : Number(v);
        numbers.push(Number.isFinite(n) ? n : null);
      }
      const format = child(numCache, "formatCode")?.textContent ?? null;
      return { strings: numbers.map((n) => (n === null ? "" : n)), numbers, ref, format: format && format !== "General" ? format : null };
    }
  }
  if (strCache) {
    const pts = readCachePoints(strCache);
    if (pts) {
      const strings: string[] = [];
      for (let i = 0; i < pts.count; i++) strings.push(pts.points.get(i) ?? "");
      const numbers = strings.map((s) => (s.trim() !== "" && Number.isFinite(Number(s)) ? Number(s) : null));
      return { strings, numbers, ref, format: null };
    }
  }
  if (multi) {
    // 複数レベルの分類は、いちばん下のレベル(最初のlvl)だけを使う
    const lvl = descendant(child(multi, "multiLvlStrCache"), "lvl");
    if (lvl) {
      const pts = readCachePoints(lvl);
      if (pts) {
        const strings: string[] = [];
        for (let i = 0; i < pts.count; i++) strings.push(pts.points.get(i) ?? "");
        return { strings, numbers: null, ref, format: null };
      }
    }
  }
  return { ...empty, ref };
}

function readSeriesName(ser: Element): { name: string | null; ref: string | null } {
  const tx = child(ser, "tx");
  if (!tx) return { name: null, ref: null };
  const v = child(tx, "v")?.textContent;
  if (v) return { name: v, ref: null };
  const src = readDataSource(tx);
  const first = src.strings?.[0];
  return { name: first !== undefined && first !== "" ? String(first) : null, ref: src.ref };
}

const MARKER_SYMBOLS = new Set(["none", "auto", "circle", "square", "diamond", "triangle", "x", "star", "dot", "dash", "plus"]);

function readMarker(el: Element | undefined, theme: string[] | null): ChartMarker | null {
  if (!el) return null;
  const sym = valOf(el, "symbol");
  const spPr = child(el, "spPr");
  return {
    symbol: sym && MARKER_SYMBOLS.has(sym) ? (sym as ChartMarker["symbol"]) : "auto",
    sizePt: numVal(el, "size"),
    fill: readFill(spPr, theme),
    line: readLine(spPr, theme).color,
  };
}

function readDataLabels(el: Element | undefined, theme: string[] | null): ChartDataLabels | null {
  if (!el) return null;
  if (boolVal(el, "delete", false)) {
    return { showVal: false, showPercent: false, showSerName: false, showCatName: false, position: null, numFmt: null, separator: null, text: readTextStyle(undefined, theme), any: false, deletedPoints: new Set() };
  }
  const labels: ChartDataLabels = {
    showVal: boolVal(el, "showVal", false),
    showPercent: boolVal(el, "showPercent", false),
    showSerName: boolVal(el, "showSerName", false),
    showCatName: boolVal(el, "showCatName", false),
    position: (valOf(el, "dLblPos") as ChartDataLabels["position"]) ?? null,
    numFmt: child(el, "numFmt")?.getAttribute("formatCode") ?? null,
    separator: child(el, "separator")?.textContent ?? null,
    text: readTextStyle(child(el, "txPr"), theme),
    any: false,
    deletedPoints: new Set(),
  };
  for (const d of children(el, "dLbl")) {
    if (boolVal(d, "delete", false)) labels.deletedPoints.add(Number(valOf(d, "idx") ?? "-1"));
  }
  labels.any = labels.showVal || labels.showPercent || labels.showSerName || labels.showCatName;
  return labels;
}

/** 対応する種類の要素名 → 種類 */
const SUPPORTED_GROUPS: Record<string, ChartKind> = {
  barChart: "bar",
  lineChart: "line",
  pieChart: "pie",
  doughnutChart: "doughnut",
  areaChart: "area",
  scatterChart: "scatter",
};
/** 対応しない種類の要素名 → 画面に出す名前 */
const UNSUPPORTED_GROUPS: Record<string, string> = {
  bar3DChart: "3-D 棒グラフ",
  line3DChart: "3-D 折れ線グラフ",
  pie3DChart: "3-D 円グラフ",
  area3DChart: "3-D 面グラフ",
  surfaceChart: "等高線グラフ",
  surface3DChart: "3-D 等高線グラフ",
  radarChart: "レーダーチャート",
  stockChart: "株価チャート",
  bubbleChart: "バブルチャート",
  ofPieChart: "補助円グラフ付き円グラフ",
};

function readAxis(el: Element, kind: ChartAxis["kind"], theme: string[] | null, unsupported: Set<string>): ChartAxis {
  const scaling = child(el, "scaling");
  const titleEl = child(el, "title");
  const titleText = titleEl ? richText(child(titleEl, "tx")) : null;
  const numFmtEl = child(el, "numFmt");
  const majorGrid = child(el, "majorGridlines");
  const minorGrid = child(el, "minorGridlines");
  const logBase = numVal(scaling, "logBase");
  if (logBase) unsupported.add("対数目盛り");
  const crossesVal = valOf(el, "crosses");
  return {
    id: valOf(el, "axId") ?? "",
    kind,
    position: (valOf(el, "axPos") as ChartAxis["position"]) ?? "b",
    deleted: boolVal(el, "delete", false),
    title: titleEl && titleText ? { text: titleText, style: readTextStyle(child(child(titleEl, "tx"), "rich"), theme) } : null,
    min: numVal(scaling, "min"),
    max: numVal(scaling, "max"),
    majorUnit: numVal(el, "majorUnit"),
    reversed: valOf(scaling, "orientation") === "maxMin",
    logScale: !!logBase,
    numFmt: numFmtEl?.getAttribute("formatCode") ?? null,
    numFmtLinked: numFmtEl ? numFmtEl.getAttribute("sourceLinked") === "1" : true,
    majorGridlines: majorGrid ? readLine(child(majorGrid, "spPr"), theme) : null,
    minorGridlines: minorGrid ? readLine(child(minorGrid, "spPr"), theme) : null,
    tickLabelPosition: (valOf(el, "tickLblPos") as ChartAxis["tickLabelPosition"]) ?? "nextTo",
    line: readLine(child(el, "spPr"), theme),
    text: readTextStyle(child(el, "txPr"), theme),
    crossAxisId: valOf(el, "crossAx"),
    crosses: crossesVal === "max" ? "max" : crossesVal === "min" ? "min" : "autoZero",
    crossBetween: valOf(el, "crossBetween") === "midCat" ? "midCat" : valOf(el, "crossBetween") === "between" ? "between" : null,
  };
}

function readSeries(ser: Element, kind: ChartKind, theme: string[] | null, unsupported: Set<string>): ChartSeries {
  const { name, ref } = readSeriesName(ser);
  const spPr = child(ser, "spPr");
  const cat = readDataSource(child(ser, kind === "scatter" ? "xVal" : "cat"));
  const val = readDataSource(child(ser, kind === "scatter" ? "yVal" : "val"));
  const pointFills = new Map<number, string>();
  for (const dPt of children(ser, "dPt")) {
    const idx = Number(valOf(dPt, "idx") ?? "-1");
    const fill = readFill(child(dPt, "spPr"), theme);
    if (idx >= 0 && fill) pointFills.set(idx, fill);
  }
  if (child(ser, "trendline")) unsupported.add("近似曲線");
  if (child(ser, "errBars")) unsupported.add("誤差範囲");
  return {
    name,
    nameRef: ref,
    categories: kind === "scatter" ? null : cat.strings,
    categoriesRef: kind === "scatter" ? null : cat.ref,
    categoriesFormat: kind === "scatter" ? null : cat.format,
    values: val.numbers,
    valuesRef: val.ref,
    valuesFormat: val.format,
    xValues: kind === "scatter" ? cat.numbers : null,
    xValuesRef: kind === "scatter" ? cat.ref : null,
    fill: readFill(spPr, theme),
    line: readLine(spPr, theme),
    marker: readMarker(child(ser, "marker"), theme),
    smooth: boolVal(ser, "smooth", false),
    pointFills,
    dataLabels: readDataLabels(child(ser, "dLbls"), theme),
    order: numVal(ser, "order") ?? 0,
    idx: numVal(ser, "idx") ?? 0,
  };
}

function readManualLayout(layout: Element | undefined): ChartModel["plotLayout"] {
  const ml = child(layout, "manualLayout");
  if (!ml) return null;
  const x = numVal(ml, "x");
  const y = numVal(ml, "y");
  const w = numVal(ml, "w");
  const h = numVal(ml, "h");
  // 割合(edge)の指定だけを使う(factorはExcelが自動で決めた位置からのずれなので、自動の配置に任せる)
  if (valOf(ml, "xMode") === "factor" || valOf(ml, "yMode") === "factor") return null;
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** chartN.xml の文字列から、グラフの定義を読む。対応していない種類は reason を返す */
export function parseChartXml(xmlText: string, theme: string[] | null): { model: ChartModel | null; reason: string | null } {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return { model: null, reason: "グラフの定義を読み取れない" };
  } catch {
    return { model: null, reason: "グラフの定義を読み取れない" };
  }
  const space = doc.documentElement;
  const chart = child(space, "chart");
  const plotArea = child(chart, "plotArea");
  if (!chart || !plotArea) return { model: null, reason: "グラフの定義を読み取れない" };
  const unsupported = new Set<string>();
  const groups: ChartGroup[] = [];
  for (const el of Array.from(plotArea.children)) {
    const unsupportedName = UNSUPPORTED_GROUPS[el.localName];
    if (unsupportedName) return { model: null, reason: unsupportedName };
    const kind = SUPPORTED_GROUPS[el.localName];
    if (!kind) continue;
    const grouping = valOf(el, "grouping");
    const axIds = children(el, "axId").map((a) => a.getAttribute("val") ?? "");
    const series = children(el, "ser")
      .map((ser) => readSeries(ser, kind, theme, unsupported))
      .sort((a, b) => a.order - b.order);
    const scatterStyle = valOf(el, "scatterStyle");
    groups.push({
      kind,
      barDir: valOf(el, "barDir") === "bar" ? "bar" : "col",
      grouping: grouping === "stacked" || grouping === "percentStacked" || grouping === "standard" ? grouping : kind === "bar" ? "clustered" : "standard",
      varyColors: boolVal(el, "varyColors", kind === "pie" || kind === "doughnut"),
      gapWidth: numVal(el, "gapWidth") ?? 150,
      overlap: numVal(el, "overlap") ?? (grouping === "stacked" || grouping === "percentStacked" ? 100 : 0),
      holeSize: numVal(el, "holeSize") ?? 50,
      firstSliceAngle: numVal(el, "firstSliceAng") ?? 0,
      markerDefault: boolVal(el, "marker", false),
      scatterStyle,
      catAxisId: axIds[0] ?? null,
      valAxisId: axIds[1] ?? null,
      series,
      dataLabels: readDataLabels(child(el, "dLbls"), theme),
    });
  }
  if (groups.length === 0) return { model: null, reason: "グラフの種類を判別できない" };
  if (groups.every((g) => g.series.length === 0)) return { model: null, reason: "データ系列が無い" };

  const axes = new Map<string, ChartAxis>();
  for (const el of Array.from(plotArea.children)) {
    const kind = el.localName === "catAx" ? "cat" : el.localName === "valAx" ? "val" : el.localName === "dateAx" ? "date" : null;
    if (!kind) continue;
    const axis = readAxis(el, kind, theme, unsupported);
    axes.set(axis.id, axis);
  }
  if (child(plotArea, "dTable")) unsupported.add("データテーブル");

  const titleEl = child(chart, "title");
  const autoTitleDeleted = boolVal(chart, "autoTitleDeleted", false);
  let title: ChartModel["title"] = null;
  if (titleEl) {
    const tx = child(titleEl, "tx");
    const text = richText(tx);
    const ref = tx && !text ? (readDataSource(tx).ref ?? null) : null;
    const cached = tx && !text ? readDataSource(tx).strings?.[0] : undefined;
    title = {
      text: text ?? (cached !== undefined && cached !== "" ? String(cached) : null),
      ref,
      style: readTextStyle(child(tx, "rich") ?? child(titleEl, "txPr"), theme),
      auto: !tx,
    };
  } else if (!autoTitleDeleted) {
    // タイトル要素が無くても、系列が1つだけのグラフは、Excelは系列名をタイトルとして表示する
    const allSeries = groups.flatMap((g) => g.series);
    if (allSeries.length === 1 && groups[0].kind !== "scatter") title = { text: null, ref: null, style: { sizePt: null, bold: null, color: null }, auto: true };
  }

  const legendEl = child(chart, "legend");
  const legend: ChartModel["legend"] = legendEl
    ? {
        position: ((valOf(legendEl, "legendPos") as "r" | "l" | "t" | "b" | "tr") ?? "r"),
        overlay: boolVal(legendEl, "overlay", false),
        text: readTextStyle(child(legendEl, "txPr"), theme),
        deletedEntries: new Set(
          children(legendEl, "legendEntry")
            .filter((e) => boolVal(e, "delete", false))
            .map((e) => Number(valOf(e, "idx") ?? "-1"))
        ),
      }
    : null;

  const spaceSpPr = child(space, "spPr");
  const plotSpPr = child(plotArea, "spPr");
  const blanks = valOf(chart, "dispBlanksAs");
  return {
    model: {
      title,
      legend,
      groups,
      axes,
      background: readFill(spaceSpPr, theme),
      border: readLine(spaceSpPr, theme),
      plotBackground: readFill(plotSpPr, theme),
      plotBorder: readLine(plotSpPr, theme),
      plotLayout: readManualLayout(child(plotArea, "layout")),
      text: readTextStyle(child(space, "txPr"), theme),
      dispBlanksAs: blanks === "zero" ? "zero" : blanks === "span" ? "span" : "gap",
      unsupportedDecorations: Array.from(unsupported),
      accents: [4, 5, 6, 7, 8, 9].map((i, n) => theme?.[i] ?? DEFAULT_ACCENTS[n]),
    },
    reason: null,
  };
}

/** graphicFrameの中身がグラフ(従来形式)か、Excel 2016以降の新しいグラフ(chartex)か */
export function graphicFrameChartKind(graphicFrame: Element): { kind: "chart"; rid: string } | { kind: "chartex" } | null {
  const graphicData = descendant(graphicFrame, "graphicData");
  const uri = graphicData?.getAttribute("uri") ?? "";
  if (uri.endsWith("/drawingml/2006/chart")) {
    const chartEl = descendant(graphicData, "chart");
    const rid = chartEl?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? chartEl?.getAttribute("r:id");
    return rid ? { kind: "chart", rid } : null;
  }
  if (/chartex/i.test(uri)) return { kind: "chartex" };
  // mc:AlternateContent の中に新しいグラフがある場合
  if (descendant(graphicFrame, "chart") && /chartex/i.test(graphicFrame.outerHTML ?? "")) return { kind: "chartex" };
  return null;
}

/** 'Sheet 1'!$B$2:$B$7 → { sheet: "Sheet 1", startRow: 1, startCol: 1, endRow: 6, endCol: 1 }(0始まり) */
export function parseRangeRef(ref: string): { sheet: string | null; startRow: number; startCol: number; endRow: number; endCol: number } | null {
  const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(ref.trim().replace(/^\(|\)$/g, ""));
  if (!m) return null;
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] ?? null);
  const col = (s: string) => s.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const startCol = col(m[3]);
  const startRow = Number(m[4]) - 1;
  const endCol = m[5] ? col(m[5]) : startCol;
  const endRow = m[6] ? Number(m[6]) - 1 : startRow;
  return { sheet, startRow: Math.min(startRow, endRow), startCol: Math.min(startCol, endCol), endRow: Math.max(startRow, endRow), endCol: Math.max(startCol, endCol) };
}

export { EMU_PER_PT as CHART_EMU_PER_PT };
