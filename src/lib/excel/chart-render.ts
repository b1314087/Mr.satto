import type { PDFPage } from "pdf-lib";
import type * as PdfLibTypes from "pdf-lib";
import { adjustColor, type ChartAxis, type ChartDataLabels, type ChartGroup, type ChartLine, type ChartModel, type ChartSeries } from "@/lib/excel/ooxml-charts";
import { formatExcelNumber, formatGeneralNumber } from "@/lib/excel/excel-number-format";
import { excelSerialToDate, formatExcelDate } from "@/lib/excel/excel-date-format";
import { planCategoryLabels, truncateText, type CategoryLabelPlan } from "@/lib/excel/chart-axis-labels";

/**
 * Excelのグラフ(ooxml-charts.ts で読んだ ChartModel)を、PDFのページに図形と文字で描く。
 *
 * 画像にせず、pdf-libの線・四角・パス・文字で描く(拡大しても粗くならず、PDFの文字として検索・選択できる)。
 * 配置(セルに対する位置・大きさ)・ページへのクリップ・印刷範囲との関係は、呼び出し側(excel-to-pdf.ts)が
 * 画像と同じ仕組みで決める。ここでは渡された四角の中に、タイトル・凡例・軸・目盛り・系列・データラベルを描く。
 *
 * Excel本体の描画と画素単位で一致はしない。種類・データの大きさの関係・色・位置関係が正しく伝わることを優先し、
 * 文字の大きさ・余白・目盛りの間隔は、Excelの既定(Office 2013以降のグラフのスタイル)に近い値を使う。
 */

export interface ChartTextApi {
  /** 文字列の幅(size は pt。ページの倍率をかけたあと) */
  width(text: string, size: number): number;
  /** (x, y)は文字列の左端のベースライン(PDFの座標)。angleDegは反時計回り */
  draw(page: PDFPage, text: string, x: number, y: number, size: number, color: string, bold: boolean, angleDeg?: number): void;
}

/**
 * セル範囲の参照(例: 'Sheet1'!$B$2:$B$7、名前の定義、別のブックの [1]Sheet1!…)の値。読めなければnull。
 * display は表示用の文字(書式済み)。visibleOnly=true なら、非表示の行・列のセルを除く(グラフの plotVisOnly)
 */
export type ChartRangeResolver = (
  ref: string,
  opts?: { visibleOnly?: boolean }
) => { values: (string | number | null)[]; display: string[]; /** 最初の値のあるセルの表示形式(日付の分類の判定に使う) */ format?: string | null } | null;

/** drawChart の結果(画面の注意書きに使う) */
export interface ChartDrawResult {
  /** 値の控えが無く、参照先も読めなかった(描けなかった)系列の数 */
  unresolvedSeries: number;
}

export interface ChartDrawOptions {
  page: PDFPage;
  lib: typeof PdfLibTypes;
  /** 描く四角(PDFの座標。x,yは左下) */
  box: { x: number; y: number; w: number; h: number };
  /** ページの倍率(拡大縮小)。文字の大きさ・線の太さにかける */
  scale: number;
  text: ChartTextApi;
  resolve: ChartRangeResolver;
  blackAndWhite: boolean;
}

const DEFAULT_TEXT_COLOR = "#595959";
const DEFAULT_LINE_COLOR = "#D9D9D9";
const DEFAULT_AXIS_LINE = "#BFBFBF";

// ---------------------------------------------------------------------------
// データの準備(保存された値が無ければ、参照先のセルから読む)
// ---------------------------------------------------------------------------
interface PreparedSeries {
  src: ChartSeries;
  group: ChartGroup;
  name: string;
  categories: string[];
  /** 分類の元の値(数値の分類・日付の分類のときの書式付けに使う) */
  rawCategories: (string | number)[];
  /** 分類の表示形式(値の控えの formatCode、無ければ参照先のセルの表示形式) */
  categoriesFormat: string | null;
  values: (number | null)[];
  xValues: (number | null)[] | null;
  color: string;
  lineColor: string | null;
  lineWidth: number;
  dash: ChartLine["dash"];
  marker: { symbol: string; size: number; fill: string | null; line: string | null } | null;
  labels: ChartDataLabels | null;
  /** グラフ全体の中での系列の番号(色の自動割り当て) */
  colorIndex: number;
}

function formatCategory(v: string | number, format: string | null): string {
  if (typeof v === "number") {
    if (format && /[ymdhs]|g{1,3}e/i.test(format.replace(/"[^"]*"/g, "")) && !/0\.?0*E[+-]/i.test(format)) {
      const d = excelSerialToDate(v);
      if (d) return formatExcelDate(d, format);
    }
    if (format) {
      const f = formatExcelNumber(v, format);
      if (f !== null) return f;
    }
    return formatGeneralNumber(v);
  }
  return v;
}

function formatValue(v: number, format: string | null): string {
  if (format && format !== "General") {
    const f = formatExcelNumber(v, format);
    if (f !== null) return f;
  }
  return formatGeneralNumber(Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(12)));
}

/** Excelの系列の自動の色: アクセント1〜6を順に使い、7番目以降は同じ順で濃く・明るくした色 */
function autoSeriesColor(model: ChartModel, index: number): string {
  const base = model.accents[index % 6] ?? "#4472C4";
  const cycle = Math.floor(index / 6) % 4;
  if (cycle === 1) return adjustColor(base, { lumMod: 0.6 });
  if (cycle === 2) return adjustColor(base, { lumMod: 0.8, lumOff: 0.2 });
  if (cycle === 3) return adjustColor(base, { lumMod: 0.8 });
  return base;
}

function mergeLabels(group: ChartDataLabels | null, series: ChartDataLabels | null): ChartDataLabels | null {
  if (series) return series;
  return group;
}

function prepareSeries(model: ChartModel, resolve0: ChartRangeResolver, stats: ChartDrawResult): PreparedSeries[] {
  const out: PreparedSeries[] = [];
  let colorIndex = 0;
  // 値の控えが無いときに参照先のセルから読む。Excelと同じく、既定(plotVisOnly)では非表示の行・列を除く
  const resolve = (ref: string) => resolve0(ref, { visibleOnly: model.plotVisOnly });
  for (const group of model.groups) {
    for (const s of group.series) {
      let values = s.values;
      if (!values && s.valuesRef) {
        const r = resolve(s.valuesRef);
        values = r ? r.values.map((v) => (typeof v === "number" ? v : v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null)) : null;
        if (!r) stats.unresolvedSeries++;
      }
      let rawCategories: (string | number)[] = s.categories ?? [];
      let categories: string[] = rawCategories.map((c) => formatCategory(c, s.categoriesFormat));
      let categoriesFormat = s.categoriesFormat;
      if (!s.categories && s.categoriesRef) {
        const r = resolve(s.categoriesRef);
        if (r) {
          rawCategories = r.values.map((v) => (v === null ? "" : v));
          categories = r.display;
          categoriesFormat = categoriesFormat ?? r.format ?? null;
        }
      }
      let xValues = s.xValues;
      if (!xValues && s.xValuesRef) {
        const r = resolve(s.xValuesRef);
        xValues = r ? r.values.map((v) => (typeof v === "number" ? v : null)) : null;
      }
      let name = s.name ?? "";
      if (!name && s.nameRef) name = resolve(s.nameRef)?.display[0] ?? "";
      if (!name) name = `系列${out.length + 1}`;
      const color = s.fill ?? autoSeriesColor(model, s.idx ?? colorIndex);
      const isLineLike = group.kind === "line" || group.kind === "scatter";
      const lineColor = s.line.color === null ? null : (s.line.color ?? (isLineLike ? autoSeriesColor(model, s.idx ?? colorIndex) : null));
      let marker: PreparedSeries["marker"] = null;
      if (isLineLike) {
        const symbolFromSeries = s.marker?.symbol;
        const scatterNoMarker = group.kind === "scatter" && (group.scatterStyle === "line" || group.scatterStyle === "smooth" || group.scatterStyle === "lineNoMarker");
        const show = symbolFromSeries ? symbolFromSeries !== "none" : group.kind === "line" ? group.markerDefault : !scatterNoMarker;
        if (show) {
          // マーカーの自動の色は、系列の自動の色(線の色)。系列の塗り(spPrのsolidFill)は棒・面の色で、マーカーには使わない
          const auto = lineColor ?? autoSeriesColor(model, s.idx ?? colorIndex);
          marker = {
            symbol: !symbolFromSeries || symbolFromSeries === "auto" ? "circle" : symbolFromSeries,
            size: s.marker?.sizePt ?? 5,
            fill: s.marker?.fill === null ? null : (s.marker?.fill ?? auto),
            line: s.marker?.line === null ? null : (s.marker?.line ?? auto),
          };
        }
      }
      out.push({
        src: s,
        group,
        name,
        categories,
        rawCategories,
        categoriesFormat,
        values: values ?? [],
        xValues,
        color,
        lineColor,
        lineWidth: s.line.widthPt ?? (isLineLike ? 2.25 : 0.75),
        dash: s.line.dash,
        marker,
        labels: mergeLabels(group.dataLabels, s.dataLabels),
        colorIndex: s.idx ?? colorIndex,
      });
      colorIndex++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 目盛り(Excelの自動の最小値・最大値・間隔に近い決め方)
// ---------------------------------------------------------------------------
function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

interface Scale {
  min: number;
  max: number;
  unit: number;
}

function computeScale(dataMin: number, dataMax: number, axis: ChartAxis | undefined, plotLenUnscaled: number, fixed?: { min: number; max: number }): Scale {
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 1;
  if (fixed) {
    lo = fixed.min;
    hi = fixed.max;
  }
  // Excelと同じく、データがすべて0以上で、最小値が最大値の5/6より小さいときは、0から始める(負の側も同様)
  if (!fixed) {
    if (lo >= 0 && lo < (hi * 5) / 6) lo = 0;
    else if (hi <= 0 && hi > (lo * 5) / 6) hi = 0;
  }
  if (axis?.min !== null && axis?.min !== undefined) lo = axis.min;
  if (axis?.max !== null && axis?.max !== undefined) hi = axis.max;
  if (hi <= lo) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
  // 目盛りの数の目安: プロットの長さ16ptあたり1本(Excelの既定の文字の大きさで、目盛りの文字が重ならない間隔)
  const target = Math.min(10, Math.max(3, Math.round(plotLenUnscaled / 16)));
  let range = hi - lo;
  // 最大値に少し余裕を持たせる(データの最大値が目盛りの上端に張り付かないように。Excelの自動の最大値と同じ考え方)
  const headroom = fixed || axis?.max !== null && axis?.max !== undefined ? 0 : range * 0.05;
  const footroom = fixed || axis?.min !== null && axis?.min !== undefined || lo >= 0 ? 0 : range * 0.05;
  range = hi + headroom - (lo - footroom);
  const unit = axis?.majorUnit && axis.majorUnit > 0 ? axis.majorUnit : niceStep(range / target);
  const min = axis?.min !== null && axis?.min !== undefined ? axis.min : fixed ? fixed.min : Math.floor((lo - footroom) / unit + 1e-9) * unit;
  const max = axis?.max !== null && axis?.max !== undefined ? axis.max : fixed ? fixed.max : Math.ceil((hi + headroom) / unit - 1e-9) * unit;
  return { min, max: max > min ? max : min + unit, unit };
}

function ticksOf(scale: Scale): number[] {
  const out: number[] = [];
  const n = Math.round((scale.max - scale.min) / scale.unit);
  if (!Number.isFinite(n) || n <= 0 || n > 200) return [scale.min, scale.max];
  for (let i = 0; i <= n; i++) out.push(Number((scale.min + i * scale.unit).toPrecision(12)));
  return out;
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------
export function drawChart(model: ChartModel, opts: ChartDrawOptions): ChartDrawResult {
  const result: ChartDrawResult = { unresolvedSeries: 0 };
  const { page, lib, box, scale: s, text, resolve, blackAndWhite } = opts;
  if (box.w <= 2 || box.h <= 2) return result;
  const X0 = box.x;
  const Y0 = box.y + box.h; // ローカル座標: 左上が原点、下向きが正
  const W = box.w;
  const H = box.h;

  const gray = (hex: string) => {
    const [r, g, b] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const h = l.toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  };
  const rgb = (hex: string) => {
    const h = blackAndWhite ? gray(hex) : hex;
    return lib.rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  };
  const dashArray = (dash: ChartLine["dash"], width: number): number[] | undefined =>
    dash === "dash" ? [width * 4, width * 3] : dash === "dot" ? [width, width * 2] : undefined;

  const rect = (x: number, y: number, w: number, h: number, fill: string | null, stroke: string | null, width = 0.75 * s, dash: ChartLine["dash"] = null, opacity: number | null = null) => {
    if (w <= 0 || h <= 0) return;
    page.drawRectangle({
      x: X0 + x,
      y: Y0 - y - h,
      width: w,
      height: h,
      ...(fill ? { color: rgb(fill), ...(opacity !== null ? { opacity } : {}) } : {}),
      ...(stroke ? { borderColor: rgb(stroke), borderWidth: width, borderDashArray: dashArray(dash, width) } : {}),
    });
  };
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number, dash: ChartLine["dash"] = null) => {
    page.drawLine({ start: { x: X0 + x1, y: Y0 - y1 }, end: { x: X0 + x2, y: Y0 - y2 }, thickness: width, color: rgb(color), dashArray: dashArray(dash, width) });
  };
  const path = (d: string, fill: string | null, stroke: string | null, width = 0.75 * s, dash: ChartLine["dash"] = null, opacity: number | null = null) => {
    if (!d) return;
    page.drawSvgPath(d, {
      x: X0,
      y: Y0,
      ...(fill ? { color: rgb(fill), ...(opacity !== null ? { opacity } : {}) } : {}),
      ...(stroke ? { borderColor: rgb(stroke), borderWidth: width, borderDashArray: dashArray(dash, width), borderLineCap: lib.LineCapStyle.Round } : {}),
    });
  };
  const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
  /** 文字を描く。yは文字の上端(ローカル座標)。alignは横の揃え。angleDegは反時計回り */
  const label = (str: string, x: number, yTop: number, size: number, color: string, bold: boolean, align: "left" | "center" | "right" = "left", angleDeg = 0) => {
    if (!str) return;
    const w = text.width(str, size);
    if (angleDeg === 0) {
      const lx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
      text.draw(page, str, X0 + lx, Y0 - yTop - size * 0.86, size, blackAndWhite ? "#000000" : color, bold);
    } else {
      // 回転した文字: (x, yTop)を文字列の終わり(右揃え)または中央とし、角度の向きへ並べる
      const rad = (angleDeg * Math.PI) / 180;
      const start = align === "right" ? -w : align === "center" ? -w / 2 : 0;
      const bx = x + start * Math.cos(rad) + size * 0.35 * Math.sin(rad);
      const by = yTop - start * Math.sin(rad) + size * 0.35 * Math.cos(rad);
      text.draw(page, str, X0 + bx, Y0 - by, size, blackAndWhite ? "#000000" : color, bold, angleDeg);
    }
  };

  // 文字列の幅は、同じ文字列・大きさなら1回だけ測る(項目名が数千ある分類の軸でも、測り直さない)
  const widthCache = new Map<string, number>();
  const tw = (str: string, size: number): number => {
    const key = `${size}\u0000${str}`;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = text.width(str, size);
      widthCache.set(key, w);
    }
    return w;
  };

  const baseSize = model.text.sizePt ?? 9;
  const textColor = model.text.color ?? DEFAULT_TEXT_COLOR;
  const sz = (style: { sizePt: number | null } | null | undefined, dflt: number) => (style?.sizePt ?? dflt) * s;

  // --- 背景・枠 ---
  const bg = model.background === undefined ? "#FFFFFF" : model.background;
  const border = model.border.color === undefined ? DEFAULT_LINE_COLOR : model.border.color;
  rect(0, 0, W, H, bg, border, (model.border.widthPt ?? 0.75) * s, model.border.dash);

  const series = prepareSeries(model, resolve, result);
  const pad = 7 * s;
  let top = pad;
  let bottom = H - pad;
  let left = pad;
  let right = W - pad;

  // --- タイトル ---
  if (model.title) {
    let titleText = model.title.text;
    if (!titleText && model.title.ref) titleText = resolve(model.title.ref)?.display[0] ?? null;
    if (!titleText && model.title.auto && series.length === 1) titleText = series[0].name;
    if (titleText) {
      top += 3 * s; // タイトルの上は、ほかの要素より少し広く空ける(Excelの既定の配置に近づける)
      const size = sz(model.title.style, baseSize * 1.55);
      const bold = model.title.style.bold ?? false;
      const color = model.title.style.color ?? textColor;
      for (const ln of titleText.split("\n")) {
        label(ln, W / 2, top, size, color, bold, "center");
        top += size * 1.25;
      }
      top += 3 * s;
    }
  }

  // --- 凡例 ---
  const isRound = model.groups.every((g) => g.kind === "pie" || g.kind === "doughnut");
  type LegendEntry = { name: string; color: string; kind: "box" | "line"; lineColor: string | null; marker: PreparedSeries["marker"]; alpha?: number | null };
  const legendEntries: LegendEntry[] = [];
  if (model.legend) {
    if (isRound && series.length > 0) {
      const s0 = series[0];
      s0.categories.forEach((c, i) => {
        if (model.legend!.deletedEntries.has(i)) return;
        legendEntries.push({ name: c || String(i + 1), color: pointColor(model, s0, i), kind: "box", lineColor: null, marker: null });
      });
    } else {
      series.forEach((p, i) => {
        if (model.legend!.deletedEntries.has(i)) return;
        const lineLike = p.group.kind === "line" || p.group.kind === "scatter";
        legendEntries.push({ name: p.name, color: p.color, kind: lineLike ? "line" : "box", lineColor: p.lineColor, marker: p.marker, alpha: p.src.fillAlpha });
      });
    }
  }
  // 縦に並べる凡例(右・左)は、積み上げのグラフと横棒グラフでは、Excelと同じく下から上の順(棒の積み重ねと同じ並び)にする
  const stackedOrBar = model.groups.some((g) => (g.kind === "bar" && (g.barDir === "bar" || g.grouping !== "clustered")) || (g.kind === "area" && g.grouping !== "standard"));
  if (!isRound && stackedOrBar && model.legend && model.legend.position !== "t" && model.legend.position !== "b") legendEntries.reverse();
  const legendSize = sz(model.legend?.text, baseSize);
  const legendColor = model.legend?.text.color ?? textColor;
  const swatchW = (e: LegendEntry) => (e.kind === "line" ? 18 * s : legendSize * 0.75);
  const entryW = (e: LegendEntry) => swatchW(e) + 4 * s + text.width(e.name, legendSize);
  const legendLineH = legendSize * 1.45;
  let legendDraw: (() => void) | null = null;
  if (model.legend && legendEntries.length > 0) {
    const pos = model.legend.position;
    const overlay = model.legend.overlay;
    if (pos === "r" || pos === "l" || pos === "tr") {
      const lw = Math.min((W - 2 * pad) * 0.45, Math.max(...legendEntries.map(entryW)) + 6 * s);
      const lh = legendEntries.length * legendLineH;
      const lx = pos === "l" ? left : right - lw;
      const lyTop = pos === "tr" ? top : top + Math.max(0, (bottom - top - lh) / 2);
      legendDraw = () => legendEntries.forEach((e, i) => drawLegendEntry(e, lx + 3 * s, lyTop + i * legendLineH));
      if (!overlay) {
        if (pos === "l") left += lw + 4 * s;
        else right -= lw + 4 * s;
      }
    } else {
      // 上下: 横に並べ、入りきらなければ折り返す
      const avail = right - left;
      const rows: LegendEntry[][] = [[]];
      let rowW = 0;
      for (const e of legendEntries) {
        const w = entryW(e) + 10 * s;
        if (rowW + w > avail && rows[rows.length - 1].length > 0) {
          rows.push([]);
          rowW = 0;
        }
        rows[rows.length - 1].push(e);
        rowW += w;
      }
      const lh = rows.length * legendLineH;
      const lyTop = pos === "t" ? top : bottom - lh;
      legendDraw = () =>
        rows.forEach((row, ri) => {
          const total = row.reduce((sum, e) => sum + entryW(e) + 10 * s, 0) - 10 * s;
          let x = left + (avail - total) / 2;
          for (const e of row) {
            drawLegendEntry(e, x, lyTop + ri * legendLineH);
            x += entryW(e) + 10 * s;
          }
        });
      if (!overlay) {
        if (pos === "t") top += lh + 4 * s;
        else bottom -= lh + 4 * s;
      }
    }
  }
  function drawLegendEntry(e: LegendEntry, x: number, yTop: number) {
    const cy = yTop + legendLineH / 2;
    if (e.kind === "line") {
      if (e.lineColor) line(x, cy, x + 18 * s, cy, e.lineColor, 2 * s);
      if (e.marker) drawMarker(e.marker, x + 9 * s, cy, s);
    } else {
      const b = legendSize * 0.75;
      rect(x, cy - b / 2, b, b, e.color, null, 0.75 * s, null, e.alpha ?? null);
    }
    label(e.name, x + swatchW(e) + 4 * s, cy - legendSize / 2, legendSize, legendColor, false);
  }

  function drawMarker(m: NonNullable<PreparedSeries["marker"]>, cx: number, cy: number, k: number) {
    const r = (m.size * k) / 2;
    const fill = m.fill;
    const stroke = m.line;
    const w = 0.75 * k;
    switch (m.symbol) {
      case "square":
        rect(cx - r, cy - r, 2 * r, 2 * r, fill, stroke, w);
        break;
      case "diamond":
        path(`M ${n2(cx)} ${n2(cy - r)} L ${n2(cx + r)} ${n2(cy)} L ${n2(cx)} ${n2(cy + r)} L ${n2(cx - r)} ${n2(cy)} Z`, fill, stroke, w);
        break;
      case "triangle":
        path(`M ${n2(cx)} ${n2(cy - r)} L ${n2(cx + r)} ${n2(cy + r)} L ${n2(cx - r)} ${n2(cy + r)} Z`, fill, stroke, w);
        break;
      case "x":
      case "star":
      case "plus":
        if (stroke ?? fill) {
          const c = (stroke ?? fill)!;
          if (m.symbol !== "plus") {
            line(cx - r, cy - r, cx + r, cy + r, c, w * 1.4);
            line(cx - r, cy + r, cx + r, cy - r, c, w * 1.4);
          }
          if (m.symbol !== "x") {
            line(cx - r, cy, cx + r, cy, c, w * 1.4);
            line(cx, cy - r, cx, cy + r, c, w * 1.4);
          }
        }
        break;
      case "dash":
        if (stroke ?? fill) line(cx - r, cy, cx + r, cy, (stroke ?? fill)!, w * 2);
        break;
      case "dot":
        page.drawCircle({ x: X0 + cx, y: Y0 - cy, size: Math.max(0.8 * k, r / 2), ...(fill ?? stroke ? { color: rgb((fill ?? stroke)!) } : {}) });
        break;
      default:
        page.drawCircle({
          x: X0 + cx,
          y: Y0 - cy,
          size: r,
          ...(fill ? { color: rgb(fill) } : {}),
          ...(stroke ? { borderColor: rgb(stroke), borderWidth: w } : {}),
        });
    }
  }

  // --- データラベルの文字 ---
  const labelText = (p: PreparedSeries, i: number, value: number | null, percent: number | null): string => {
    const l = p.labels;
    if (!l || !l.any || l.deletedPoints.has(i)) return "";
    // 点ごとの設定(dLbl)：文字を直接入力したラベルはその文字、表示する項目の指定があればそれを使う
    const pt = l.points.get(i);
    if (pt?.text) return pt.text;
    const f = pt ?? l;
    const parts: string[] = [];
    if (f.showSerName) parts.push(p.name);
    if (f.showCatName) parts.push(p.group.kind === "scatter" ? formatValue(p.xValues?.[i] ?? i + 1, null) : (p.categories[i] ?? ""));
    if (f.showVal && value !== null) parts.push(formatValue(value, l.numFmt && l.numFmt !== "General" ? l.numFmt : p.src.valuesFormat));
    if (f.showPercent && percent !== null) parts.push(formatValue(percent, l.numFmt && /%/.test(l.numFmt) ? l.numFmt : "0%"));
    return parts.join(l.separator ?? ", ");
  };

  // ==========================================================================
  // 円・ドーナツ
  // ==========================================================================
  if (isRound) {
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const anyOutside = series.some((p) => p.labels?.any && (p.labels.position === "outEnd" || p.labels.position === "bestFit" || p.labels.position === null));
    const radius = Math.max(4, (Math.min(right - left, bottom - top) / 2) * (anyOutside ? 0.78 : 0.92));
    const group = model.groups[0];
    const rings = group.kind === "doughnut" ? series : series.slice(0, 1);
    const hole = group.kind === "doughnut" ? Math.min(0.9, Math.max(0.1, group.holeSize / 100)) : 0;
    const ringW = rings.length > 0 ? (radius * (1 - hole)) / rings.length : radius;
    rings.forEach((p, ri) => {
      const outer = radius - ri * ringW;
      const inner = group.kind === "doughnut" ? outer - ringW : 0;
      const vals = p.values.map((v) => (v !== null && v > 0 ? v : 0));
      const total = vals.reduce((a, b) => a + b, 0);
      if (total <= 0) return;
      let angle = group.firstSliceAngle; // 12時の位置から時計回り(度)
      vals.forEach((v, i) => {
        if (v <= 0) return;
        const sweep = (v / total) * 360;
        const color = pointColor(model, p, i);
        path(slicePath(cx, cy, outer, inner, angle, angle + sweep), color, "#FFFFFF", 1 * s);
        const mid = angle + sweep / 2;
        const t = labelText(p, i, p.values[i], v / total);
        if (t) {
          const size = sz(p.labels?.points.get(i)?.style ?? p.labels?.text, baseSize);
          const pos = p.labels?.points.get(i)?.position ?? p.labels?.position ?? "bestFit";
          const inside = pos === "ctr" || pos === "inEnd" || (pos === "bestFit" && sweep > 25 && inner === 0) || group.kind === "doughnut";
          const rr = inside ? (inner > 0 ? (outer + inner) / 2 : pos === "inEnd" ? outer * 0.8 : outer * 0.62) : outer + size * 0.9;
          const rad = ((mid - 90) * Math.PI) / 180;
          const lx = cx + Math.cos(rad) * rr;
          const ly = cy + Math.sin(rad) * rr;
          const color2 = p.labels?.text.color ?? (inside ? contrastText(color) : textColor);
          const align = inside ? "center" : Math.cos(rad) >= 0 ? "left" : "right";
          label(t, lx + (align === "left" ? 2 * s : align === "right" ? -2 * s : 0), ly - size / 2, size, color2, p.labels?.text.bold ?? false, align);
        }
        angle += sweep;
      });
    });
    legendDraw?.();
    return result;
  }

  // ==========================================================================
  // 軸のあるグラフ(棒・折れ線・面・散布図、およびその組み合わせ)
  // ==========================================================================
  const horizontalBars = model.groups.some((g) => g.kind === "bar" && g.barDir === "bar");
  const isScatter = model.groups.some((g) => g.kind === "scatter");
  const nonScatter = series.filter((p) => p.group.kind !== "scatter");
  const catCount = Math.max(0, ...series.map((p) => Math.max(p.values.length, p.categories.length)));
  const categories: string[] = [];
  const catSource = nonScatter.find((p) => p.categories.length > 0);
  const catAxis0 = model.axes.get(model.groups[0].catAxisId ?? "");
  // 分類の軸に、セルと連動しない表示形式(sourceLinked=0)が指定されていれば、数値・日付の分類はその形式で表示する
  const catAxisFmt = catAxis0 && !catAxis0.numFmtLinked && catAxis0.numFmt && catAxis0.numFmt !== "General" ? catAxis0.numFmt : null;
  for (let i = 0; i < catCount; i++) {
    const raw = catSource?.rawCategories[i];
    categories.push(catAxisFmt && typeof raw === "number" ? formatCategory(raw, catAxisFmt) : (catSource?.categories[i] ?? String(i + 1)));
  }

  // 日付の軸：分類が日付(日付の表示形式の数値)で、日付の軸(dateAx)または「自動で判断」(auto)のとき、
  // Excelと同じく日付の間隔どおりに並べる(データの無い日・月も、間を空ける)
  const dateSlots = (() => {
    if (isScatter || !catAxis0 || !catSource) return null;
    if (catAxis0.kind !== "date" && !catAxis0.auto) return null;
    const raws = catSource.rawCategories.slice(0, catCount);
    if (raws.length === 0 || raws.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
    const fmt = catSource.categoriesFormat;
    const dateLike = (f: string | null) => !!f && /[ymd]/i.test(f.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/0\.?0*E[+-]/i.test(f);
    if (catAxis0.kind !== "date" && !dateLike(fmt)) return null;
    const nums = raws as number[];
    const dates = nums.map((v) => excelSerialToDate(Math.floor(v)));
    if (dates.some((d) => !d)) return null;
    const allFirst = dates.every((d) => d!.getDate() === 1);
    const unit = catAxis0.baseTimeUnit ?? (allFirst && new Set(dates.map((d) => d!.getFullYear() * 12 + d!.getMonth())).size === dates.length ? "months" : "days");
    const keyOf = (v: number, d: Date) => (unit === "days" ? Math.floor(v) : unit === "months" ? d.getFullYear() * 12 + d.getMonth() : d.getFullYear());
    const keys = nums.map((v, i) => keyOf(v, dates[i]!));
    const minKey = Math.min(...keys);
    const count = Math.max(...keys) - minKey + 1;
    if (!(count >= 1) || count > 5000) return null;
    const serialOfSlot = (k: number): number => {
      if (unit === "days") return minKey + k;
      const y = unit === "months" ? Math.floor((minKey + k) / 12) : minKey + k;
      const m = unit === "months" ? (minKey + k) % 12 : 0;
      return Math.round((Date.UTC(y, m, 1) - Date.UTC(1899, 11, 30)) / 86_400_000);
    };
    const labelFmt = catAxisFmt ?? fmt ?? (unit === "days" ? "m/d" : "yyyy/m");
    return { index: keys.map((k) => k - minKey), count, unit, serialOfSlot, labelFmt, majorUnit: catAxis0.majorUnit };
  })();

  // 値の軸ごとに、対象のグループと範囲を求める
  const valAxisIds = Array.from(new Set(model.groups.map((g) => g.valAxisId ?? "")));
  const axisOf = (id: string | null) => (id ? model.axes.get(id) : undefined);
  const primaryValId = valAxisIds[0];
  const secondaryValId = valAxisIds.find((id) => id !== primaryValId && axisOf(id)?.position !== axisOf(primaryValId)?.position) ?? valAxisIds[1];
  const percentAxis = (id: string) => model.groups.some((g) => (g.valAxisId ?? "") === id && g.grouping === "percentStacked");

  const stackedValue = (g: ChartGroup, p: PreparedSeries, i: number): { base: number; end: number } | null => {
    const v = p.values[i];
    if (v === null || v === undefined) return null;
    if (g.grouping !== "stacked" && g.grouping !== "percentStacked") return { base: 0, end: v };
    const members = series.filter((q) => q.group === g);
    let total = 0;
    if (g.grouping === "percentStacked") for (const q of members) total += Math.abs(q.values[i] ?? 0);
    let pos = 0;
    let neg = 0;
    for (const q of members) {
      const raw = q.values[i] ?? 0;
      const val = g.grouping === "percentStacked" ? (total > 0 ? raw / total : 0) : raw;
      if (q === p) return val >= 0 ? { base: pos, end: pos + val } : { base: neg, end: neg + val };
      if (val >= 0) pos += val;
      else neg += val;
    }
    return null;
  };

  const rangeFor = (id: string): { min: number; max: number } => {
    let min = Infinity;
    let max = -Infinity;
    for (const g of model.groups) {
      if ((g.valAxisId ?? "") !== id) continue;
      for (const p of series.filter((q) => q.group === g)) {
        for (let i = 0; i < p.values.length; i++) {
          const r = g.kind === "scatter" ? (p.values[i] === null ? null : { base: p.values[i]!, end: p.values[i]! }) : stackedValue(g, p, i);
          if (!r) continue;
          min = Math.min(min, r.base, r.end);
          max = Math.max(max, r.base, r.end);
        }
      }
    }
    if (!Number.isFinite(min)) return { min: 0, max: 1 };
    return { min, max };
  };

  // 散布図の横(X)の値の範囲
  let xRange = { min: Infinity, max: -Infinity };
  if (isScatter) {
    for (const p of series.filter((q) => q.group.kind === "scatter")) {
      p.values.forEach((_, i) => {
        const x = p.xValues?.[i] ?? i + 1;
        if (x === null) return;
        xRange = { min: Math.min(xRange.min, x), max: Math.max(xRange.max, x) };
      });
    }
    if (!Number.isFinite(xRange.min)) xRange = { min: 0, max: 1 };
  }

  const valAxisFmt = (id: string): string | null => {
    const a = axisOf(id);
    if (percentAxis(id)) return a && !a.numFmtLinked && a.numFmt && a.numFmt !== "General" ? a.numFmt : "0%";
    if (a && (!a.numFmtLinked || !series.some((p) => (p.group.valAxisId ?? "") === id && p.src.valuesFormat)) && a.numFmt && a.numFmt !== "General") return a.numFmt;
    return series.find((p) => (p.group.valAxisId ?? "") === id)?.src.valuesFormat ?? null;
  };

  const tickSize = (a: ChartAxis | undefined) => sz(a?.text, baseSize);
  const titleSize = (a: ChartAxis | undefined) => sz(a?.title?.style, baseSize * 1.1);

  // まず仮のプロット領域で目盛りを決め、目盛りの文字の幅・高さから領域を決め直す
  const primaryAxis = axisOf(primaryValId);
  const secondaryAxis = secondaryValId ? axisOf(secondaryValId) : undefined;
  const catAxis = axisOf(model.groups[0].catAxisId);
  const valVisible = (a: ChartAxis | undefined) => !!a && !a.deleted && a.tickLabelPosition !== "none";
  const catVisible = !!catAxis && !catAxis.deleted && catAxis.tickLabelPosition !== "none";

  const plotGuess = { w: (right - left) / s, h: (bottom - top) / s };
  const valLen = horizontalBars ? plotGuess.w : plotGuess.h;
  const scaleFor = (id: string): Scale => {
    const r = rangeFor(id);
    // 横向きの値の軸(横棒)は、目盛りの文字が横に並ぶので、縦の軸より間隔を広く(約40ptに1本)する
    const len = horizontalBars ? (valLen * 0.85 * 16) / 40 : valLen * 0.85;
    return computeScale(r.min, r.max, axisOf(id), len, percentAxis(id) ? { min: r.min < 0 ? -1 : 0, max: 1 } : undefined);
  };
  const primaryScale = scaleFor(primaryValId);
  const secondaryScale = secondaryValId ? scaleFor(secondaryValId) : null;
  const xScale = isScatter ? computeScale(xRange.min, xRange.max, catAxis, (plotGuess.w * 0.85 * 16) / 40) : null;

  const valLabels = (sc: Scale, id: string) => ticksOf(sc).map((t) => formatValue(t, valAxisFmt(id)));
  const primaryLabels = valLabels(primaryScale, primaryValId);
  const secondaryLabels = secondaryScale && secondaryValId ? valLabels(secondaryScale, secondaryValId) : [];
  const xLabels = xScale ? ticksOf(xScale).map((t) => formatValue(t, catAxis && catAxis.numFmt && !catAxis.numFmtLinked ? catAxis.numFmt : (series[0]?.src.categoriesFormat ?? null))) : [];

  // 余白の確保(手動の配置が無いとき)
  const primaryTickW = valVisible(primaryAxis) ? Math.max(0, ...primaryLabels.map((t) => text.width(t, tickSize(primaryAxis)))) : 0;
  const secondaryTickW = valVisible(secondaryAxis) ? Math.max(0, ...secondaryLabels.map((t) => text.width(t, tickSize(secondaryAxis)))) : 0;
  const catTickSize = tickSize(catAxis);
  // 日付の軸の目盛りの文字(基本単位ごと。間引きは描くときに決める)
  const dateLabelOf = (k: number) => (dateSlots ? formatCategory(dateSlots.serialOfSlot(k), dateSlots.labelFmt) : "");
  const dateLabelSamples = dateSlots ? [0, Math.floor(dateSlots.count / 2), dateSlots.count - 1].map(dateLabelOf) : [];
  const catLabels = isScatter ? xLabels : dateSlots ? dateLabelSamples : categories;
  const catMaxW = catVisible ? Math.max(0, ...catLabels.map((t) => tw(t, catTickSize))) : 0;
  // 分類の項目名の並べ方(横書き・折り返し・斜め・間引き)。散布図(数値の目盛り)と日付の軸は別に扱う
  const usesCatPlan = catVisible && !isScatter && !dateSlots;
  const catSlotCount = Math.max(1, catCount);
  const makeCatPlan = (axisLen: number, maxExtent: number): CategoryLabelPlan =>
    planCategoryLabels({
      labels: categories,
      slotLen: axisLen / catSlotCount,
      size: catTickSize,
      width: (t) => tw(t, catTickSize),
      maxExtent,
      axis: horizontalBars ? "y" : "x",
      explicitSkip: catAxis?.labelSkip ?? null,
      explicitAngle: catAxis?.labelAngle ?? null,
    });
  let catPlan: CategoryLabelPlan | null = null;

  // 分類の軸が値の軸と交わる値(Excelの「横軸との交点」)。棒はこの値から伸び、分類の軸の線もここに引く
  const crossValueOn = (sc: Scale, a: ChartAxis | undefined): number => {
    const clamp = (v: number) => Math.min(sc.max, Math.max(sc.min, v));
    if (a?.crossesAt !== null && a?.crossesAt !== undefined) return clamp(a.crossesAt);
    if (a?.crosses === "max") return sc.max;
    if (a?.crosses === "min") return sc.min;
    return clamp(0);
  };
  const catCross = crossValueOn(primaryScale, catAxis);
  // 分類の軸の文字の位置: low=下端(左端)、high=上端(右端)、nextTo=軸の線のそば(軸が上端なら外側の上、途中なら線のすぐ下)
  const catAtMax = (catCross >= primaryScale.max) !== !!primaryAxis?.reversed;
  const catAtMin = (catCross <= primaryScale.min) !== !!primaryAxis?.reversed;
  const catLabelWhere: "low" | "high" | "axis" =
    isScatter || !catAxis
      ? "low"
      : catAxis.tickLabelPosition === "low"
        ? "low"
        : catAxis.tickLabelPosition === "high"
          ? "high"
          : catAtMax
            ? "high"
            : catAtMin
              ? "low"
              : "axis";

  let plot: { x: number; y: number; w: number; h: number };
  if (model.plotLayout) {
    plot = { x: model.plotLayout.x * W, y: model.plotLayout.y * H, w: model.plotLayout.w * W, h: model.plotLayout.h * H };
    if (usesCatPlan) {
      catPlan = horizontalBars
        ? makeCatPlan(plot.h, Math.max(catTickSize * 2, plot.x - 6 * s))
        : makeCatPlan(plot.w, Math.max(catTickSize * 1.6, H - (plot.y + plot.h) - 4 * s));
    }
  } else {
    let pl = left;
    let pr = right;
    let pt = top + 4 * s;
    let pb = bottom;
    if (horizontalBars) {
      // 横棒: 値は下、分類は左(軸が右端で交わるときは右)。項目名の幅は、グラフの幅の4割まで(長ければ折り返し・「…」)
      if (valVisible(primaryAxis)) pb -= tickSize(primaryAxis) * 1.5;
      if (secondaryAxis && valVisible(secondaryAxis)) pt += tickSize(secondaryAxis) * 1.5;
      if (primaryAxis?.title) pb -= titleSize(primaryAxis) * 1.5;
      if (catAxis?.title) pl += titleSize(catAxis) * 1.5;
      const catW = usesCatPlan ? (catPlan = makeCatPlan(pb - pt, (right - left) * 0.4)).extent : Math.min((right - left) * 0.4, catMaxW);
      if (catVisible && catLabelWhere === "low") pl += catW + 5 * s;
      if (catVisible && catLabelWhere === "high") pr -= catW + 5 * s;
    } else {
      if (valVisible(primaryAxis)) pl += primaryTickW + 5 * s;
      if (secondaryAxis && valVisible(secondaryAxis)) pr -= secondaryTickW + 5 * s;
      if (primaryAxis?.title) pl += titleSize(primaryAxis) * 1.5;
      if (secondaryAxis?.title) pr -= titleSize(secondaryAxis) * 1.5;
      if (catAxis?.title) pb -= titleSize(catAxis) * 1.5;
      if (catVisible) {
        // 項目名の領域は、グラフの高さの35%まで(それより長い項目名は「…」で切る)
        if (usesCatPlan) catPlan = makeCatPlan(pr - pl, Math.max(catTickSize * 1.6, (bottom - top) * 0.35));
        const need = catPlan ? catPlan.extent + 3 * s : catTickSize * 1.6;
        if (catLabelWhere === "high") pt += need;
        else if (catLabelWhere === "low") pb -= need;
      }
    }
    plot = { x: pl, y: pt, w: Math.max(10, pr - pl), h: Math.max(10, pb - pt) };
  }

  // プロットエリア
  const plotFill = model.plotBackground === undefined ? null : model.plotBackground;
  const plotStroke = model.plotBorder.color === undefined ? null : model.plotBorder.color;
  if (plotFill || plotStroke) rect(plot.x, plot.y, plot.w, plot.h, plotFill, plotStroke, (model.plotBorder.widthPt ?? 0.75) * s);

  // 位置の変換
  const valToPos = (sc: Scale, v: number, axis: ChartAxis | undefined): number => {
    const t = (v - sc.min) / (sc.max - sc.min);
    const tt = axis?.reversed ? 1 - t : t;
    return horizontalBars ? plot.x + tt * plot.w : plot.y + plot.h - tt * plot.h;
  };
  const anyBarOrLine = model.groups.some((g) => g.kind === "bar" || g.kind === "line");
  const between = (primaryAxis?.crossBetween ?? (anyBarOrLine ? "between" : "midCat")) === "between" || model.groups.some((g) => g.kind === "bar");
  const catReversed = catAxis?.reversed ?? false;
  const slotCount = Math.max(1, dateSlots ? dateSlots.count : catCount);
  const catCenter = (i: number): number => {
    const len = horizontalBars ? plot.h : plot.w;
    const si = dateSlots ? (dateSlots.index[i] ?? i) : i;
    const k = catReversed ? slotCount - 1 - si : si;
    const t = between ? (k + 0.5) / slotCount : slotCount === 1 ? 0.5 : k / (slotCount - 1);
    // 横棒は、最初の分類を下に置く(Excelの既定)
    return horizontalBars ? plot.y + plot.h - t * len : plot.x + t * len;
  };
  const slotLen = (horizontalBars ? plot.h : plot.w) / slotCount;
  /** 日付の軸の k 番目の単位(日・月)の中心の位置 */
  const slotCenter = (k: number): number => {
    const len = horizontalBars ? plot.h : plot.w;
    const kk = catReversed ? slotCount - 1 - k : k;
    const t = between ? (kk + 0.5) / slotCount : slotCount === 1 ? 0.5 : kk / (slotCount - 1);
    return horizontalBars ? plot.y + plot.h - t * len : plot.x + t * len;
  };
  /** 日付の軸の目盛りの文字の間隔(単位の数)。指定(majorUnit)があればそれ以上、文字が重ならない間隔に広げる */
  const dateLabelStep = (labelLen: number): number => {
    const need = Math.max(1, Math.ceil(labelLen / Math.max(0.1, slotLen)));
    const unit = dateSlots?.majorUnit && dateSlots.majorUnit > 0 ? Math.round(dateSlots.majorUnit) : 1;
    return Math.max(unit, Math.ceil(need / unit) * unit);
  };
  const xToPos = (x: number) => {
    if (!xScale) return plot.x;
    const t = (x - xScale.min) / (xScale.max - xScale.min);
    return plot.x + (catAxis?.reversed ? 1 - t : t) * plot.w;
  };

  // 目盛線(補助→主)
  const gridColor = (g: ChartLine | null) => (g ? (g.color === undefined ? DEFAULT_LINE_COLOR : g.color) : null);
  const drawValGrid = (sc: Scale, axis: ChartAxis | undefined) => {
    if (!axis) return;
    const ticks = ticksOf(sc);
    const minor = gridColor(axis.minorGridlines);
    if (minor && ticks.length > 1) {
      for (let i = 0; i < ticks.length - 1; i++) {
        for (let k = 1; k < 5; k++) {
          const v = ticks[i] + ((ticks[i + 1] - ticks[i]) * k) / 5;
          const p = valToPos(sc, v, axis);
          if (horizontalBars) line(p, plot.y, p, plot.y + plot.h, minor, 0.4 * s);
          else line(plot.x, p, plot.x + plot.w, p, minor, 0.4 * s);
        }
      }
    }
    const major = gridColor(axis.majorGridlines);
    if (major) {
      const w = (axis.majorGridlines?.widthPt ?? 0.75) * s;
      for (const t of ticks) {
        const p = valToPos(sc, t, axis);
        if (horizontalBars) line(p, plot.y, p, plot.y + plot.h, major, w, axis.majorGridlines?.dash ?? null);
        else line(plot.x, p, plot.x + plot.w, p, major, w, axis.majorGridlines?.dash ?? null);
      }
    }
  };
  drawValGrid(primaryScale, primaryAxis);
  if (isScatter && xScale && catAxis) {
    const major = gridColor(catAxis.majorGridlines);
    if (major) for (const t of ticksOf(xScale)) line(xToPos(t), plot.y, xToPos(t), plot.y + plot.h, major, 0.75 * s);
  } else if (catAxis) {
    const major = gridColor(catAxis.majorGridlines);
    if (major) {
      for (let i = 0; i <= slotCount; i++) {
        const p = (horizontalBars ? plot.y : plot.x) + (i * (horizontalBars ? plot.h : plot.w)) / slotCount;
        if (horizontalBars) line(plot.x, p, plot.x + plot.w, p, major, 0.75 * s);
        else line(p, plot.y, p, plot.y + plot.h, major, 0.75 * s);
      }
    }
  }

  // ---- 系列の描画(面 → 棒 → 折れ線・散布図の順。Excelと同じく、線は面や棒の上に描く) ----
  type PendingLabel = { text: string; x: number; y: number; size: number; color: string; bold: boolean; align: "left" | "center" | "right" };
  const pendingLabels: PendingLabel[] = [];
  const pushLabel = (p: PreparedSeries, str: string, x: number, yCenter: number, align: "left" | "center" | "right", onFill: string | null, i?: number) => {
    if (!str) return;
    const style = (i !== undefined ? p.labels?.points.get(i)?.style : undefined) ?? p.labels?.text;
    const size = sz(style, baseSize);
    const color = style?.color ?? (onFill ? contrastText(onFill) : textColor);
    pendingLabels.push({ text: str, x, y: yCenter - size / 2, size, color, bold: style?.bold ?? false, align });
  };
  /** データ点のラベルの位置(点ごとの指定 → 系列・グループの指定) */
  const labelPosOf = (p: PreparedSeries, i: number) => p.labels?.points.get(i)?.position ?? p.labels?.position ?? null;
  const scaleOfGroup = (g: ChartGroup) => ((g.valAxisId ?? "") === secondaryValId && secondaryScale ? secondaryScale : primaryScale);
  const axisOfGroup = (g: ChartGroup) => ((g.valAxisId ?? "") === secondaryValId && secondaryAxis ? secondaryAxis : primaryAxis);
  const pointsLimit = 4000; // データ点が極端に多いときは、ラベル・マーカーを省いて固まりにくくする

  const order: ChartGroup["kind"][] = ["area", "bar", "line", "scatter"];
  for (const kind of order) {
    for (const g of model.groups.filter((gg) => gg.kind === kind)) {
      const members = series.filter((p) => p.group === g);
      const sc = scaleOfGroup(g);
      const ax = axisOfGroup(g);

      if (kind === "area") {
        // 積み上げの面は、下の系列から順に塗る
        for (const p of members) {
          const top2: [number, number][] = [];
          const base2: [number, number][] = [];
          for (let i = 0; i < catCount; i++) {
            const r = stackedValue(g, p, i) ?? (model.dispBlanksAs === "zero" || g.grouping !== "standard" ? { base: 0, end: 0 } : null);
            if (!r) continue;
            top2.push([catCenter(i), valToPos(sc, r.end, ax)]);
            base2.push([catCenter(i), valToPos(sc, r.base, ax)]);
          }
          if (top2.length < 2) continue;
          const d = `M ${top2.map(([x, y]) => `${n2(x)} ${n2(y)}`).join(" L ")} L ${base2
            .reverse()
            .map(([x, y]) => `${n2(x)} ${n2(y)}`)
            .join(" L ")} Z`;
          path(d, p.color, p.src.line.color ?? null, p.lineWidth * s, p.dash, p.src.fillAlpha);
          if (p.labels?.any && catCount <= pointsLimit) {
            for (let i = 0; i < catCount; i++) {
              const r = stackedValue(g, p, i);
              if (!r) continue;
              pushLabel(p, labelText(p, i, p.values[i], null), catCenter(i), valToPos(sc, (r.base + r.end) / 2, ax), "center", p.color, i);
            }
          }
        }
      }

      if (kind === "bar") {
        const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
        const n = stacked ? 1 : Math.max(1, members.length);
        const ov = Math.max(-1, Math.min(1, g.overlap / 100));
        const gap = Math.max(0, g.gapWidth / 100);
        const barW = slotLen / (n - (n - 1) * ov + gap);
        const groupW = barW * (n - (n - 1) * ov);
        // 棒は、分類の軸と交わる値(既定は0。最小値が0より大きければ最小値)から伸ばし、プロットエリアの外へははみ出さない
        const groupCross = crossValueOn(sc, axisOf(g.catAxisId));
        const clampV = (v: number) => Math.min(sc.max, Math.max(sc.min, v));
        members.forEach((p, si) => {
          for (let i = 0; i < catCount; i++) {
            const r0 = stackedValue(g, p, i);
            if (!r0) continue;
            const r = stacked ? r0 : { base: groupCross, end: r0.end };
            const offset = stacked ? 0 : si * barW * (1 - ov);
            const start = catCenter(i) - (horizontalBars ? -groupW / 2 : groupW / 2) + (horizontalBars ? -offset : offset);
            const a = valToPos(sc, clampV(r.base), ax);
            const b = valToPos(sc, clampV(r.end), ax);
            const fill = pointColor(model, p, i);
            const stroke = p.src.line.color ?? null;
            const alpha = p.src.pointFills.has(i) ? null : p.src.fillAlpha;
            if (horizontalBars) rect(Math.min(a, b), start - barW, Math.abs(b - a), barW, fill, stroke, p.lineWidth * s, null, alpha);
            else rect(start, Math.min(a, b), barW, Math.abs(b - a), fill, stroke, p.lineWidth * s, null, alpha);
            if (p.labels?.any && catCount <= pointsLimit) {
              const t = labelText(p, i, p.values[i], g.grouping === "percentStacked" ? r.end - r.base : null);
              const pos = labelPosOf(p, i) ?? (stacked ? "ctr" : "outEnd");
              const size = sz(p.labels.points.get(i)?.style ?? p.labels.text, baseSize);
              const positive = r.end >= r.base;
              const centerAcross = horizontalBars ? start - barW / 2 : start + barW / 2;
              if (horizontalBars) {
                const xEnd = b;
                const lx = pos === "ctr" ? (a + b) / 2 : pos === "inBase" ? a + (positive ? 3 : -3) * s : pos === "inEnd" ? xEnd + (positive ? -3 : 3) * s : xEnd + (positive ? 3 : -3) * s;
                const align = pos === "ctr" ? "center" : (pos === "outEnd") === positive ? "left" : "right";
                pushLabel(p, t, lx, centerAcross, align, pos === "outEnd" ? null : fill, i);
              } else {
                const yEnd = b;
                const ly =
                  pos === "ctr"
                    ? (a + b) / 2
                    : pos === "inBase"
                      ? a + (positive ? -1 : 1) * (size * 0.5 + 3 * s)
                      : pos === "inEnd"
                        ? yEnd + (positive ? 1 : -1) * (size * 0.5 + 3 * s)
                        : yEnd + (positive ? -1 : 1) * (size * 0.5 + 3 * s);
                pushLabel(p, t, centerAcross, ly, "center", pos === "outEnd" ? null : fill, i);
              }
            }
          }
        });
      }

      if (kind === "line" || kind === "scatter") {
        for (const p of members) {
          const pts: ([number, number] | null)[] = [];
          for (let i = 0; i < p.values.length; i++) {
            let r: { base: number; end: number } | null;
            if (kind === "scatter") r = p.values[i] === null ? null : { base: 0, end: p.values[i]! };
            else r = stackedValue(g, p, i);
            if (!r && model.dispBlanksAs === "zero") r = { base: 0, end: 0 };
            if (!r) {
              pts.push(null);
              continue;
            }
            const x = kind === "scatter" ? xToPos(p.xValues?.[i] ?? i + 1) : catCenter(i);
            if (kind === "scatter" && (p.xValues?.[i] ?? i + 1) === null) {
              pts.push(null);
              continue;
            }
            pts.push([x, valToPos(sc, r.end, ax)]);
          }
          const segments: [number, number][][] = [[]];
          for (const pt of pts) {
            if (pt) segments[segments.length - 1].push(pt);
            else if (model.dispBlanksAs !== "span" && segments[segments.length - 1].length > 0) segments.push([]);
          }
          const smooth = p.src.smooth || (kind === "scatter" && /smooth/i.test(g.scatterStyle ?? ""));
          if (p.lineColor) {
            for (const seg of segments) {
              if (seg.length < 2) continue;
              path(smooth ? smoothPath(seg) : `M ${seg.map(([x, y]) => `${n2(x)} ${n2(y)}`).join(" L ")}`, null, p.lineColor, p.lineWidth * s, p.dash);
            }
          }
          if (p.marker && pts.length <= pointsLimit) for (const pt of pts) if (pt) drawMarker(p.marker, pt[0], pt[1], s);
          if (p.labels?.any && pts.length <= pointsLimit) {
            pts.forEach((pt, i) => {
              if (!pt) return;
              const t = labelText(p, i, p.values[i], null);
              const size = sz(p.labels!.points.get(i)?.style ?? p.labels!.text, baseSize);
              const pos = labelPosOf(p, i) ?? "r";
              const off = (p.marker ? p.marker.size / 2 : 2) * s + 3 * s;
              if (pos === "t") pushLabel(p, t, pt[0], pt[1] - off - size / 2, "center", null, i);
              else if (pos === "b") pushLabel(p, t, pt[0], pt[1] + off + size / 2, "center", null, i);
              else if (pos === "l") pushLabel(p, t, pt[0] - off, pt[1], "right", null, i);
              else if (pos === "ctr") pushLabel(p, t, pt[0], pt[1], "center", null, i);
              else pushLabel(p, t, pt[0] + off, pt[1], "left", null, i);
            });
          }
        }
      }
    }
  }

  // ---- 軸の線・目盛りの文字・軸のタイトル ----
  const axisLineColor = (a: ChartAxis | undefined, dflt: string | null) => (a ? (a.line.color === undefined ? dflt : a.line.color) : null);
  // 分類の軸(値が0の位置、または最小値の位置に引く)
  if (catAxis && !catAxis.deleted) {
    const c = axisLineColor(catAxis, DEFAULT_AXIS_LINE);
    const at = valToPos(primaryScale, catCross, primaryAxis);
    if (c) {
      if (horizontalBars) line(at, plot.y, at, plot.y + plot.h, c, (catAxis.line.widthPt ?? 0.75) * s);
      else line(plot.x, at, plot.x + plot.w, at, c, (catAxis.line.widthPt ?? 0.75) * s);
    }
  }
  // 値の軸の線は、指定があるときだけ(Office 2013以降の既定は線なし)
  for (const [a, sc, side] of [
    [primaryAxis, primaryScale, "primary"],
    [secondaryAxis, secondaryScale, "secondary"],
  ] as const) {
    if (!a || a.deleted || !sc) continue;
    const c = a.line.color ?? null;
    if (!c) continue;
    const w = (a.line.widthPt ?? 0.75) * s;
    if (horizontalBars) {
      const y = side === "primary" ? plot.y + plot.h : plot.y;
      line(plot.x, y, plot.x + plot.w, y, c, w);
    } else {
      const x = side === "primary" ? plot.x : plot.x + plot.w;
      line(x, plot.y, x, plot.y + plot.h, c, w);
    }
  }

  const axisTextColor = (a: ChartAxis | undefined) => a?.text.color ?? textColor;
  // 値の軸の目盛りの文字
  const drawValLabels = (a: ChartAxis | undefined, sc: Scale | null, labels: string[], side: "primary" | "secondary") => {
    if (!valVisible(a) || !sc) return;
    const size = tickSize(a);
    const ticks = ticksOf(sc);
    ticks.forEach((t, i) => {
      const p = valToPos(sc, t, a);
      if (horizontalBars) {
        const y = side === "primary" ? plot.y + plot.h + 3 * s : plot.y - 3 * s - size;
        label(labels[i] ?? "", p, y, size, axisTextColor(a), a?.text.bold ?? false, "center");
      } else {
        const x = side === "primary" ? plot.x - 4 * s : plot.x + plot.w + 4 * s;
        label(labels[i] ?? "", x, p - size / 2, size, axisTextColor(a), a?.text.bold ?? false, side === "primary" ? "right" : "left");
      }
    });
  };
  drawValLabels(primaryAxis, primaryScale, primaryLabels, "primary");
  if (secondaryAxis) drawValLabels(secondaryAxis, secondaryScale, secondaryLabels, "secondary");

  // 分類の軸の文字(散布図は数値の目盛り)
  if (catVisible) {
    const size = catTickSize;
    const color = axisTextColor(catAxis);
    if (isScatter && xScale) {
      ticksOf(xScale).forEach((t, i) => label(xLabels[i] ?? "", xToPos(t), plot.y + plot.h + 3 * s, size, color, false, "center"));
    } else if (horizontalBars) {
      // 文字の位置: low=左端、high=右端、axis=軸の線の左
      const axisX = valToPos(primaryScale, catCross, primaryAxis);
      const lx = catLabelWhere === "high" ? plot.x + plot.w + 4 * s : catLabelWhere === "axis" ? axisX - 4 * s : plot.x - 4 * s;
      const align = catLabelWhere === "high" ? "left" : "right";
      if (dateSlots) {
        const step = dateLabelStep(size * 1.15);
        for (let k = 0; k < dateSlots.count; k += step) label(dateLabelOf(k), lx, slotCenter(k) - size / 2, size, color, false, align);
      } else if (catPlan) {
        const lh = catPlan.lineHeight;
        for (const i of catPlan.shown) {
          const lines = catPlan.lines.get(i) ?? [categories[i] ?? ""];
          const y0 = catCenter(i) - (lines.length * lh) / 2 + (lh - size) / 2;
          lines.forEach((ln, k) => label(ln, lx, y0 + k * lh, size, color, false, align));
        }
      }
    } else {
      // 文字の位置: low=下端、high=上端の外側、axis=軸の線のすぐ下
      const axisY = valToPos(primaryScale, catCross, primaryAxis);
      const ly = catLabelWhere === "high" ? plot.y - 3 * s - size : catLabelWhere === "axis" ? axisY + 3 * s : plot.y + plot.h + 3 * s;
      if (dateSlots) {
        const widest = Math.max(...dateLabelSamples.map((t) => text.width(t, size)));
        const step = dateLabelStep(widest * 1.2);
        for (let k = 0; k < dateSlots.count; k += step) label(dateLabelOf(k), slotCenter(k), ly, size, color, false, "center");
      } else if (catPlan) {
        const lh = catPlan.lineHeight;
        for (const i of catPlan.shown) {
          const lines = catPlan.lines.get(i) ?? [categories[i] ?? ""];
          const cx = catCenter(i);
          if (catPlan.mode === "rotate") {
            const angle = catPlan.angle;
            const rad = (Math.abs(angle) * Math.PI) / 180;
            const cos = Math.cos(rad);
            // 右上がり(正の角度)は、文字の終わりを目盛りの位置に置き、左下へ伸ばす。右下がり(負の角度)は、文字の始めを置き、右下へ伸ばす。
            // グラフの枠の外へはみ出す分は「…」で切る(ページの端で文字が切れないように)
            const room = angle >= 0 ? cx / Math.max(0.05, cos) : (W - cx) / Math.max(0.05, cos);
            const t = cos > 0.05 ? truncateText(lines[0], Math.max(size, room - size * 0.3), (str) => tw(str, size)) : lines[0];
            if (catLabelWhere === "high") label(t, cx - size * 0.3, ly + size, size, color, false, angle >= 0 ? "left" : "right", angle);
            else if (angle >= 0) label(t, cx + size * 0.3, ly, size, color, false, "right", angle);
            else label(t, cx - size * 0.3, ly, size, color, false, "left", angle);
          } else {
            // 横書き・折り返し：グラフの枠からはみ出さないよう、端の項目は内側へ寄せる
            const yStart = catLabelWhere === "high" ? ly - (lines.length - 1) * lh : ly;
            lines.forEach((ln, k) => {
              const w = tw(ln, size);
              const x = Math.min(W - w / 2 - 1 * s, Math.max(w / 2 + 1 * s, cx));
              label(ln, x, yStart + k * lh, size, color, false, "center");
            });
          }
        }
      }
    }
  }

  // 軸のタイトル
  const drawAxisTitle = (a: ChartAxis | undefined, where: "bottom" | "left" | "right" | "top") => {
    if (!a?.title || a.deleted) return;
    const size = titleSize(a);
    const color = a.title.style.color ?? textColor;
    const bold = a.title.style.bold ?? false;
    const t = a.title.text.replace(/\n/g, " ");
    if (where === "bottom") label(t, plot.x + plot.w / 2, bottom - size * 1.2, size, color, bold, "center");
    else if (where === "top") label(t, plot.x + plot.w / 2, top, size, color, bold, "center");
    else if (where === "left") label(t, left + size * 0.15, plot.y + plot.h / 2, size, color, bold, "center", 90);
    else label(t, right - size * 1.1, plot.y + plot.h / 2, size, color, bold, "center", 90);
  };
  if (horizontalBars) {
    drawAxisTitle(catAxis, "left");
    drawAxisTitle(primaryAxis, "bottom");
    drawAxisTitle(secondaryAxis, "top");
  } else {
    drawAxisTitle(catAxis, "bottom");
    drawAxisTitle(primaryAxis, "left");
    drawAxisTitle(secondaryAxis, "right");
  }

  // データラベル(系列の上に描く)
  for (const l of pendingLabels) label(l.text, l.x, l.y, l.size, l.color, l.bold, l.align);

  legendDraw?.();
  return result;

  function smoothPath(pts: [number, number][]): string {
    // Catmull-Rom → ベジェ曲線(Excelの「スムージング」に近い、点を通るなめらかな線)
    let d = `M ${n2(pts[0][0])} ${n2(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${n2(c1x)} ${n2(c1y)} ${n2(c2x)} ${n2(c2y)} ${n2(p2[0])} ${n2(p2[1])}`;
    }
    return d;
  }

  function slicePath(cx: number, cy: number, r: number, inner: number, a1: number, a2: number): string {
    // 角度は12時の位置から時計回り(度)。ローカル座標は下向きが正なので、そのまま時計回りになる
    const pt = (rr: number, a: number) => {
      const rad = ((a - 90) * Math.PI) / 180;
      return [cx + Math.cos(rad) * rr, cy + Math.sin(rad) * rr];
    };
    const sweep = a2 - a1;
    if (sweep >= 359.99) {
      // 1つだけの扇形(全体)は、円を2つの半円で描く
      const [x1, y1] = pt(r, a1);
      const [x2, y2] = pt(r, a1 + 180);
      let d = `M ${n2(x1)} ${n2(y1)} A ${n2(r)} ${n2(r)} 0 1 1 ${n2(x2)} ${n2(y2)} A ${n2(r)} ${n2(r)} 0 1 1 ${n2(x1)} ${n2(y1)} Z`;
      if (inner > 0) {
        const [ix1, iy1] = pt(inner, a1);
        const [ix2, iy2] = pt(inner, a1 + 180);
        d += ` M ${n2(ix1)} ${n2(iy1)} A ${n2(inner)} ${n2(inner)} 0 1 0 ${n2(ix2)} ${n2(iy2)} A ${n2(inner)} ${n2(inner)} 0 1 0 ${n2(ix1)} ${n2(iy1)} Z`;
      }
      return d;
    }
    const large = sweep > 180 ? 1 : 0;
    const [ox1, oy1] = pt(r, a1);
    const [ox2, oy2] = pt(r, a2);
    if (inner <= 0) return `M ${n2(cx)} ${n2(cy)} L ${n2(ox1)} ${n2(oy1)} A ${n2(r)} ${n2(r)} 0 ${large} 1 ${n2(ox2)} ${n2(oy2)} Z`;
    const [ix2, iy2] = pt(inner, a2);
    const [ix1, iy1] = pt(inner, a1);
    return `M ${n2(ox1)} ${n2(oy1)} A ${n2(r)} ${n2(r)} 0 ${large} 1 ${n2(ox2)} ${n2(oy2)} L ${n2(ix2)} ${n2(iy2)} A ${n2(inner)} ${n2(inner)} 0 ${large} 0 ${n2(ix1)} ${n2(iy1)} Z`;
  }
}

/** データ点の色: 個別の色(dPt) → 円・ドーナツや「要素を塗り分ける」ではアクセント色を順に → 系列の色 */
function pointColor(model: ChartModel, p: PreparedSeries, i: number): string {
  const own = p.src.pointFills.get(i);
  if (own) return own;
  if (p.group.varyColors && (p.group.kind === "pie" || p.group.kind === "doughnut" || model.groups.flatMap((g) => g.series).length === 1)) {
    return autoSeriesColor(model, i);
  }
  return p.color;
}

/** 塗りの上に置く文字の色(暗い塗りには白、明るい塗りには濃い灰色) */
function contrastText(fill: string): string {
  const r = parseInt(fill.slice(1, 3), 16);
  const g = parseInt(fill.slice(3, 5), 16);
  const b = parseInt(fill.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? "#FFFFFF" : "#404040";
}
