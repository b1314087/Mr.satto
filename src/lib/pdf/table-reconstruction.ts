import type { PositionedTextItem } from "./pdfjs-client";

/**
 * PDFの座標付きテキストから、表の行・列構造を推定する（Phase 2-D ■表構造推定）。
 *
 * 単純に「1行1テキストをCSVの1行にする」というテキスト連結ではなく、
 * 文字の x/y 座標・幅・行間から
 *   1. どのテキストが同じ「行」に属するか（y座標のクラスタリング）
 *   2. どのテキストが同じ「列」に属するか（列と列の間の空白＝ギャップの検出）
 * を推定し、行×列の2次元グリッドを組み立てる。
 *
 * 列の検出は「文字の左端x座標が揃っている」ことを前提にしない
 * （数値列は右揃えのことが多く、左端は行ごとにバラバラになるため）。
 * 代わりに、各行内でテキスト同士の間に空いた「大きめの隙間」を候補とし、
 * その隙間がページ全体の複数行で共通して現れる位置だけを
 * 実際の列区切りとして採用する。これにより左揃え・右揃え・中央揃えの
 * どの列でも実用的に列を推定できる。
 *
 * 完全に複雑なPDFの表（結合セル・多段見出し等）を100%再現することは
 * 保証しない（開発指示書■「複雑なPDFについて」）。あくまで実用的な
 * 精度を目指す。
 *
 * 【列区切りの検出方法の変遷】
 * 当初は「各行ごとに隣り合うテキストの隙間を求め、複数行で近い位置に
 * 現れた隙間だけを列区切りとして採用する」方式を試したが、以下の理由で
 * 不安定だった：
 *   - pdf生成ツールによっては、各セルを別々のテキスト描画命令として
 *     出力することがあり、その場合pdfjsの getTextContent() は実テキスト
 *     同士の間に `str: " "` という空白専用の項目を自動挿入し、
 *     その項目の width が隙間の大きさをそのまま表してしまう
 *     （＝隣接テキスト同士のバウンディングボックスの隙間は常に0に見える）。
 *   - 行ごとに文字数・揃え（左揃え/右揃え）が異なると、同じ列であっても
 *     行ごとに隙間の開始・終了位置（＝中点）が変わってしまい、
 *     複数行で「同じ位置」に集約されない。
 *
 * そこで、行単位ではなくページ全体で「どのx座標にも一度も文字が
 * かからない、連続した縦の帯（コリドー）」を検出する方式に変更した。
 * これは表の列区切りが持つ本質的な性質（＝どの行の文字もその位置には
 * 掛からない）を直接利用するもので、揃え方や行ごとの文字数の違いに
 * 左右されない。
 *
 * 【さらなる改良：幅の比率しきい値から「複数行での再現性」判定へ】
 * 上記のコリドー方式は、帯の幅がページ全体の「1文字あたりの目安幅×定数」
 * 以上あることを列区切りの条件としていたが、実データ（学年・クラス・番号の
 * ような桁数の少ない数値列が並ぶ表）で、本物の列区切り（11〜27pt程度）が
 * 保護者氏名等の広い列の文字幅から決まるしきい値を下回り、隣の列と
 * くっついてしまう不具合が見つかった。かといって単純にしきい値を下げると、
 * 今度は「1つのセルの中の自由記述が複数のテキスト項目に分割されて書き出され、
 * かつその間の隙間がページ全体のどの行の文字にもかからない」ケース
 * （実データで実際に確認：ある1行だけの「都合の悪い時間帯」欄が
 * 「9時〜12時半」「仕事のため終わり次第向かいます。」という2つの別々の
 * テキスト項目に分かれて出力されており、その間の隙間がちょうど本物の
 * 狭い列区切りと同程度の幅だったため、幅だけでは本物の列区切りと
 * 区別できなかった）を誤って列区切りとみなしてしまう。
 *
 * 本物の列区切りと見かけ上の隙間を区別する本質的な違いは「幅」ではなく
 * 「複数の行で繰り返し現れるか」である（本物の列区切りは表の構造そのものが
 * 生む空白なので、ほぼ全ての行で同じ位置に現れるのに対し、1セル内の
 * テキスト分割による隙間は、たまたまその1行にしか現れない）。そこで、
 * ページ全体のコリドー検出はあくまで「候補」を絞り込む一次フィルタとして
 * 残しつつ、各候補について「その位置に、各行『単独』で見ても隙間が
 * 存在するか」を行ごとに判定し（pdfjsが挿入する空白専用項目は行の
 * グルーピング前に既に除外済みのため、ここでの「隙間」は実テキスト同士の
 * 隙間のみを見ている）、十分な数の行で再現された候補だけを実際の列区切り
 * として採用する（countColumnGapSupport）。再現数が少ない候補同士が
 * 隣接している場合は、その間（ブリッジ）自体がごく少数の行にしか
 * またがれていないことを条件に1つの列区切りへ統合する
 * （mergeWeaklyBridgedRanges。前述の「9時〜12時半」の分割ケースはこれで
 * 1つの列区切りへ正しく統合される）。
 *
 * 【複数ページにまたがる表への対応】
 * 複数ページのPDF（pdf-to-excel.ts）では、以前は各ページが独立に列区切りを
 * 推定していたため、同じ表の続きのはずなのにページごとに列数・区切り位置が
 * 異なってしまう不具合があった（あるページでは「経験」列の記入がある行が
 * 少なく、単独では十分な再現数に届かないため列区切りが検出されない、等）。
 * computeColumnBreaksAcrossPagesは、候補の抽出こそページごとに行う
 * （あるページの表の内容が別のページの内容によって誤って覆われてしまう
 * ことを避けるため）が、再現数の判定は全ページの行をまとめて行うことで、
 * 「どのページで見ても該当する内容が少ない列」でも、ページをまたいで
 * 集計すれば十分な根拠が得られるようにしている。
 */

/** 行のグルーピング結果。PDF→Word（paragraph-reconstruction.ts）とも共通利用する（開発指示書■21） */
export interface Line {
  y: number;
  items: PositionedTextItem[];
}

const MIN_GAP_TOLERANCE = 3; // pt
const BIN_SIZE_PT = 1;
/** 列区切りの「候補」とみなすための最小幅(pt)。本物の判定はこれだけでなく
 *  countColumnGapSupportによる複数行での再現性チェックで行う。 */
const MIN_GAP_WIDTH_PT = 6;
/** 行単独での隙間（内部の自由記述の分割等との区別に使う）を認識する最小幅(pt) */
const PER_LINE_GAP_MIN_WIDTH_PT = 4;
/** 列区切り候補として「再現された」とみなすために必要な行数の割合・下限 */
const MIN_SUPPORT_RATIO = 0.15;
const MIN_SUPPORT_FLOOR = 2;
/** 異なるページで見つかった列区切り候補を「同じ列区切り」とみなして統合する際の、x座標の許容距離(pt) */
const CANDIDATE_CLUSTER_PROXIMITY_PT = 10;

function isBlank(item: PositionedTextItem): boolean {
  return item.str.trim() === "";
}

/**
 * 座標付きテキストをy座標でグルーピングし「行」の単位にまとめる。
 * PDF→Excelの表構造推定・PDF→Wordの段落構造推定の両方が使う共通処理
 * （開発指示書■21：共通のPDF解析基盤として集約する）。
 */
export function groupIntoLines(items: PositionedTextItem[]): Line[] {
  // 空白専用の項目（pdfjsが隙間を表すために挿入することがある）は
  // 列区切りの判定には使わず（後述のカバレッジ判定はテキストの実体のみで行う）、
  // 行のグルーピングの時点で除外してよい
  const meaningful = items.filter((item) => !isBlank(item));
  const sorted = [...meaningful].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  for (const item of sorted) {
    const tolerance = Math.max(MIN_GAP_TOLERANCE, item.fontHeight * 0.4);
    const line = lines.find((l) => Math.abs(l.y - item.y) <= tolerance);
    if (line) {
      line.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

/**
 * ページ単独で「どの行の文字もかからない、一定幅以上の縦の帯」を検出し、
 * その範囲(開始x, 終了x)を候補として返す。まだ複数行での再現性チェックは
 * 行わない（それはcountColumnGapSupportで行う）。
 */
function pageCandidateGapRanges(lines: Line[]): [number, number][] {
  const contentItems = lines.flatMap((line) => line.items);
  if (contentItems.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  for (const item of contentItems) {
    minX = Math.min(minX, item.x);
    maxX = Math.max(maxX, item.x + item.width);
  }
  if (!Number.isFinite(minX) || maxX <= minX) return [];

  const binCount = Math.max(1, Math.ceil((maxX - minX) / BIN_SIZE_PT) + 1);
  const covered = new Uint8Array(binCount);
  for (const item of contentItems) {
    const startBin = Math.max(0, Math.floor((item.x - minX) / BIN_SIZE_PT));
    const endBin = Math.min(binCount, Math.ceil((item.x + item.width - minX) / BIN_SIZE_PT));
    for (let b = startBin; b < endBin; b++) covered[b] = 1;
  }

  const ranges: [number, number][] = [];
  let gapStartBin: number | null = null;
  for (let b = 0; b < binCount; b++) {
    if (covered[b] === 0) {
      if (gapStartBin === null) gapStartBin = b;
      continue;
    }
    if (gapStartBin !== null) {
      const xStart = minX + gapStartBin * BIN_SIZE_PT;
      const xEnd = minX + b * BIN_SIZE_PT;
      if (xEnd - xStart >= MIN_GAP_WIDTH_PT) ranges.push([xStart, xEnd]);
      gapStartBin = null;
    }
  }
  // ループ終了時点でまだ隙間が続いている場合は、内容の右端より外側の
  // 余白（表の外側）なので列区切りとしては扱わない（意図的に無視する）
  return ranges;
}

/** 1行「単独」で見た、隣り合うテキスト項目同士の隙間の一覧(開始x, 終了x)を返す */
function perLineGapRanges(line: Line, minWidth: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let i = 1; i < line.items.length; i++) {
    const prev = line.items[i - 1];
    const cur = line.items[i];
    const gapStart = prev.x + prev.width;
    const gapEnd = cur.x;
    if (gapEnd - gapStart >= minWidth) ranges.push([gapStart, gapEnd]);
  }
  return ranges;
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/** 候補範囲rangeが、何行の「単独での隙間」と重なるか(＝再現数)を数える */
function countColumnGapSupport(perLineGapsByLine: [number, number][][], range: [number, number]): number {
  let count = 0;
  for (const lineGaps of perLineGapsByLine) {
    if (lineGaps.some((g) => rangesOverlap(g, range))) count++;
  }
  return count;
}

/** 範囲rangeに、実際に文字が描画されている行が何行あるか(ブリッジ統合の判定に使う) */
function countItemOverlapSupport(lines: Line[], range: [number, number]): number {
  let count = 0;
  for (const line of lines) {
    if (line.items.some((item) => rangesOverlap([item.x, item.x + item.width], range))) count++;
  }
  return count;
}

/** x座標が近い候補範囲同士（異なるページ由来のものを含む）を1つにまとめる */
function clusterCandidateRanges(ranges: [number, number][], proximityPt: number): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const clusters: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && start <= last[1] + proximityPt) {
      last[0] = Math.min(last[0], start);
      last[1] = Math.max(last[1], end);
    } else {
      clusters.push([start, end]);
    }
  }
  return clusters;
}

/**
 * 複数ページ分の行(linesByPage。1ページだけの場合は要素数1の配列を渡す)から、
 * 文書全体で一貫した列区切りのx座標一覧を推定する（ファイル先頭のコメント
 * 「さらなる改良」「複数ページにまたがる表への対応」を参照）。
 */
export function computeColumnBreaksAcrossPages(linesByPage: Line[][]): number[] {
  const allLines = linesByPage.flat();
  if (allLines.length === 0) return [];

  const candidateRanges = linesByPage.flatMap((lines) => pageCandidateGapRanges(lines));
  const clustered = clusterCandidateRanges(candidateRanges, CANDIDATE_CLUSTER_PROXIMITY_PT);

  const perLineGapsByLine = allLines.map((line) => perLineGapRanges(line, PER_LINE_GAP_MIN_WIDTH_PT));
  const requiredSupport = Math.min(allLines.length, Math.max(MIN_SUPPORT_FLOOR, Math.round(allLines.length * MIN_SUPPORT_RATIO)));

  const accepted = clustered.filter((range) => countColumnGapSupport(perLineGapsByLine, range) >= requiredSupport);

  // 再現数は足りているが隣接し合う候補同士は、その間(ブリッジ)に実際に
  // 文字がある行がごく少数(requiredSupport未満、典型的には1行)しかない場合、
  // 1セル内のテキスト分割が生んだ見かけ上の区切りとみなして1つへ統合する。
  const merged: [number, number][] = [];
  for (const range of accepted) {
    const last = merged[merged.length - 1];
    if (last) {
      const bridge: [number, number] = [last[1], range[0]];
      if (bridge[1] > bridge[0] && countItemOverlapSupport(allLines, bridge) < requiredSupport) {
        merged[merged.length - 1] = [last[0], range[1]];
        continue;
      }
    }
    merged.push(range);
  }

  return merged.map(([start, end]) => (start + end) / 2);
}

/** 1ページ分の行だけから列区切りを推定する(computeColumnBreaksAcrossPagesの単一ページ版) */
function computeColumnBreaks(lines: Line[]): number[] {
  return computeColumnBreaksAcrossPages([lines]);
}

function columnIndexFor(x: number, breaks: number[]): number {
  let idx = 0;
  for (const b of breaks) {
    if (x >= b) idx++;
    else break;
  }
  return idx;
}

/** 列結合(colspan)の推定結果。1行につき最大1個まで（複雑な複数結合は対象外、実用上の精度を優先） */
export interface ColumnSpanHint {
  row: number;
  col: number;
  span: number;
}

export interface ReconstructedTable {
  /** 行×列の文字列グリッド（空セルは空文字列） */
  rows: string[][];
  columnCount: number;
  /**
   * 罫線・結合セル復元(外出先PC修正指示書§21-26)用の幾何情報。
   * PDFページ座標系(原点左下、上方向が正)でのセル境界線の位置。
   * rowBoundariesY.length === rows.length + 1、colBoundariesX.length === columnCount + 1。
   * rows.length === 0 のときは空配列。
   */
  rowBoundariesY: number[];
  colBoundariesX: number[];
  /** 列結合(colspan)の推定結果一覧（開発指示書§21-26。行結合(rowspan)は今回は対象外）。 */
  columnSpans: ColumnSpanHint[];
}

function averageItemFontHeight(items: PositionedTextItem[]): number {
  if (items.length === 0) return 10;
  return items.reduce((sum, item) => sum + item.fontHeight, 0) / items.length;
}

/**
 * 1ページ分の座標付きテキストから表（行×列グリッド）を推定する。
 * 表らしい隙間パターンが見つからない場合は、1行=1列（1セル）として
 * 安全側にフォールバックする（プレーンなテキストPDFでもクラッシュせず、
 * 最低限行ごとのテキストとして出力できるようにするため）。
 *
 * breaksOverrideを渡した場合、このページ単独の列区切り推定は行わず、
 * 渡された列区切り(x座標)をそのまま使う。複数ページにまたがる表で、
 * ページごとに列数・区切り位置がばらつかないようにするため
 * （computeColumnBreaksAcrossPages参照。pdf-to-excel.tsが全ページの
 * 行をまとめて1回だけ推定した結果を、各ページの再構築にそのまま渡す）。
 */
export function reconstructTable(items: PositionedTextItem[], breaksOverride?: number[]): ReconstructedTable {
  const lines = groupIntoLines(items);
  if (lines.length === 0) {
    return { rows: [], columnCount: 0, rowBoundariesY: [], colBoundariesX: [], columnSpans: [] };
  }

  const breaks = breaksOverride ?? computeColumnBreaks(lines);
  const columnCount = breaks.length + 1;

  const rows: string[][] = [];
  const columnSpans: ColumnSpanHint[] = [];

  lines.forEach((line, rowIndex) => {
    const row: string[][] = Array.from({ length: columnCount }, () => []);
    for (const item of line.items) {
      const midX = item.x + item.width / 2;
      const colIndex = Math.min(columnCount - 1, columnIndexFor(midX, breaks));
      row[colIndex].push(item.str);
    }
    rows.push(row.map((cellParts) => cellParts.join(" ").replace(/\s+/g, " ").trim()));

    // 列結合(colspan)の推定(§21-26): 1つのテキスト項目の実際のバウンディングボックス
    // (中点ではなく左端〜右端)が、ページ全体で検出された列区切り(breaks)を1つ以上
    // またいでいる場合、その項目は「複数列にまたがるセル」として描画されていたと
    // みなす。breaksはページ全体（他の多くの行）の実際の隙間パターンから決定的に
    // 導出された値のため、特定の行のテキストがそれをまたいでいること自体が
        // 「その行だけ列が結合されている」強い根拠になる(通常の1列幅の文章が
    // たまたま隣の列にはみ出す、という状況は考えにくい)。
    // 1行に複数の結合候補がある場合は最大のものを1つだけ採用する
    // (複雑な複数結合は対象外、実用上の精度を優先する方針)。
    let bestSpan: ColumnSpanHint | null = null;
    for (const item of line.items) {
      if (item.str.trim() === "") continue;
      const startCol = Math.min(columnCount - 1, columnIndexFor(item.x, breaks));
      const endCol = Math.min(columnCount - 1, columnIndexFor(item.x + item.width, breaks));
      if (endCol > startCol) {
        const span = endCol - startCol + 1;
        if (!bestSpan || span > bestSpan.span) {
          bestSpan = { row: rowIndex, col: startCol, span };
        }
      }
    }
    if (bestSpan) columnSpans.push(bestSpan);
  });

  // --- 罫線復元(§21-26)用の境界線座標(PDFページ座標系)を計算する ---
  // 行境界: 各行の中心(line.y)の中間点を境界とし、先頭行の上端・末尾行の下端は
  // その行のフォント高さの半分ぶん外側に置く。
  const rowBoundariesY: number[] = [];
  lines.forEach((line, i) => {
    if (i === 0) {
      rowBoundariesY.push(line.y + averageItemFontHeight(line.items) * 0.6);
    } else {
      rowBoundariesY.push((lines[i - 1].y + line.y) / 2);
    }
  });
  const lastLine = lines[lines.length - 1];
  rowBoundariesY.push(lastLine.y - averageItemFontHeight(lastLine.items) * 0.6);

  // 列境界: breaks(列と列の間の中点)をそのまま内側の境界とし、左端・右端は
  // 実際のテキスト内容の外側に小さな余白を加えた位置に置く。
  const allItems = lines.flatMap((l) => l.items);
  const minX = Math.min(...allItems.map((it) => it.x));
  const maxX = Math.max(...allItems.map((it) => it.x + it.width));
  const colBoundariesX = [minX - 4, ...breaks, maxX + 4];

  return { rows, columnCount, rowBoundariesY, colBoundariesX, columnSpans };
}

// ---------------------------------------------------------------------------
// セルの型推定（数値・日付）。PDF→Excelが利用する。
// 「文字列として扱うべきものを勝手に数値化しすぎない」ため、
// 通貨記号・パーセント記号付きの値や曖昧な表記は文字列のまま扱う。
// ---------------------------------------------------------------------------

const PLAIN_NUMBER_RE = /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$|^[+-]?\d+(\.\d+)?$/;

/** カンマ区切りの整数・小数のみを数値として認識する（通貨記号・%は対象外） */
export function tryParseNumberCell(text: string): number | null {
  const t = text.trim();
  if (t === "" || !PLAIN_NUMBER_RE.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function safeDate(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

const DATE_PATTERNS: { re: RegExp; toDate: (m: RegExpMatchArray) => Date | null }[] = [
  { re: /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/, toDate: (m) => safeDate(+m[1], +m[2], +m[3]) },
  { re: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, toDate: (m) => safeDate(+m[1], +m[2], +m[3]) },
];

/** 明確に日付と分かる表記（YYYY/MM/DD, YYYY-MM-DD, YYYY年MM月DD日）だけを日付として認識する */
export function tryParseDateCell(text: string): Date | null {
  const t = text.trim();
  for (const { re, toDate } of DATE_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const d = toDate(m);
      if (d) return d;
    }
  }
  return null;
}
