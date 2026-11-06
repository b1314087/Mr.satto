/**
 * Excelの「印刷ページ」に対応するページ分割の計算（Phase 18.2 B-1〜B-4, B-13, B-14）。
 *
 * 「Excelの1印刷ページ = PDFの1ページ」を実現するための中核ロジック。
 * 内容量（データの多さ）だけでページ数を決めるのではなく、
 * 印刷範囲・用紙サイズ・向き・余白・拡大縮小・Fit to Page（優先順位は
 * 開発指示書B-4のとおり）から「列方向に何ページ・行方向に何ページ」を
 * 計算し、その組み合わせをPDFの各ページへ対応させる。
 *
 * Excel/PDFのどちらも実際のレイアウトエンジンは複雑なため完全再現は保証しない
 * （開発指示書E章）。ここでは「Fit to Width/Height/Scale/自然な内容量」という
 * 主要な決定要因を、実際のOOXML設定値（取得できた範囲）から計算することを
 * 目標にする。
 */

export interface FitPageSettings {
  fitToPageEnabled: boolean;
  /** 0または null = その方向は制限しない（内容量なりに複数ページへ） */
  fitToWidth: number | null;
  fitToHeight: number | null;
  /** fitToPageEnabledがfalseのときのみ使う明示的な拡大縮小(%) */
  scalePercent: number | null;
}

export interface PageGridResult {
  /** 各グループ = そのグループに含まれる列インデックス（印刷範囲内でのローカル0始まり）の配列 */
  colGroups: number[][];
  rowGroups: number[][];
  /** 実際に適用した拡大縮小率（1 = 100%） */
  scale: number;
}

/** Excelの拡大縮小の実用的な範囲(10%〜400%)にクランプする */
function clampScale(scale: number): number {
  return Math.min(4, Math.max(0.1, scale));
}

/**
 * 与えられたサイズ配列を、閾値(threshold)を超えないようグループへ分割する。
 * breaksAfterIndex に含まれるインデックスの直後では、閾値に達していなくても
 * 強制的にグループを区切る（明示的な改ページ、開発指示書B-15）。
 */
function groupByThreshold(sizes: number[], threshold: number, breaksAfterIndex: Set<number>): number[][] {
  if (sizes.length === 0) return [[]];
  const groups: number[][] = [];
  let current: number[] = [];
  let currentSum = 0;
  sizes.forEach((size, idx) => {
    const wouldExceed = current.length > 0 && currentSum + size > threshold;
    if (wouldExceed) {
      groups.push(current);
      current = [];
      currentSum = 0;
    }
    current.push(idx);
    currentSum += size;
    if (breaksAfterIndex.has(idx) && idx < sizes.length - 1) {
      groups.push(current);
      current = [];
      currentSum = 0;
    }
  });
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [sizes.map((_, i) => i)];
}

/**
 * 1ページに入る表の本体の長さ(シートの座標・拡大縮小の前)。
 * 印刷タイトル(毎ページに繰り返す行・列)も同じ倍率で縮小・拡大されて紙の上の場所を使うため、
 * 紙の上で本体に使える長さは「印刷できる長さ − タイトルの長さ×倍率」。
 */
function bodyLimit(contentPt: number, titlePt: number, scale: number): number {
  return (Math.max(1, contentPt - titlePt * scale) / scale) * (1 + 1e-9);
}

/**
 * 「次のページ数に合わせて印刷」で、列(行)を途中で分けずに、指定のページ数に収まる倍率を求める。
 * 合計の長さだけで求めた倍率(start)では、列の幅の切れ目の都合で、1ページに入りきらない列が次のページへ送られ、
 * 指定より多いページになることがある。Excelは列や行を途中で分けないため、そのときはさらに縮小して収める。
 * ここでは、指定のページ数に収まる最も大きい倍率(start以下・10%以上)を二分探索で求める
 * (倍率を小さくするほど1ページに入る量が増え、ページ数は増えないため、二分探索で求められる)。
 * 10%まで縮小しても収まらないとき(極端に多い列など)は、10%で内容の量なりに分ける(データを切り取らないため、ページ数は増える)。
 */
function scaleToFitTargets(
  start: number,
  dims: { sizes: number[]; contentPt: number; titlePt: number; target: number | null }[]
): number {
  const fits = (scale: number) =>
    dims.every((d) => !d.target || groupByThreshold(d.sizes, bodyLimit(d.contentPt, d.titlePt, scale), new Set()).length <= d.target);
  if (fits(start)) return start;
  const min = 0.1;
  if (!fits(min)) return min;
  let lo = min;
  let hi = start;
  for (let i = 0; i < 40 && hi - lo > 1e-6; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface ComputePageGridParams {
  colSizesPt: number[];
  rowSizesPt: number[];
  contentWidthPt: number;
  contentHeightPt: number;
  fit: FitPageSettings;
  colBreaksAfterIndex: Set<number>;
  rowBreaksAfterIndex: Set<number>;
  /**
   * 印刷タイトル(毎ページに繰り返す列・行)の幅・高さ(シートの座標・拡大縮小の前)。
   * contentWidthPt/contentHeightPt は、タイトルの分を引く前の、紙の上で印刷できる幅・高さ。
   */
  titleColsWidthPt?: number;
  titleRowsHeightPt?: number;
}

/**
 * Excelの印刷設定から、列方向・行方向それぞれの「ページへの分割」を計算する。
 * 開発指示書B-4の優先順位（印刷範囲→用紙→向き→余白→Fit to Width→Fit to
 * Height→scale→改ページ→行列サイズ）のうち、印刷範囲・用紙・向き・余白は
 * 呼び出し側（コンテンツ範囲・contentWidthPt/contentHeightPtの決定）で
 * 既に反映済みという前提で、残りのFit to Width/Height・scale・改ページ・
 * 行列サイズをここで扱う。
 */
export function computePageGrid(params: ComputePageGridParams): PageGridResult {
  const { colSizesPt, rowSizesPt, contentWidthPt, contentHeightPt, fit, colBreaksAfterIndex, rowBreaksAfterIndex } = params;
  const titleW = params.titleColsWidthPt ?? 0;
  const titleH = params.titleRowsHeightPt ?? 0;
  const totalWidth = colSizesPt.reduce((a, b) => a + b, 0);
  const totalHeight = rowSizesPt.reduce((a, b) => a + b, 0);

  if (fit.fitToPageEnabled) {
    const targetWidthPages = fit.fitToWidth && fit.fitToWidth > 0 ? fit.fitToWidth : null;
    const targetHeightPages = fit.fitToHeight && fit.fitToHeight > 0 ? fit.fitToHeight : null;

    // N ページに収める倍率 s：N×(印刷できる長さ − タイトル×s) ≥ 本体の合計×s より、s = N×印刷できる長さ ÷ (本体の合計 + N×タイトル)
    const requiredScaleForWidth =
      targetWidthPages && totalWidth > 0 ? (targetWidthPages * contentWidthPt) / (totalWidth + targetWidthPages * titleW) : null;
    const requiredScaleForHeight =
      targetHeightPages && totalHeight > 0 ? (targetHeightPages * contentHeightPt) / (totalHeight + targetHeightPages * titleH) : null;

    const candidates = [requiredScaleForWidth, requiredScaleForHeight].filter((v): v is number => v !== null);
    // Fit to Width/Heightのどちらも指定がある場合は、両方を満たすようより小さい(より縮小する)方を採用する
    // （実際のExcelの挙動：両方を同時に満たす必要があるため）。
    // Excelの「次のページ数に合わせて印刷」は縮小するだけで、拡大はしない(最大100%)。指定のページ数は「上限」で、
    // 100%のままで収まる表は、そのまま(より少ないページ数)で印刷される。以前は小さい表を用紙いっぱいまで拡大し、
    // 指定のページ数ちょうどに分けていたため、Excelで印刷した結果と大きさ・ページ数が違っていた。
    // 列や行は途中で分けないため、その切れ目の都合で指定のページ数を超えるときは、さらに縮小して収める(Excelと同じ)。
    const scale = scaleToFitTargets(clampScale(Math.min(1, ...candidates)), [
      { sizes: colSizesPt, contentPt: contentWidthPt, titlePt: titleW, target: targetWidthPages },
      { sizes: rowSizesPt, contentPt: contentHeightPt, titlePt: titleH, target: targetHeightPages },
    ]);

    // その倍率で、Excelと同じく内容の量なりにページを分ける(Fit to Pageのときは、手動の改ページは使わない)。
    // 以前は、指定のページ数を超えたときに、1ページの幅より広いまとまりへ無理に分けていたため、ページの端で表が切れていた。
    const colGroups = groupByThreshold(colSizesPt, bodyLimit(contentWidthPt, titleW, scale), new Set());
    const rowGroups = groupByThreshold(rowSizesPt, bodyLimit(contentHeightPt, titleH, scale), new Set());

    return { colGroups, rowGroups, scale };
  }

  // Fit to Pageが無効な場合: 明示的なscale(%)があればそれを、無ければ100%を使い、
  // 閾値ベースの自然なページ分割（明示的な改ページがあれば優先）を行う。
  const scale = clampScale(fit.scalePercent ? fit.scalePercent / 100 : 1);
  const colGroups = groupByThreshold(colSizesPt, bodyLimit(contentWidthPt, titleW, scale), colBreaksAfterIndex);
  const rowGroups = groupByThreshold(rowSizesPt, bodyLimit(contentHeightPt, titleH, scale), rowBreaksAfterIndex);
  return { colGroups, rowGroups, scale };
}
