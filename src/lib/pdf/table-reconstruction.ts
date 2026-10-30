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

// ---------------------------------------------------------------------------
// 1つの項目の中に隠れた「数値同士の隙間」の分割
// ---------------------------------------------------------------------------

/** 数値・金額・割合として読める1語(例: 1,234 / -2 / △500 / ¥1,500 / 20.0% / 1,000円) */
const NUMERIC_TOKEN_RE = /^[+\-△▲]?[¥￥$]?\d[\d,]*(\.\d+)?[%％円]?$/;

function numericCharWidthEm(ch: string): number {
  if (ch === "," || ch === ".") return 0.278;
  if (ch === "%") return 0.889;
  if (ch === "-" || ch === "+") return 0.333;
  return 0.556; // 数字・通貨記号など
}

/**
 * pdfjsは、Chrome等で作られたPDFの隣り合う文字列を、間の隙間を空白1文字として
 * 1つの項目にまとめることがある(例: 「3,456,789」と「2,765,432」の間の細い隙間が
 * 「789 2」という1つの項目の中の空白になる)。項目の外形(x〜x+width)だけを見る
 * 列区切りの検出では、この細い隙間が見えず、詰まった数値の列が1列につながってしまう。
 *
 * そこで、空白で区切られた隣り合う2語が「どちらも数値」の項目を、語ごとの項目に分ける。
 * 各語の位置は、数字の幅(フォントの大きさの約0.556倍)を使って推定し、
 * 余った幅(項目の幅 - 語の幅の合計)を空白の幅とみなす。
 * 見積もった空白の幅が不自然(負、またはフォントの大きさの3倍超)な場合は分けない。
 * 数値以外(文章や、ラベルと数値の組み合わせ)の項目は、元の判定を保つため分けない。
 */
export function splitItemsAtNumericGaps(items: PositionedTextItem[]): PositionedTextItem[] {
  const out: PositionedTextItem[] = [];
  for (const item of items) {
    const parts = splitOneItem(item);
    if (parts) out.push(...parts);
    else out.push(item);
  }
  return out;
}

function splitOneItem(item: PositionedTextItem): PositionedTextItem[] | null {
  if (!/\S\s+\S/.test(item.str)) return null;
  const trimmed = item.str.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2 || !tokens.every((t) => NUMERIC_TOKEN_RE.test(t))) return null;
  const fh = item.fontHeight;
  if (!(fh > 0) || !(item.width > 0)) return null;

  const tokenWidths = tokens.map((t) => [...t].reduce((sum, ch) => sum + numericCharWidthEm(ch) * fh, 0));
  const spaceCount = tokens.length - 1;
  const spaceWidth = (item.width - tokenWidths.reduce((a, b) => a + b, 0)) / spaceCount;
  if (!(spaceWidth > 0) || spaceWidth > fh * 3) return null;

  const parts: PositionedTextItem[] = [];
  let x = item.x;
  tokens.forEach((t, i) => {
    parts.push({ ...item, str: t, x, width: tokenWidths[i], hasEOL: i === tokens.length - 1 ? item.hasEOL : false });
    x += tokenWidths[i] + spaceWidth;
  });
  return parts;
}

/** 行のグルーピング結果。PDF→Word（paragraph-reconstruction.ts）とも共通利用する（開発指示書■21） */
export interface Line {
  y: number;
  items: PositionedTextItem[];
}

const MIN_GAP_TOLERANCE = 3; // pt
const BIN_SIZE_PT = 0.5;
/** 列区切りの「候補」とみなすための最小幅(pt)。本物の判定はこれだけでなく
 *  countColumnGapSupportによる複数行での再現性チェックで行う。 */
const MIN_GAP_WIDTH_PT = 4;
/** 列区切り候補の検出で、外れ値として許容する行の割合(文字情報のページは8行以上で約3割まで。OCRは4行以上で約1割(切り上げ)) */
const OUTLIER_LINE_RATIO = 0.1;
/** 従来から許容している外れ値の行の割合(行数が多いページで、どんな行でも約3%まで) */
const LEGACY_OUTLIER_LINE_RATIO = 0.03;
/** この倍率(フォントの大きさに対する幅)以上の文字列は「複数の列にまたがりうる長い文字列」とみなす */
const WIDE_RUN_FONT_RATIO = 3.5;
/** 文字情報のあるページで外れ値として許容する行の割合。表の上に「請求日」「請求番号」などの
 *  行が表の列にまたがって並ぶ書類(請求書・見積書)を想定している */
const TEXT_OUTLIER_LINE_RATIO = 0.3;
/** 行単独での隙間（内部の自由記述の分割等との区別に使う）を認識する最小幅(pt) */
const PER_LINE_GAP_MIN_WIDTH_PT = 2.5;
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
/** 隙間なくつながった項目(隙間が文字の高さの0.3倍未満)を1つの連なりにして、範囲を返す */
function touchingRuns(items: PositionedTextItem[]): { left: number; right: number; fontHeight: number; text: string }[] {
  const runs: { left: number; right: number; fontHeight: number; text: string }[] = [];
  for (const item of items) {
    const right = item.x + item.width;
    const last = runs[runs.length - 1];
    if (last && item.x - last.right < Math.min(last.fontHeight, item.fontHeight) * 0.3) {
      last.right = Math.max(last.right, right);
      last.fontHeight = Math.max(last.fontHeight, item.fontHeight);
      last.text += item.str;
    } else {
      runs.push({ left: item.x, right, fontHeight: item.fontHeight, text: item.str });
    }
  }
  return runs;
}

function pageCandidateGapRanges(lines: Line[], noisyBoxes = false): [number, number][] {
  const contentItems = lines.flatMap((line) => line.items);
  if (contentItems.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  for (const item of contentItems) {
    minX = Math.min(minX, item.x);
    maxX = Math.max(maxX, item.x + item.width);
  }
  if (!Number.isFinite(minX) || maxX <= minX) return [];

  // 各x位置(1pt刻み)に「文字がかかっている行」が何行あるかを数える。
  // 以前は「1文字でもかかっていればその位置は埋まっている」としていたため、
  // 表のタイトルや注記のような、表全体に横断する数行の外れ値の行が
  // 本物の列区切りを全部塞いでしまい、列が1つも見つからないことがあった
  // （例: 字間を広げたタイトル行が、数値列の間の細い隙間をまたぐ）。
  // 行数が多いページに限り、ごく少数(全体の約3%まで)の行は外れ値として許容する。
  const binCount = Math.max(1, Math.ceil((maxX - minX) / BIN_SIZE_PT) + 1);
  const coverCount = new Uint16Array(binCount);
  const stamp = new Int32Array(binCount).fill(-1);
  // 「短い文字列(1つの列に収まる程度の値)」がかかっている行数。長い文字列(複数の列にまたがる
  // 文章・ラベル)だけがかかっている位置と区別するために使う。
  const narrowCount = new Uint16Array(binCount);
  const narrowStamp = new Int32Array(binCount).fill(-1);
  lines.forEach((line, lineIndex) => {
    for (const run of touchingRuns(line.items)) {
      const startBin = Math.max(0, Math.floor((run.left - minX) / BIN_SIZE_PT));
      const endBin = Math.min(binCount, Math.ceil((run.right - minX) / BIN_SIZE_PT));
      // 数値・日付は、幅が広くても1つの列に収まる値(別の列にまたがる文章ではない)なので「短い値」として扱う
      const isWide =
        run.right - run.left >= run.fontHeight * WIDE_RUN_FONT_RATIO &&
        tryParseNumberCell(run.text.trim()) === null &&
        tryParseDateCell(run.text.trim()) === null;
      for (let b = startBin; b < endBin; b++) {
        if (stamp[b] !== lineIndex) {
          stamp[b] = lineIndex;
          coverCount[b]++;
        }
        if (!isWide && narrowStamp[b] !== lineIndex) {
          narrowStamp[b] = lineIndex;
          narrowCount[b]++;
        }
      }
    }
  });
  // 外れ値の行を許容する。請求書の「小計」「消費税(10%)」や、その上の「請求日：…」のように、
  // 隣の列の位置まで伸びる長い文字列の行があっても、列区切りが消えないようにするため。
  // ただし許容するのは「長い文字列だけがかかっている位置」に限る。1つの列に収まる短い値
  // (数量の列の「1」「3」など)がかかっている位置は、行数が少なくても本物の列なので隙間にしない。
  // 8行以上の場合は約3割の行まで、4〜7行の場合は1行まで許容する。
  // OCR(スキャン画像)の文字の枠は実際の文字より広く検出されることがある(1つの漢字の枠が
  // 隣の列にはみ出す等)ため、OCRの場合は長さを問わず、4行以上あれば約1割(切り上げ)まで許容する。
  // どちらも、本物の列区切りかどうかは、この後の複数行での再現性チェックで確認される。
  const baseTolerance = Math.floor(lines.length * LEGACY_OUTLIER_LINE_RATIO);
  const wideRunTolerance = noisyBoxes
    ? lines.length >= 4
      ? Math.ceil(lines.length * OUTLIER_LINE_RATIO)
      : 0
    : lines.length >= 8
      ? Math.floor(lines.length * TEXT_OUTLIER_LINE_RATIO)
      : lines.length >= 4
        ? 1 // 4〜7行の小さな表でも、表全体にまたがる長い行(結合セルの注記・タイトル)は1行まで許容する
        : 0;
  // OCRの座標は画素単位で、1文字が約30画素ある。文字や単語のすき間(数画素)を列区切りと
  // 見間違えないよう、OCRでは「文字の高さの約半分」以上の隙間だけを候補にする。
  let minGapWidth = MIN_GAP_WIDTH_PT;
  if (noisyBoxes) {
    const heights = contentItems.map((i) => i.fontHeight).sort((a, b) => a - b);
    minGapWidth = Math.max(MIN_GAP_WIDTH_PT, heights[Math.floor(heights.length / 2)] * 0.5);
  }
  const isFree = (bin: number): boolean =>
    coverCount[bin] <= baseTolerance ||
    (coverCount[bin] <= wideRunTolerance && (noisyBoxes || narrowCount[bin] === 0));

  const ranges: [number, number][] = [];
  let gapStartBin: number | null = null;
  for (let b = 0; b < binCount; b++) {
    if (isFree(b)) {
      if (gapStartBin === null) gapStartBin = b;
      continue;
    }
    if (gapStartBin !== null) {
      const xStart = minX + gapStartBin * BIN_SIZE_PT;
      const xEnd = minX + b * BIN_SIZE_PT;
      if (xEnd - xStart >= minGapWidth) ranges.push([xStart, xEnd]);
      gapStartBin = null;
    }
  }
  // ループ終了時点でまだ隙間が続いている場合は、内容の右端より外側の
  // 余白（表の外側）なので列区切りとしては扱わない（意図的に無視する）
  return ranges;
}

/**
 * 1行「単独」で見た、隣り合うテキスト項目同士の隙間の一覧(開始x, 終了x)を返す。
 * 行頭・行末の「空セル」も隙間として数える（content: そのページの文字の左端・右端）。
 * 表の左端や右端の列が、その行では空欄(例: 右側の表で値の入っていない級の列)の場合、
 * 隣り合うテキスト同士の隙間としては現れないため、これを入れないと
 * 「空欄の多い列」の区切りが再現数不足で落ちてしまう。
 */
function perLineGapRanges(line: Line, minWidth: number, content?: { minX: number; maxX: number }): [number, number][] {
  const ranges: [number, number][] = [];
  if (content && line.items.length > 0) {
    const first = line.items[0];
    if (first.x - content.minX >= minWidth) ranges.push([content.minX, first.x]);
    const last = line.items[line.items.length - 1];
    if (content.maxX - (last.x + last.width) >= minWidth) ranges.push([last.x + last.width, content.maxX]);
  }
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
export function computeColumnBreaksAcrossPages(linesByPage: Line[][], options: { noisyBoxes?: boolean } = {}): number[] {
  const allLines = linesByPage.flat();
  if (allLines.length === 0) return [];

  const candidateRanges = linesByPage.flatMap((lines) => pageCandidateGapRanges(lines, options.noisyBoxes));
  const clustered = clusterCandidateRanges(candidateRanges, CANDIDATE_CLUSTER_PROXIMITY_PT);

  const perLineGapsByLine = linesByPage.flatMap((lines) => {
    const items = lines.flatMap((l) => l.items);
    if (items.length === 0) return [];
    const content = {
      minX: Math.min(...items.map((i) => i.x)),
      maxX: Math.max(...items.map((i) => i.x + i.width)),
    };
    return lines.map((line) => perLineGapRanges(line, PER_LINE_GAP_MIN_WIDTH_PT, content));
  });
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

  return merged.map((range) => refineBreakPosition(range, allLines));
}

/**
 * 列区切りの位置を、候補範囲の中点ではなく「文字が最もかからない位置」へ寄せる。
 * 外れ値として許容した少数の行(見出しなど)の文字が候補範囲の中に入り込んでいると、
 * 中点がその文字を真ん中で割ってしまうことがあるため。
 * 範囲内を0.5pt刻みで見て、文字がかかる行数が最小の区間のうち最も広いものの中央を返す。
 */
function refineBreakPosition(range: [number, number], lines: Line[]): number {
  const [start, end] = range;
  const step = 0.5;
  const samples = Math.max(1, Math.floor((end - start) / step));
  const counts = new Uint16Array(samples);
  for (const line of lines) {
    for (const item of line.items) {
      const x0 = item.x;
      const x1 = item.x + item.width;
      if (x1 <= start || x0 >= end) continue;
      const from = Math.max(0, Math.floor((x0 - start) / step));
      const to = Math.min(samples, Math.ceil((x1 - start) / step));
      for (let k = from; k < to; k++) counts[k]++;
    }
  }
  let min = Infinity;
  for (let k = 0; k < samples; k++) min = Math.min(min, counts[k]);
  let bestStart = 0;
  let bestLen = 0;
  let runStart = -1;
  for (let k = 0; k <= samples; k++) {
    if (k < samples && counts[k] === min) {
      if (runStart < 0) runStart = k;
    } else if (runStart >= 0) {
      if (k - runStart > bestLen) {
        bestLen = k - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen === 0) return (start + end) / 2;
  return start + (bestStart + bestLen / 2) * step;
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
  /** 列結合(colspan)の推定結果一覧（開発指示書§21-26）。 */
  columnSpans: ColumnSpanHint[];
  /** 各行の中心のy座標(PDFページ座標系)。rows.length と同じ長さ。縦書きラベルが何行にまたがるかの判定に使う */
  rowYs: number[];
  /** 各列の内容の位置・型の統計(左右に並んだ表の検出などに使う)。columnCount と同じ長さ */
  columnInfo: ColumnInfo[];
  /**
   * 各セルに入った文字の左端x・右端x(セルが空ならnull)。rows と同じ形。
   * 複数行に割れた見出し(「職員」「の」「区分」)を、位置が揃っているかで1つにまとめる判定に使う
   */
  cellExtents: ({ left: number; right: number } | null)[][];
  /** 各行のフォントの大きさの代表値(行間の判定に使う) */
  rowFontHeights: number[];
}

/** 1つの列の内容の統計。「結合セル」(列をまたぐ項目)は含めない */
export interface ColumnInfo {
  /** この列に入った項目の左端x・右端xの中央値 */
  left: number;
  right: number;
  /** 空でないセルの数 */
  filled: number;
  /** そのうち数値として読めるセルの数 */
  numeric: number;
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
  const rawLines = groupIntoLines(items);
  if (rawLines.length === 0) {
    return {
      rows: [],
      columnCount: 0,
      rowBoundariesY: [],
      colBoundariesX: [],
      columnSpans: [],
      rowYs: [],
      columnInfo: [],
      cellExtents: [],
      rowFontHeights: [],
    };
  }

  const breaks = breaksOverride ?? computeColumnBreaks(rawLines);
  const columnCount = breaks.length + 1;

  // 字間を広げたタイトル(「高 等 学 校 …」のように1文字ずつ別の項目になっているもの)は
  // 1つの文字列へまとめる。列の推定自体は元の項目で行い、行の組み立てからまとめた項目を使う。
  const lines: Line[] = mergeWrappedContinuationLines(
    rawLines.map((line) => ({
      y: line.y,
      items: mergeTouchingRunsAcrossBreaks(mergeSpacedCharacterRuns(line.items, breaks), breaks),
    })),
    breaks
  );

  const rows: string[][] = [];
  const columnSpans: ColumnSpanHint[] = [];
  const colLefts: number[][] = Array.from({ length: columnCount }, () => []);
  const colRights: number[][] = Array.from({ length: columnCount }, () => []);
  const colFilled: number[] = new Array(columnCount).fill(0);
  const colNumeric: number[] = new Array(columnCount).fill(0);

  const cellExtents: ({ left: number; right: number } | null)[][] = [];
  lines.forEach((line, rowIndex) => {
    const row: PositionedTextItem[][] = Array.from({ length: columnCount }, () => []);
    for (const item of line.items) {
      const startCol = Math.min(columnCount - 1, columnIndexFor(item.x, breaks));
      const endCol = Math.min(columnCount - 1, columnIndexFor(item.x + item.width, breaks));
      row[startCol].push(item);
      if (startCol === endCol) {
        // 列の位置の統計には、1つの列に収まっている項目だけを入れる。
        // 列をまたぐ項目(結合セル・タイトル・長い注記)は、またいだ範囲の「先頭の列」に置く
        // (中点の列に置くと、結合セルにしたとき先頭以外のセルは捨てられるため、文字が消えてしまう)。
        colLefts[startCol].push(item.x);
        colRights[startCol].push(item.x + item.width);
      }
    }
    const cells = row.map((parts) => joinCellItems(parts));
    cellExtents.push(
      row.map((parts) =>
        parts.length === 0
          ? null
          : {
              left: Math.min(...parts.map((p) => p.x)),
              right: Math.max(...parts.map((p) => p.x + p.width)),
            }
      )
    );
    cells.forEach((text, c) => {
      if (text === "") return;
      colFilled[c]++;
      if (tryParseNumberCell(text) !== null) colNumeric[c]++;
    });
    rows.push(cells);

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

  const columnInfo: ColumnInfo[] = Array.from({ length: columnCount }, (_, c) => ({
    left: median(colLefts[c]),
    right: median(colRights[c]),
    filled: colFilled[c],
    numeric: colNumeric[c],
  }));

  return {
    rows,
    columnCount,
    rowBoundariesY,
    colBoundariesX,
    columnSpans,
    rowYs: lines.map((l) => l.y),
    columnInfo,
    cellExtents,
    rowFontHeights: lines.map((l) => averageItemFontHeight(l.items)),
  };
}

/**
 * 1つのセルに入る複数の項目を、1つの文字列にする。
 * 隣り合う項目がほぼ接している(「[」と「令和８年勧告」など)場合は、
 * 余計な空白を入れずにそのままつなぐ。
 */
function joinCellItems(parts: PositionedTextItem[]): string {
  let out = "";
  parts.forEach((part, i) => {
    const text = part.str.replace(/\s+/g, " ").trim();
    if (text === "") return;
    if (out !== "" && i > 0) {
      const prev = parts[i - 1];
      const gap = part.x - (prev.x + prev.width);
      out += gap < Math.max(part.fontHeight, prev.fontHeight) * 0.25 ? "" : " ";
    }
    out += text;
  });
  return out.trim();
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// 字間を広げたタイトルの結合
// ---------------------------------------------------------------------------

/** 数字・記号ではなく、文字(漢字・かな・英字)の1文字だけの項目か */
function isSingleLetter(item: PositionedTextItem): boolean {
  const t = item.str.trim();
  return [...t].length === 1 && /\p{L}/u.test(t);
}

/**
 * 1行の中で、1文字ずつ等間隔に離れて並んでいる文字の並び(「高 等 学 校 教 育」のような
 * 字間を広げたタイトル)を1つの項目へまとめる。
 *
 * 見出しの1文字ずつ(「月 火 水 木 金」など)が列ごとに並んでいる表と区別するため、
 * 「並びの中に、同じ列に2文字以上入っている」場合だけまとめる
 * （列ごとに1文字ずつ入っているなら、それは列の見出しとして残す）。
 */
function mergeSpacedCharacterRuns(items: PositionedTextItem[], breaks: number[]): PositionedTextItem[] {
  const out: PositionedTextItem[] = [];
  let i = 0;
  while (i < items.length) {
    if (!isSingleLetter(items[i])) {
      out.push(items[i++]);
      continue;
    }
    // iから、等間隔の1文字項目の並びを伸ばす
    let j = i + 1;
    while (
      j < items.length &&
      isSingleLetter(items[j]) &&
      Math.abs(items[j].fontHeight - items[i].fontHeight) <= items[i].fontHeight * 0.15
    ) {
      j++;
    }
    const run = items.slice(i, j);
    if (run.length >= 4 && isEvenlySpaced(run) && sharesAColumn(run, breaks)) {
      const first = run[0];
      const last = run[run.length - 1];
      out.push({
        ...first,
        str: run.map((r) => r.str.trim()).join(""),
        width: last.x + last.width - first.x,
      });
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

/**
 * セルの中で折り返された文章(2行目以降)を、1つ上の行の同じセルにつなげる。
 *
 * 折り返しの2行目は、PDFの上では「別の行」として取り出されるため、そのままだと
 * Excelで1つのセルの文章が複数の行に分かれてしまう。次の条件がすべて揃うときだけつなげる:
 *  - その行の文字が1つの列だけにある(ほかの列は空)
 *  - 1つ上の行は複数の列に値がある(=表の行であり、ただの文章の段落ではない)
 *  - 1つ上の行の同じ列にも文字がある。その文章が列の右端近くまで届いていて(折り返した証拠)、
 *    2行目の左端が同じ位置にそろっている
 *  - 行の間隔が文字の高さの約0.8〜1.9倍(セルの上下の余白を含む通常の行間より狭い)
 */
function mergeWrappedContinuationLines(lines: Line[], breaks: number[]): Line[] {
  if (lines.length < 3 || breaks.length === 0) return lines;
  const maxRight = Math.max(...lines.flatMap((l) => l.items.map((i) => i.x + i.width)));
  const colOf = (item: PositionedTextItem) => columnIndexFor(item.x, breaks);
  // 結合後の行ごとに、最初の行のy・最後の行のy(折り返しがあれば下の行)を持つ
  const out: { line: Line; startY: number; endY: number }[] = [];
  for (const line of lines) {
    const cur = out[out.length - 1];
    const before = out[out.length - 2];
    const items = line.items.filter((i) => i.str.trim() !== "");
    let merged = false;
    if (cur && before && items.length > 0) {
      const cols = new Set(items.map(colOf));
      const col = colOf(items[0]);
      const prevItems = cur.line.items.filter((i) => i.str.trim() !== "");
      const prevCols = new Set(prevItems.map(colOf));
      const prevInCol = prevItems.filter((i) => colOf(i) === col);
      if (cols.size === 1 && prevCols.size >= 2 && prevInCol.length > 0) {
        const fh = median(items.map((i) => i.fontHeight));
        const pitch = cur.endY - line.y;
        // 通常の行どうしの間隔(1つ前の行の最後〜この行の最初)より、明らかに狭いこと。
        // 全部の行が同じ間隔で並ぶ詰まった表(折り返しではない)を結合しないための条件
        const rowPitch = before.endY - cur.startY;
        const colRight = col < breaks.length ? breaks[col] : maxRight;
        const prevRight = Math.max(...prevInCol.map((i) => i.x + i.width));
        const prevLeft = Math.min(...prevInCol.map((i) => i.x));
        const left = Math.min(...items.map((i) => i.x));
        const text = items.map((i) => i.str).join("");
        if (
          pitch >= fh * 0.8 &&
          pitch <= fh * 1.9 &&
          pitch < rowPitch * 0.85 &&
          prevRight >= colRight - fh * 2.5 &&
          Math.abs(left - prevLeft) <= fh * 1.5 &&
          tryParseNumberCell(text.trim()) === null
        ) {
          // 英数字どうしがつながる折り返しは、単語の間に空白が入るよう、位置を少しずらす
          const last = prevInCol[prevInCol.length - 1];
          const needsSpace = /[A-Za-z0-9]$/.test(last.str.trim()) && /^[A-Za-z0-9]/.test(items[0].str.trim());
          const shifted = items.map((it, k) => (k === 0 && needsSpace ? { ...it, x: last.x + last.width + it.fontHeight * 0.3 } : it));
          cur.line.items = [...cur.line.items, ...shifted];
          cur.endY = line.y;
          merged = true;
        }
      }
    }
    if (!merged) out.push({ line: { y: line.y, items: line.items }, startY: line.y, endY: line.y });
  }
  return out.map((o) => o.line);
}

/**
 * 隙間なくつながった文章が、列区切りの位置で途中から切れてしまうのを防ぐ。
 * PDFでは1つの文が、フォントや文字種の切り替わりごとに複数の項目に分かれることがある
 * (「請求日：2026」+「年10月30日」、「見積内訳」の文字ごと等)。ほかの行の隙間が
 * たまたまその位置にそろって列区切りになっていると、文章の途中で別のセルに分かれてしまう。
 * 項目同士の隙間が文字の高さの0.3倍未満(=実質的に接している)で、その並びが列区切りを
 * またぐ場合は、1つの項目にまとめる(まとめた項目は、列をまたぐセル=結合セルとして扱われる)。
 * 数値同士(隣の列の数値が接近している場合)は、別々の列の値なのでまとめない。
 */
function mergeTouchingRunsAcrossBreaks(items: PositionedTextItem[], breaks: number[]): PositionedTextItem[] {
  if (breaks.length === 0 || items.length < 2) return items;
  const out: PositionedTextItem[] = [];
  let run: PositionedTextItem[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      const first = run[0];
      const last = run[run.length - 1];
      const startCol = columnIndexFor(first.x, breaks);
      const endCol = columnIndexFor(last.x + last.width, breaks);
      if (endCol > startCol) {
        out.push({ ...first, str: run.map((r) => r.str).join(""), width: last.x + last.width - first.x, hasEOL: last.hasEOL });
      } else {
        out.push(...run);
      }
    }
    run = [];
  };
  for (const item of items) {
    const prev = run[run.length - 1];
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      const touching = gap < Math.min(prev.fontHeight, item.fontHeight) * 0.3;
      const bothNumbers = tryParseNumberCell(prev.str) !== null && tryParseNumberCell(item.str) !== null;
      if (!touching || bothNumbers) flush();
    }
    run.push(item);
  }
  flush();
  return out;
}

function isEvenlySpaced(run: PositionedTextItem[]): boolean {
  const pitches: number[] = [];
  for (let k = 1; k < run.length; k++) pitches.push(run[k].x - run[k - 1].x);
  const med = median(pitches);
  const charWidth = median(run.map((r) => r.width));
  // 字間が文字幅の1.3倍以上(明らかに離れている)で、どの間隔も中央値から1割以内(「基準」のような2文字ずつが列ごとに並ぶ見出しを除くため厳しめにしている)
  return med >= charWidth * 1.3 && pitches.every((p) => Math.abs(p - med) <= med * 0.1);
}

function sharesAColumn(run: PositionedTextItem[], breaks: number[]): boolean {
  const seen = new Set<number>();
  for (const r of run) {
    const col = columnIndexFor(r.x + r.width / 2, breaks);
    if (seen.has(col)) return true;
    seen.add(col);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 縦書きのラベル（セルの左右の余白に1文字ずつ縦に並んだ文字）
// ---------------------------------------------------------------------------

/** 縦に1文字ずつ並んでいた文字列(縦書きの区分名など) */
export interface VerticalLabel {
  text: string;
  /** 文字が並んでいた列のx座標と幅 */
  x: number;
  width: number;
  /** 先頭の文字・末尾の文字のy座標(PDFページ座標系。yTop >= yBottom) */
  yTop: number;
  yBottom: number;
  fontHeight: number;
}

const VERTICAL_RUN_MIN_CHARS = 6;

/**
 * 縦書きのラベル（1文字ずつ縦に並んだ文字の列）を項目の一覧から取り出す。
 * 取り出さないと、1文字ずつが別々の行として表に混ざってしまう
 * （「定 24 269,300」のように、数値の行の先頭に文字が1つずつ付いてしまう）。
 *
 * 誤検出を避けるため、次の条件をすべて満たす並びだけを縦書きとみなす:
 * - 1文字(数字以外)の項目が、ほぼ同じx座標で6文字以上、上から下に連続している
 * - 隣り合う文字の間隔が、文字の大きさに近い(詰めて縦に並んでいる)
 * - 6文字の中に同じ文字が多くない(「男」「女」が並ぶ性別の列などを除く)
 */
export function extractVerticalLabels(items: PositionedTextItem[]): {
  items: PositionedTextItem[];
  labels: VerticalLabel[];
} {
  const candidates = items.filter((item) => {
    const t = item.str.trim();
    return [...t].length === 1 && !/[\p{N}]/u.test(t) && item.fontHeight > 0;
  });
  if (candidates.length < VERTICAL_RUN_MIN_CHARS) return { items, labels: [] };

  // x座標が近いものを同じ縦の並びの候補としてまとめる
  const sorted = [...candidates].sort((a, b) => a.x - b.x || b.y - a.y);
  const groups: PositionedTextItem[][] = [];
  for (const item of sorted) {
    const g = groups.find(
      (grp) => Math.abs(grp[0].x - item.x) <= 1.5 && Math.abs(grp[0].fontHeight - item.fontHeight) <= 0.8
    );
    if (g) g.push(item);
    else groups.push([item]);
  }

  const labels: VerticalLabel[] = [];
  const removed = new Set<PositionedTextItem>();
  for (const group of groups) {
    group.sort((a, b) => b.y - a.y);
    let run: PositionedTextItem[] = [];
    const flush = () => {
      if (isVerticalRun(run)) {
        labels.push({
          text: run.map((r) => r.str.trim()).join(""),
          x: Math.min(...run.map((r) => r.x)),
          width: Math.max(...run.map((r) => r.width)),
          yTop: run[0].y,
          yBottom: run[run.length - 1].y,
          fontHeight: run[0].fontHeight,
        });
        run.forEach((r) => removed.add(r));
      }
      run = [];
    };
    for (const item of group) {
      const prev = run[run.length - 1];
      if (prev) {
        const pitch = prev.y - item.y;
        const ratio = pitch / item.fontHeight;
        if (ratio < 0.85 || ratio > 1.5) flush();
      }
      run.push(item);
    }
    flush();
  }

  if (labels.length === 0) return { items, labels: [] };
  labels.sort((a, b) => a.x - b.x || b.yTop - a.yTop);
  return { items: items.filter((item) => !removed.has(item)), labels };
}

function isVerticalRun(run: PositionedTextItem[]): boolean {
  if (run.length < VERTICAL_RUN_MIN_CHARS) return false;
  const distinct = new Set(run.map((r) => r.str.trim())).size;
  return distinct / run.length >= 0.5;
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
  // 先頭が0の数字列(001・03-1234のような番号、郵便番号、コード等)は、0が消えないよう文字列のまま扱う
  if (/^[+-]?0\d/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function safeDate(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // write-excel-file はDateをUTC基準でExcelのシリアル値に変換する。ローカル時刻の0時で作ると
  // 日本(UTC+9)のブラウザでは前日の15:00(UTC)になり、Excel上で1日前の日付になってしまうため、
  // UTCの0時で作る(カレンダー作成ツールと同じ扱い)。
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
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
