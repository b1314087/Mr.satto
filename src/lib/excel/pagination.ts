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
 * 与えられたサイズ配列を、必ずtargetGroups個以下のグループへ分割する
 * （開発指示書B-13「横1×縦1は必ず1ページ」のような、Fit to Pageの
 * 明示的なページ数指定を確実に守るための分割）。
 * groupByThresholdと異なり、端数による「目標より1つ多いグループ」が
 * 生まれないよう、最後に余剰グループを末尾へ統合する。
 */
function splitIntoExactGroups(sizes: number[], targetGroups: number): number[][] {
  if (sizes.length === 0) return [[]];
  if (targetGroups <= 1) return [sizes.map((_, i) => i)];

  const total = sizes.reduce((a, b) => a + b, 0);
  const milestoneSize = total / targetGroups;
  const groups: number[][] = [];
  let current: number[] = [];
  let currentSum = 0;

  sizes.forEach((size, idx) => {
    current.push(idx);
    currentSum += size;
    const remainingGroups = targetGroups - groups.length - 1;
    if (remainingGroups > 0 && currentSum >= milestoneSize && idx < sizes.length - 1) {
      groups.push(current);
      current = [];
      currentSum = 0;
    }
  });
  if (current.length > 0) groups.push(current);

  while (groups.length > targetGroups && groups.length > 1) {
    const last = groups.pop();
    if (last) groups[groups.length - 1] = [...groups[groups.length - 1], ...last];
  }
  return groups;
}

export interface ComputePageGridParams {
  colSizesPt: number[];
  rowSizesPt: number[];
  contentWidthPt: number;
  contentHeightPt: number;
  fit: FitPageSettings;
  colBreaksAfterIndex: Set<number>;
  rowBreaksAfterIndex: Set<number>;
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
  const totalWidth = colSizesPt.reduce((a, b) => a + b, 0);
  const totalHeight = rowSizesPt.reduce((a, b) => a + b, 0);

  if (fit.fitToPageEnabled) {
    const targetWidthPages = fit.fitToWidth && fit.fitToWidth > 0 ? fit.fitToWidth : null;
    const targetHeightPages = fit.fitToHeight && fit.fitToHeight > 0 ? fit.fitToHeight : null;

    const requiredScaleForWidth = targetWidthPages && totalWidth > 0 ? (targetWidthPages * contentWidthPt) / totalWidth : null;
    const requiredScaleForHeight = targetHeightPages && totalHeight > 0 ? (targetHeightPages * contentHeightPt) / totalHeight : null;

    const candidates = [requiredScaleForWidth, requiredScaleForHeight].filter((v): v is number => v !== null);
    // Fit to Width/Heightのどちらも指定がある場合は、両方を満たすようより小さい(より縮小する)方を採用する
    // （実際のExcelの挙動：両方を同時に満たす必要があるため）。
    const scale = clampScale(candidates.length > 0 ? Math.min(...candidates) : 1);

    const colGroups = targetWidthPages
      ? splitIntoExactGroups(colSizesPt, targetWidthPages)
      : groupByThreshold(colSizesPt, contentWidthPt / scale, new Set());
    const rowGroups = targetHeightPages
      ? splitIntoExactGroups(rowSizesPt, targetHeightPages)
      : groupByThreshold(rowSizesPt, contentHeightPt / scale, new Set());

    return { colGroups, rowGroups, scale };
  }

  // Fit to Pageが無効な場合: 明示的なscale(%)があればそれを、無ければ100%を使い、
  // 閾値ベースの自然なページ分割（明示的な改ページがあれば優先）を行う。
  const scale = clampScale(fit.scalePercent ? fit.scalePercent / 100 : 1);
  const colGroups = groupByThreshold(colSizesPt, contentWidthPt / scale, colBreaksAfterIndex);
  const rowGroups = groupByThreshold(rowSizesPt, contentHeightPt / scale, rowBreaksAfterIndex);
  return { colGroups, rowGroups, scale };
}
