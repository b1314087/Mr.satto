import type { ChartModel, SheetChart } from "@/lib/excel/ooxml-charts";

/**
 * Excel→PDF：グラフとページの境目(改ページ)の関係を調べる(変換の前の確認用)。
 *
 * ページの分け方は、PDFを作る処理(excel-to-pdf.ts)が実際に使う計算(computePageGrid・印刷範囲・余白・倍率・
 * 手動の改ページ・何も無いページの省略)の結果をそのまま受け取る。ここではページの分け方を計算し直さない
 * (チェックだけ別の計算をして、実際のPDFと食い違う警告を出さないため)。
 *
 * 座標はすべて「シートの座標(pt。A1セルの左上が原点、拡大縮小の前)」。紙の上の長さは scale をかけて求める。
 */

export type ChartPageIssueLevel = "warning" | "caution" | "info";

export interface ChartPageIssue {
  /** warning=ページの境目をまたぐ、caution=境目にわずかにかかる、info=1ページより大きい・印刷範囲の外 */
  level: ChartPageIssueLevel;
  sheet: string;
  /** シートの中のグラフの番号(1から。Excelのファイルの中の順) */
  chartNo: number;
  /** グラフの種類(縦棒・折れ線 等) */
  chartKind: string;
  /** グラフのタイトル(文字が直接入力されているとき) */
  title: string | null;
  /** 置かれているセルの範囲(例: D2〜K18) */
  cellRange: string;
  /** 紙の上の大きさ(cm。拡大縮小のあと) */
  widthCm: number;
  heightCm: number;
  /** 問題の説明 */
  problem: string;
  /** またいでいる境目の向き: "columns"=左右のページの境目、"rows"=上下のページの境目 */
  directions: ("columns" | "rows")[];
  /** グラフがかかるPDFのページ番号(1から) */
  pages: number[];
}

export interface ChartPageCheckResult {
  /** 調べたグラフの数(選んだシートの、表示できない種類も含むすべてのグラフ) */
  checkedCharts: number;
  issues: ChartPageIssue[];
}

/** PDFの1ページ分の範囲(シートの座標) */
export interface CheckPage {
  pageNo: number;
  /** 横方向(列のまとまり)・縦方向(行のまとまり)の番号 */
  ci: number;
  ri: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 1つの印刷範囲(またはシート全体)の、ページの分け方 */
export interface CheckArea {
  pages: CheckPage[];
  /** 印刷される範囲全体(シートの座標) */
  rect: { x1: number; y1: number; x2: number; y2: number };
  /** 拡大縮小の倍率(1=100%) */
  scale: number;
  /** 1ページに表を印刷できる幅・高さ(紙の上のpt。印刷タイトルの分を除く) */
  pageBodyWidthPt: number;
  pageBodyHeightPt: number;
  /** 列のまとまり ci と ci+1 の間の境目が手動の改ページか */
  manualColBreakAfter: (ci: number) => boolean;
  /** 行のまとまり ri と ri+1 の間の境目が手動の改ページか */
  manualRowBreakAfter: (ri: number) => boolean;
}

const KIND_NAMES: Record<string, string> = { bar: "棒", line: "折れ線", pie: "円", doughnut: "ドーナツ", area: "面", scatter: "散布図" };

/** グラフの種類の名前(画面に出す) */
export function chartKindName(chart: SheetChart): string {
  const model: ChartModel | null = chart.model;
  if (!model) return `表示できない種類のグラフ（${chart.unsupportedReason ?? "不明"}）`;
  const names = model.groups.map((g) => {
    if (g.kind === "bar") {
      const dir = g.barDir === "bar" ? "横棒" : "縦棒";
      return g.grouping === "stacked" ? `積み上げ${dir}` : g.grouping === "percentStacked" ? `100%積み上げ${dir}` : dir;
    }
    return KIND_NAMES[g.kind] ?? g.kind;
  });
  const unique = Array.from(new Set(names));
  return unique.length > 1 ? `複合（${unique.join("・")}）` : (unique[0] ?? "グラフ");
}

function colName(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** グラフが置かれているセルの範囲(例: D2〜K18)。大きさだけで置かれている(終わりのセルが無い)ときは始まりのセル */
export function chartCellRange(chart: SheetChart): string {
  const from = `${colName(chart.fromCol)}${chart.fromRow + 1}`;
  if (chart.toCol === null || chart.toRow === null) return `${from}から`;
  return `${from}〜${colName(chart.toCol)}${chart.toRow + 1}`;
}

const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const ptToCm = (pt: number) => Math.round(((pt * 2.54) / 72) * 10) / 10;
const ptToMm = (pt: number) => Math.max(1, Math.round((pt * 25.4) / 72));

/**
 * 1つのグラフを調べる。areas はそのシートの印刷範囲ごとのページの分け方(印刷範囲が無ければ1つ)。
 * 問題が無ければ null。
 */
export function checkChart(
  sheet: string,
  chartNo: number,
  chart: SheetChart,
  rect: { x1: number; y1: number; x2: number; y2: number },
  areas: CheckArea[]
): ChartPageIssue | null {
  const w = rect.x2 - rect.x1;
  const h = rect.y2 - rect.y1;
  if (!(w > 0.5 && h > 0.5)) return null;
  const chartArea = w * h;

  // いちばん多く重なる印刷範囲で調べる(印刷範囲が複数あって、グラフが別の範囲にもかかる場合は、その範囲の分も足す)
  let best: { area: CheckArea; inside: number } | null = null;
  let insideTotal = 0;
  for (const area of areas) {
    const inside = overlap(rect.x1, rect.x2, area.rect.x1, area.rect.x2) * overlap(rect.y1, rect.y2, area.rect.y1, area.rect.y2);
    insideTotal += inside;
    if (!best || inside > best.inside) best = { area, inside };
  }
  const base = {
    sheet,
    chartNo,
    chartKind: chartKindName(chart),
    title: chart.model?.title?.text ?? null,
    cellRange: chartCellRange(chart),
  };
  if (!best || insideTotal < chartArea * 0.01) {
    return {
      ...base,
      level: "info",
      widthCm: ptToCm(w),
      heightCm: ptToCm(h),
      problem: "印刷範囲の外にあるため、PDFには出力されません",
      directions: [],
      pages: [],
    };
  }
  const area = best.area;
  const s = area.scale;
  const printedW = w * s;
  const printedH = h * s;

  // かかるページ(重なりがごく小さいもの(0.5pt未満)は、線の太さ程度の誤差として数えない)
  const hits = area.pages
    .map((p) => {
      const ox = overlap(rect.x1, rect.x2, p.x1, p.x2);
      const oy = overlap(rect.y1, rect.y2, p.y1, p.y2);
      return { p, ox, oy, area: ox * oy };
    })
    .filter((hit) => hit.ox * s > 0.5 && hit.oy * s > 0.5);
  const pages = Array.from(new Set(hits.map((hit) => hit.p.pageNo))).sort((a, b) => a - b);
  const cis = Array.from(new Set(hits.map((hit) => hit.p.ci))).sort((a, b) => a - b);
  const ris = Array.from(new Set(hits.map((hit) => hit.p.ri))).sort((a, b) => a - b);
  const directions: ("columns" | "rows")[] = [];
  if (cis.length > 1) directions.push("columns");
  if (ris.length > 1) directions.push("rows");

  const messages: string[] = [];
  let level: ChartPageIssueLevel | null = null;
  const raise = (l: ChartPageIssueLevel) => {
    const rank = { info: 1, caution: 2, warning: 3 };
    if (!level || rank[l] > rank[level]) level = l;
  };

  // 印刷範囲の端で切れる(範囲の外の部分は出力されない)
  const outX = Math.max(0, area.rect.x1 - rect.x1) + Math.max(0, rect.x2 - area.rect.x2);
  const outY = Math.max(0, area.rect.y1 - rect.y1) + Math.max(0, rect.y2 - area.rect.y2);
  if ((outX + outY) * s > 2 && insideTotal < chartArea * 0.995) {
    const side = [outX * s > 2 ? "左右" : null, outY * s > 2 ? "上下" : null].filter(Boolean).join("・");
    messages.push(`印刷範囲の端（${side}）で切れています。範囲の外の部分は出力されません`);
    raise("warning");
  }

  if (pages.length >= 2) {
    const boundaryKinds = (idxs: number[], manual: (i: number) => boolean) => {
      const kinds = new Set<string>();
      for (let i = idxs[0]; i < idxs[idxs.length - 1]; i++) kinds.add(manual(i) ? "手動の改ページ" : "自動の改ページ");
      return Array.from(kinds).join("・");
    };
    const where: string[] = [];
    if (directions.includes("columns")) where.push(`左右のページの境目（縦の境界線・${boundaryKinds(cis, area.manualColBreakAfter)}）`);
    if (directions.includes("rows")) where.push(`上下のページの境目（横の境界線・${boundaryKinds(ris, area.manualRowBreakAfter)}）`);
    const scaleNote = Math.abs(s - 1) > 0.005 ? `。拡大縮小${Math.round(s * 100)}%で印刷したときの位置です` : "";
    const tooWide = printedW > area.pageBodyWidthPt + 0.5;
    const tooTall = printedH > area.pageBodyHeightPt + 0.5;
    // いちばん多く入るページから、はみ出す長さ(紙の上)
    const main = hits.reduce((a, b) => (b.area > a.area ? b : a));
    const spillX = (w - main.ox) * s;
    const spillY = (h - main.oy) * s;
    if (tooWide || tooTall) {
      messages.push(
        `グラフが1ページの${tooWide && tooTall ? "幅・高さ" : tooWide ? "幅" : "高さ"}より大きいため、${pages.length}ページに分かれます（${where.join("と")}）${scaleNote}`
      );
      raise("info");
    } else if (Math.max(spillX, spillY) <= Math.max(10, 0.06 * (spillX >= spillY ? printedW : printedH))) {
      messages.push(
        `${where.join("と")}に、グラフの端がわずかにかかっています（約${ptToMm(Math.max(spillX, spillY))}mm）。グラフの端（軸の文字・凡例・枠など）が隣のページに分かれる可能性があります${scaleNote}`
      );
      raise("caution");
    } else {
      messages.push(`${where.join("と")}をまたいでいます。グラフが${pages.length}ページに分かれて印刷されます${scaleNote}`);
      raise("warning");
    }
  }

  if (!level) return null;
  return { ...base, level, widthCm: ptToCm(printedW), heightCm: ptToCm(printedH), problem: messages.join("。"), directions, pages };
}

/** 表示の順: 警告 → 注意 → 情報、同じならシートの順・グラフの番号の順(呼び出し側の順を保つ) */
export function sortIssues(issues: ChartPageIssue[]): ChartPageIssue[] {
  const rank = { warning: 0, caution: 1, info: 2 };
  return issues.map((issue, i) => ({ issue, i })).sort((a, b) => rank[a.issue.level] - rank[b.issue.level] || a.i - b.i).map((x) => x.issue);
}
