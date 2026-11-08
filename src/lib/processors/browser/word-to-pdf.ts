import type { PDFFont, PDFPage } from "pdf-lib";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { addLinkAnnotation } from "@/lib/pdf/pdf-link-annotation";
import { parseWordDocumentStructure, type BodyChildHint, type DefaultParagraphSpacing } from "@/lib/word/section-settings";
import {
  OBJECT_CHAR,
  type FloatObject,
  parseDocxFormatting,
  PAGE_NUMBER_CHAR,
  PAGE_COUNT_CHAR,
  type BorderFmt,
  type DocxFormatting,
  type HeaderFooterFmt,
  type ParaFmt,
  type ParaObject,
  type RunFmt,
  type TableFmt,
} from "@/lib/word/docx-format";
import { fontMetricsFor, isEastAsianChar } from "@/lib/fonts/office-font-metrics";
import { KINSOKU_LINE_END, KINSOKU_STANDARD_START, KINSOKU_STRICT_START, layoutParagraph, type BreakRules, type LayoutLine, type TabStopSpec } from "@/lib/word/word-layout";
import type * as PdfLibTypes from "pdf-lib";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";

/**
 * Word（DOCX）→ PDF Processor（Phase 9、Phase 18.2 C節で用紙設定・改ページ対応を強化）。
 *
 * 開発指示書■10・E章の方針どおり、「Wordと見た目が完全一致すること」は保証しない。
 * 目標は「Wordの1印刷ページ = PDFの1ページ」にできるだけ近づけつつ、
 * 段落・見出し・太字/斜体/下線・箇条書き・番号付きリスト・改ページ・表・
 * 画像・リンクといった基本要素を、実際に開けるPDFへ実用的な精度で変換すること。
 *
 * 変換方式（■5・■11、Phase 18.2 C節）:
 *   DOCX
 *    → mammoth（DOCX→HTMLの定番ライブラリ。BSD-2-Clauseライセンス・
 *      ブラウザ向けエントリを公式に持つ。新規追加した唯一の依存パッケージ）
 *    → HTML文字列
 *    → DOMParser（ブラウザ標準API）でDOM構造として解析
 *      ※ DOMParserが生成するDocumentはページに一切アタッチされないため、
 *        <script>は実行されず、<img>等の外部リソースも自動取得されない
 *        （■11・■12: 生成HTMLをそのままinnerHTML/dangerouslySetInnerHTMLで
 *        DOMへ挿入しない、危険なコンテンツを安全に扱う、という要件を満たす）。
 *        また、テキスト・タグ構造のみを読み取り、DOM自体を表示に使わないため
 *        独立したサニタイズライブラリは追加していない。
 *    → 内部ドキュメントモデル（段落/見出し/リスト/表/画像/改ページ）
 *    → pdf-lib + 既存の日本語TrueTypeフォント資産（Noto Sans JP）でPDFへ描画・ページ分割
 *
 * 用紙サイズ・向き・余白（開発指示書C-3・C-4・C-8）について: mammothは見出し・
 * 段落・書式等の「内容」だけをHTML化し、セクション区切り(w:sectPr)・用紙サイズ
 * (w:pgSz)・余白(w:pgMar)・「段落の前で改ページ」(w:pageBreakBefore)といった
 * 「ページ構造」の情報はmammothの中間ドキュメントモデルの時点で読み捨てられる
 * （node_modules/mammoth/lib/docx/body-reader.js のignoreElementsで確認済み）。
 * そのため、Excel側(ooxml-page-settings.ts)と同じ方針で、新しい巨大なWord解析
 * ライブラリを追加する代わりに、src/lib/word/section-settings.ts が
 * word/document.xmlを直接読み、最初のセクションの用紙サイズ・向き・余白を
 * 文書全体に適用する（■C-11: DOCXは複数セクション毎に異なる用紙設定を
 * 持てるが、本実装では「最初のセクションの設定を全体へ適用し、2個目以降の
 * セクションがあれば警告を出す」までを対応範囲とする。取得できない場合は
 * 既定値(A4・既定余白)にフォールバックする）。
 *
 * 明示的な改ページ（開発指示書C-9）について: 従来からの
 * w:br(type="page")によるものに加え、Phase 18.2で
 * w:pageBreakBefore（段落プロパティによる改ページ）も、mammothの
 * transformDocumentフック内でword/document.xmlの解析結果と対応付けて
 * ページ区切りマーカー段落へ変換するようにした（詳細は下記の関数群を参照）。
 *
 * フォントについて: 既存資産はNoto Sans JPのRegularウェイトのみのため
 * （■15: 新しいフォントファイルは追加しない）、太字はPDFのテキスト描画モードを
 * 一時的に「塗り+縁取り(FillAndOutline)」に切り替えて縁取りを太らせる疑似ボールド、
 * 斜体はpdf-libのxSkewでの疑似イタリックで近似する。
 * 太字を「同じ文字を僅かにずらして2回描画する」方式にすると、PDFのテキスト
 * レイヤーに同じ文字列が2回出現してしまい、コピー&ペーストや検索で太字部分が
 * 重複してしまう副作用があるため採用しなかった（drawText呼び出しは1回のまま、
 * テキスト描画モードのみ切り替える）。実際のBold/Italicフォントの字形とは
 * 異なる（■10のとおり完全一致は保証しない）が、視覚的に区別できることを
 * 優先した。
 */

/** DOCXから用紙設定が取得できなかった場合のフォールバック値（従来のPhase 9のA4/56pt） */
const DEFAULT_PAGE_WIDTH = 595.28;
const DEFAULT_PAGE_HEIGHT = 841.89;
const DEFAULT_MARGIN = 56;
const BODY_SIZE = 10.5;
/** 段落後の間隔が文書側から全く取得できなかった場合のみ使うフォールバック値
 *  （外出先PC修正指示書§32-35対応前の旧固定値。取得できた場合はresolveParagraphGapが
 *  実際の文書設定(Normalスタイルのw:after)から計算した値を優先する） */
const PARAGRAPH_GAP = 6;
/** Wordの「単一行間隔」は行間が正確に1.0倍というわけではなく、フォントの
 *  行間メトリクスを踏まえて概ね1.1〜1.2倍程度になる（実機のWord/LibreOffice出力
 *  で確認）。行間の指定が全く取得できない場合の近似係数として使う。 */
const SINGLE_LINE_SPACING_FACTOR = 1.15;

/** 文書の標準のフォント(英数字用・日本語用)から、「1行」の高さの倍率を決める(大きいほう) */
function lineFactorForFonts(fonts: { ascii: string | null; eastAsia: string | null }): number {
  return Math.max(fontMetricsFor(fonts.ascii).lineFactor, fonts.eastAsia ? fontMetricsFor(fonts.eastAsia).lineFactor : 0);
}

/**
 * 実際の行の高さ(pt)を、文書既定の行間設定(DefaultParagraphSpacing)・
 * 描画するテキストのフォントサイズ・行グリッド線のピッチ(gridLinePitchPt)から
 * 計算する（外出先PC修正指示書§32-35、および「Excel通りになってない」調査の
 * 過程で判明した日本語文書の行グリッド未対応の追加修正）。
 *
 * 【背景1】以前は本文の行間を、フォントサイズに関係なく常に15pt固定で計算していた。
 * 10.5pt本文に対する15pt行間は倍率にして約1.43倍であり、
 * Wordの「単一行間隔」(概ね1.1〜1.2倍)よりも常に広い。これが積み重なることで
 * 「Wordでは1ページに収まる文書がPDFでは2ページ目にあふれる」不具合の
 * 主要因の1つになっていた（もう1つの要因はparagraphGap、下記参照）。
 *
 * 【背景2】日本語のWord文書で「ページ設定→文字数と行数を指定する」が有効な
 * 場合(w:docGrid@w:type="lines"/"linesAndChars")、段落のw:spacingにexact指定が
 * 無い限り、実際の行の高さはフォントサイズに関わらずこのグリッドのピッチ
 * (多くは18pt前後)の倍数に切り上げられる。この挙動を反映していなかったため、
 * グリッド線を使う文書では行間を実際より狭く見積もり、本来のWordより多くの
 * 行が1ページに収まってしまい、ページの区切り位置がずれる不具合があった
 * （個々の段落のw:snapToGrid無効化までは追跡しない。ほとんどの文書では
 * 既定どおり全段落で有効なため、この近似で実用上は十分カバーできる）。
 */
function resolveLineHeight(spacing: DefaultParagraphSpacing, size: number, gridLinePitchPt: number | null, lineFactor = SINGLE_LINE_SPACING_FACTOR): number {
  if (spacing.lineRule === "exact" && spacing.lineValue !== null) {
    // exact指定は行グリッドより優先される(Word自体の挙動)
    return spacing.lineValue;
  }
  let natural: number;
  if (spacing.lineRule === "atLeast" && spacing.lineValue !== null) {
    natural = Math.max(spacing.lineValue, size * lineFactor);
  } else if (spacing.lineRule === "auto" && spacing.lineValue !== null) {
    const multiplier = spacing.lineValue / 240; // 240 = 1行(単一間隔)
    natural = size * lineFactor * multiplier;
  } else {
    // 文書側から行間情報が全く取得できなかった場合: 従来の固定値(15pt)ではなく、
    // Wordの単一行間隔によりまだ近いフォントサイズ比例の値にフォールバックする
    natural = size * lineFactor;
  }
  if (gridLinePitchPt && gridLinePitchPt > 0) {
    return Math.ceil(natural / gridLinePitchPt) * gridLinePitchPt;
  }
  return natural;
}

/**
 * 段落後の間隔(pt)を、文書既定の段落間隔設定から計算する（外出先PC修正指示書§32-35）。
 * 個々の段落単位のw:after上書きまでは追跡しないため(段落ごとのインデックス対応が
 * 難しいため。section-settings.tsのコメント参照)、文書既定(Normalスタイル)の値を
 * 全ての本文段落に適用する。取得できなければ従来の固定値(6pt)にフォールバックする。
 *
 * 【行グリッド(w:docGrid type="lines"/"linesAndChars")が有効な文書での例外】
 * このグリッドが有効な日本語文書では、行の高さ自体がグリッドのピッチ(多くは
 * 18pt前後)へ切り上げられる(resolveLineHeight参照)。このグリッドは本来、
 * 段落間の目に見える間隔そのものを行間隔(=ピッチ)でまかなう設計であり、
 * 明示的なw:afterが無い場合にまで追加で固定値(6pt)を上乗せすると、
 * 「行の高さの底上げ」と「段落間隔の上乗せ」が二重に効いてしまい、実際の
 * Wordより大幅にページが増えてしまう不具合が実測で確認された（2ページの
 * 文書が3ページになる）。そのため、グリッドが有効かつw:afterの明示指定が
 * 無い場合に限り、フォールバックを0ptとする(明示指定があれば従来どおり
 * その値を優先する。グリッド無効の文書は従来の6ptのまま、挙動を変えない)。
 */
function resolveParagraphGap(spacing: DefaultParagraphSpacing, gridLinePitchPt: number | null): number {
  if (spacing.afterPt !== null) return spacing.afterPt;
  if (gridLinePitchPt && gridLinePitchPt > 0) return 0;
  return PARAGRAPH_GAP;
}

/** 未検証のDOCXを信頼しないための安全策（■18・■34）。妥当なDOCXは通常これより
 *  はるかに小さいため、この上限自体がZIP爆弾的な入力への一次防御になる。 */
const MAX_DOCX_SIZE_BYTES = 30 * 1024 * 1024;
/** 1枚あたりの画像デコード後サイズの上限（巨大画像によるメモリ逼迫を防ぐ） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_COUNT = 300;
/**
 * 空のWord段落(開発指示書C-2〜C-4、Phase 22)を検出するためのマーカー。
 *
 * mammothは中身が空のw:p(テキスト・改行・画像等、視覚要素を一切持たない段落)を
 * HTML化する際、<p></p>すら出力せずHTMLから完全に消してしまうことを実機検証で
 * 確認済み。そのため、明示的な改ページ(PAGE_BREAK_MARKER)と同じ手法で、mammothの
 * transformDocumentフックの時点(HTML化される前)で「空の段落」を検出し、
 * マーカー文字列を埋め込んだ段落へ置き換えることで、空段落の存在そのものを
 * HTMLへ保存する。htmlToBlocks側でこのマーカーを検出し、実際には空文字の
 * ParagraphBlock(runs: [])へ戻す。既存のPAGE_BREAK_MARKERと同じくPUA文字で
 * 囲むことで、実際の文書中のテキストと衝突しないようにしている。
 */
const EMPTY_PARAGRAPH_MARKER = "MRSATTO_EMPTY_PARAGRAPH";

const PAGE_BREAK_MARKER = "MRSATTO_PAGE_BREAK";

/**
 * 本文直下の段落の通し番号を、mammothのHTML変換を経由して htmlToBlocks まで伝えるためのマーカー。
 * word/document.xmlから読み取った書式（中央揃え・文字サイズ・色など）を、どの段落のものか
 * 取り違えずに対応づけるために使う（段落の先頭にテキストとして埋め込み、htmlToBlocksで取り除く）。
 */
const PARA_ID_MARKER_PREFIX = "MRSATTO_PARA_ID:";
const PARA_ID_MARKER_SUFFIX = "\uE010";

/**
 * ぶら下げインデント(w:ind w:hanging/hangingChars)を持つ段落の継続行に
 * 適用すべき左インデント量(pt)を、mammothのHTML変換を経由して
 * drawParagraphまで伝えるためのマーカー接頭辞・接尾辞（他のMRSATTO_*マーカーと
 * 同様にPUA文字で囲み、段落の先頭にテキストとして埋め込んで、htmlToBlocks側で
 * 検出・除去する）。
 */
const HANGING_INDENT_MARKER_PREFIX = "MRSATTO_HANGING_INDENT:";
const HANGING_INDENT_MARKER_SUFFIX = "";

/**
 * 1つのWordの段落を、途中の改ページ(w:br type="page")で分けたときの「続きの部分」の目印。
 * 「MRSATTO_PARA_CONT:段落の通し番号:始まりの文字の位置」＋終わりの文字を、続きの部分の先頭に埋め込み、htmlToBlocksで取り除く。
 */
const PARA_CONT_MARKER_PREFIX = "MRSATTO_PARA_CONT:";
const PARA_CONT_MARKER_SUFFIX = "\uE011";

// ---------------------------------------------------------------------------
// 内部ドキュメントモデル
// ---------------------------------------------------------------------------
interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
  /**
   * 段落の中の画像(text は画像の目印の文字 U+FFFC の1文字)。dataUri は画像のデータの鍵(data URI、または
   * 文書の中のファイルのパス word/media/…)。ordinal は本文の段落の中の画像の通し番号(表の中などは -1)。
   * w・h は文書に保存された大きさ(pt。分かるとき)
   */
  image?: InlineImageRef;
}
interface InlineImageRef {
  dataUri: string;
  ordinal: number;
  w?: number;
  h?: number;
}
interface ListMeta {
  ordered: boolean;
  level: number;
  number?: number;
}
interface ParagraphBlock {
  kind: "paragraph";
  runs: TextRun[];
  heading: number; // 0 = 通常段落, 1-6 = 見出しレベル
  list?: ListMeta;
  /** ぶら下げインデントの継続行用左インデント(pt)。HANGING_INDENT_MARKER_PREFIX参照 */
  hangingIndentPt?: number | null;
  /** word/document.xmlから読み取った、この段落の書式（読み取れた場合のみ） */
  fmt?: ParaFmt | null;
  /** 文字ごと（コードポイント単位）の書式。mammothの文字列と書式つきの文字列の長さが一致した場合のみ */
  charFmts?: RunFmt[] | null;
  /** 本文の何番目の要素(段落・表)か（word/document.xmlの本文直下の w:p・w:tbl の通し番号）。分かる場合のみ */
  bodyIndex?: number;
  /**
   * 同じWordの段落の続き（段落の途中の改ページ・画像の後ろの文字）のとき、その段落の文字の中の始まりの位置。
   * 続きの部分には、段落の前の間隔と1行目の字下げを付けない
   */
  contOffset?: number;
}
interface TableBlock {
  kind: "table";
  rows: TextRun[][][]; // rows[row][col] = そのセルのruns
  /** word/document.xmlから読み取った、表の書式（セル結合・背景色・列幅など。読み取れた場合のみ） */
  fmt?: TableFmt | null;
  bodyIndex?: number;
}
interface ImageBlock {
  kind: "image";
  dataUri: string;
  altText: string;
  /** 本文の段落の中の画像の通し番号（表の中の画像は数えない）。word/document.xmlの画像の大きさと対応づける */
  ordinal?: number;
  bodyIndex?: number;
}
interface PageBreakBlock {
  kind: "pagebreak";
  /** 段区切り(w:br type="column")。段組みのセクションでは次の段へ、段組みでなければ改ページ(Wordと同じ) */
  column?: boolean;
}
type DocBlock = ParagraphBlock | TableBlock | ImageBlock | PageBreakBlock;

// ---------------------------------------------------------------------------
// mammothの内部ドキュメントツリーを変換前に走査し、
// 明示的な改ページ(w:br type="page")を、後段のHTML走査で検出できる
// 目印つき段落に置き換える（mammothは既定では手動改ページをHTML化しない）。
// mammothの公開オプション transformDocument（options-reader.jsに定義された
// 正式なオプション）を利用する、型がゆるいプラグイン的な拡張ポイントのため
// unknown型で慎重に扱う。
// ---------------------------------------------------------------------------
function makePageBreakMarkerParagraph(): Record<string, unknown> {
  return {
    mrsattoMarker: true,
    type: "paragraph",
    styleId: null,
    styleName: null,
    numbering: null,
    alignment: null,
    indent: { start: null, end: null, firstLine: null, hanging: null },
    children: [
      {
        type: "run",
        styleId: null,
        styleName: null,
        isBold: false,
        isUnderline: false,
        isItalic: false,
        isStrikethrough: false,
        isAllCaps: false,
        isSmallCaps: false,
        verticalAlignment: "baseline",
        font: null,
        fontSize: null,
        highlight: null,
        children: [{ type: "text", value: PAGE_BREAK_MARKER }],
      },
    ],
  };
}

function markPageBreaks(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  let next: Record<string, unknown> = obj;
  if (Array.isArray(obj.children)) {
    next = { ...obj, children: obj.children.map(markPageBreaks) };
  }
  if (next.type === "break" && next.breakType === "page") {
    return makePageBreakMarkerParagraph();
  }
  return next;
}

/**
 * mammothに渡す前に、本文のテキストボックスの中身(w:txbxContent)を取り除く(ブラウザの中で、元のファイルの写しを作り直す)。
 * mammothはテキストボックスの中の段落を、本文の段落として、テキストボックスを置いた段落の後ろに並べる。そのため
 * 本文の段落の数が word/document.xml と合わなくなり、文書の書式(文字の大きさ・間隔・セクションなど)をすべて
 * 使えなくなっていた。テキストボックスは、元の位置に別に描く(word/document.xml から読んだ FloatObject)。
 */
function withoutTextBoxContent(arrayBuffer: ArrayBuffer): ArrayBuffer {
  try {
    const files = unzipSync(new Uint8Array(arrayBuffer));
    const docXml = files["word/document.xml"];
    if (!docXml) return arrayBuffer;
    const text = strFromU8(docXml);
    if (!text.includes("txbxContent")) return arrayBuffer;
    files["word/document.xml"] = strToU8(text.replace(/<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/g, "<w:txbxContent/>"));
    const out = zipSync(files, { level: 0 });
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  } catch {
    return arrayBuffer;
  }
}

/** mammothの中間木の節の、文字の数（書式つきの文字列 ParaFmt.runs と同じ数え方：文字・タブ・改行を1文字） */
function countNodeChars(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const o = node as Record<string, unknown>;
  if (o.type === "text" && typeof o.value === "string") {
    if (o.value.startsWith(PARA_ID_MARKER_PREFIX) || o.value.startsWith(HANGING_INDENT_MARKER_PREFIX) || o.value === EMPTY_PARAGRAPH_MARKER) return 0;
    return Array.from(o.value).length;
  }
  if (o.type === "tab") return 1;
  if (o.type === "break") return o.breakType === "line" || !o.breakType ? 1 : 0;
  if (Array.isArray(o.children)) return o.children.reduce((sum: number, c) => sum + countNodeChars(c), 0);
  return 0;
}

const hasPageBreakNode = (node: unknown): boolean => {
  if (!node || typeof node !== "object") return false;
  const o = node as Record<string, unknown>;
  if (o.type === "break" && o.breakType === "page") return true;
  return Array.isArray(o.children) && o.children.some(hasPageBreakNode);
};

/** 節を、最初の改ページの前と後に分ける（runやハイパーリンクの中の改ページにも対応） */
function splitAtFirstPageBreak(node: Record<string, unknown>): [Record<string, unknown>, Record<string, unknown>] | null {
  const children = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i] as Record<string, unknown>;
    if (!c || typeof c !== "object") continue;
    if (c.type === "break" && c.breakType === "page") {
      return [{ ...node, children: children.slice(0, i) }, { ...node, children: children.slice(i + 1) }];
    }
    if (hasPageBreakNode(c)) {
      const inner = splitAtFirstPageBreak(c);
      if (!inner) return null;
      return [{ ...node, children: [...children.slice(0, i), inner[0]] }, { ...node, children: [inner[1], ...children.slice(i + 1)] }];
    }
  }
  return null;
}

/**
 * 本文直下の段落の途中にある改ページ(w:br type="page")で、段落を「前の部分」「改ページの目印」「続きの部分」に分ける。
 * 以前は改ページを、段落の中に入れた目印の段落に置き換えていたため、HTMLの段落の入れ子が壊れ、改ページの後ろの文字が消えていた。
 * 続きの部分の先頭には、元の段落の通し番号と、続きの始まりの文字の位置を埋め込む（書式を正しく対応づけるため）。
 * 表の中などにある改ページは、従来どおり目印の段落に置き換える(markPageBreaks)。
 */
function splitTopLevelPageBreaks(documentNode: unknown): unknown {
  if (!documentNode || typeof documentNode !== "object") return documentNode;
  const obj = documentNode as Record<string, unknown>;
  if (!Array.isArray(obj.children)) return documentNode;
  const out: unknown[] = [];
  for (const child of obj.children) {
    const c = child as Record<string, unknown>;
    if (!c || typeof c !== "object" || c.type !== "paragraph" || !hasPageBreakNode(c)) {
      out.push(child);
      continue;
    }
    // 段落の通し番号(injectParaIdMarkersが先頭に入れた目印)
    const firstRun = Array.isArray(c.children) ? (c.children[0] as Record<string, unknown> | undefined) : undefined;
    const firstText = firstRun && Array.isArray(firstRun.children) ? (firstRun.children[0] as Record<string, unknown> | undefined) : undefined;
    const idText = typeof firstText?.value === "string" ? firstText.value : "";
    const paraId = idText.startsWith(PARA_ID_MARKER_PREFIX) ? parseInt(idText.slice(PARA_ID_MARKER_PREFIX.length), 10) : NaN;
    let rest: Record<string, unknown> = c;
    let offset = 0;
    for (let guard = 0; guard < 500; guard++) {
      const parts = splitAtFirstPageBreak(rest);
      if (!parts) break;
      const [before, after] = parts;
      out.push(before);
      out.push(makePageBreakMarkerParagraph());
      offset += countNodeChars(before);
      const marker = {
        ...(makeEmptyParagraphMarkerRun() as Record<string, unknown>),
        children: [{ type: "text", value: `${PARA_CONT_MARKER_PREFIX}${Number.isInteger(paraId) ? paraId : -1}:${offset}${PARA_CONT_MARKER_SUFFIX}` }],
      };
      const afterChildren = Array.isArray(after.children) ? after.children : [];
      rest = { ...after, children: [marker, ...afterChildren] };
    }
    // 改ページの後ろに文字が無ければ、続きの部分は出さない(改ページだけの段落)
    if (countNodeChars(rest) > 0) out.push(rest);
  }
  return { ...obj, children: out };
}

/**
 * w:pageBreakBefore（段落プロパティによる明示的な改ページ、開発指示書C-9）を
 * ページ区切りマーカー段落として文書ツリーの先頭(Document.children)へ挿入する。
 *
 * mammothの中間ドキュメントモデルはw:pageBreakBefore自体を保持しないため
 * （body-reader.jsで未対応）、word/document.xmlを直接読んだ結果(bodyHints、
 * src/lib/word/section-settings.ts参照)と、mammothが返す文書本文直下の
 * children配列とを「段落(paragraph)・表(table)ノードだけを対象に、出現順で
 * 対応付ける」ことで実現する。本文直下のw:p/w:tblは、mammoth側でも
 * ignoreElements（w:sectPr等）以外は1つずつそのままDocument.childrenの
 * ノードになる（body-reader.jsで確認済み）ため、対象をparagraph/tableに
 * 限定する限りインデックスがずれない。
 *
 * 文書の一番最初の段落の前には(そもそも直前ページが存在しないため)挿入しない。
 */
function injectPageBreakBeforeMarkers(documentNode: unknown, bodyHints: BodyChildHint[]): unknown {
  if (!documentNode || typeof documentNode !== "object") return documentNode;
  const obj = documentNode as Record<string, unknown>;
  if (!Array.isArray(obj.children)) return documentNode;

  let hintIndex = 0;
  const nextChildren: unknown[] = [];
  for (const child of obj.children) {
    const isParagraphNode = child !== null && typeof child === "object" && (child as Record<string, unknown>).type === "paragraph";
    const isTopLevelContentNode = isParagraphNode || (child !== null && typeof child === "object" && (child as Record<string, unknown>).type === "table");
    if (isTopLevelContentNode) {
      const hint = bodyHints[hintIndex];
      hintIndex += 1;
      if (hint?.pageBreakBefore && nextChildren.length > 0) {
        nextChildren.push(makePageBreakMarkerParagraph());
      }
      // ぶら下げインデント(w:ind)を持つ段落には、継続行の左インデント量を
      // 伝えるマーカーrunを段落の先頭へ追加する(htmlToBlocks側で検出・除去)。
      if (isParagraphNode && hint?.hangingIndentPt != null) {
        const pObj = child as Record<string, unknown>;
        const existingChildren = Array.isArray(pObj.children) ? pObj.children : [];
        nextChildren.push({ ...pObj, children: [makeHangingIndentMarkerRun(hint.hangingIndentPt), ...existingChildren] });
        continue;
      }
    }
    nextChildren.push(child);
  }
  return { ...obj, children: nextChildren };
}

/**
 * 空段落マーカー用のrunノードを1つ生成する(makePageBreakMarkerParagraphと対の関数)。
 */
function makeEmptyParagraphMarkerRun(): Record<string, unknown> {
  return {
    type: "run",
    styleId: null,
    styleName: null,
    isBold: false,
    isUnderline: false,
    isItalic: false,
    isStrikethrough: false,
    isAllCaps: false,
    isSmallCaps: false,
    verticalAlignment: "baseline",
    font: null,
    fontSize: null,
    highlight: null,
    children: [{ type: "text", value: EMPTY_PARAGRAPH_MARKER }],
  };
}

/**
 * ぶら下げインデントマーカー用のrunノードを1つ生成する
 * (makeEmptyParagraphMarkerRunと対の関数、HANGING_INDENT_MARKER_PREFIX参照)。
 */
function makeHangingIndentMarkerRun(indentPt: number): Record<string, unknown> {
  return {
    type: "run",
    styleId: null,
    styleName: null,
    isBold: false,
    isUnderline: false,
    isItalic: false,
    isStrikethrough: false,
    isAllCaps: false,
    isSmallCaps: false,
    verticalAlignment: "baseline",
    font: null,
    fontSize: null,
    highlight: null,
    children: [{ type: "text", value: `${HANGING_INDENT_MARKER_PREFIX}${indentPt}${HANGING_INDENT_MARKER_SUFFIX}` }],
  };
}

/**
 * mammothの中間ドキュメントツリーを走査し、視覚的な内容(テキスト・改行・タブ等)を
 * 一切持たない段落(w:pPr のみでw:rを持たない、またはw:rはあっても空文字列のみの
 * 段落。Wordで「空白の1行」として見えるもの)を検出し、EMPTY_PARAGRAPH_MARKERを
 * 埋め込んだrunを追加する(開発指示書C-2〜C-4、Phase 22)。
 *
 * mammothは中身が空の段落をHTML化する際、<p></p>すら出力せず消してしまうため
 * (実機検証済み)、この変換を経ないと「Wordで入れた空白1行がPDFで消える」問題が
 * 起きる。改ページ用のmarkPageBreaksと同じ「transformDocumentフックで中間木を
 * 書き換える」方式を踏襲している。
 *
 * 改ページ(w:br type="page")や通常の改行(w:br)は視覚的な要素として扱い、
 * 「空」とは判定しない(hasVisibleContentのbreakノードの扱い)。
 */
function markEmptyParagraphs(node: unknown): unknown {
  function hasVisibleContent(n: unknown): boolean {
    if (!n || typeof n !== "object") return false;
    const obj = n as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.value === "string" && obj.value !== "") return true;
    if (obj.type === "break") return true;
    if (obj.type === "image" || obj.type === "drawing") return true;
    if (Array.isArray(obj.children)) return obj.children.some(hasVisibleContent);
    return false;
  }

  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  let next: Record<string, unknown> = obj;
  if (Array.isArray(obj.children)) {
    next = { ...obj, children: obj.children.map(markEmptyParagraphs) };
  }
  if (next.type === "paragraph" && !hasVisibleContent(next)) {
    const children = Array.isArray(next.children) ? next.children : [];
    next = { ...next, children: [...children, makeEmptyParagraphMarkerRun()] };
  }
  return next;
}

/**
 * 本文直下の段落に、通し番号のマーカーを埋め込む（word/document.xmlの書式と対応づけるため）。
 * mammothの中間木の本文直下の段落・表の個数が、書式を読み取った側と食い違う場合
 * （内容コントロール等で並びがずれる場合）は、取り違えを避けるため何も埋め込まない。
 */
function injectParaIdMarkers(documentNode: unknown, expectedCount: number): { node: unknown; ok: boolean } {
  if (!documentNode || typeof documentNode !== "object") return { node: documentNode, ok: false };
  const obj = documentNode as Record<string, unknown>;
  if (!Array.isArray(obj.children)) return { node: documentNode, ok: false };
  const isContent = (c: unknown) => {
    if (!c || typeof c !== "object") return false;
    const o = c as Record<string, unknown>;
    return (o.type === "paragraph" || o.type === "table") && o.mrsattoMarker !== true;
  };
  if (obj.children.filter(isContent).length !== expectedCount) return { node: documentNode, ok: false };
  let index = 0;
  const next = obj.children.map((child) => {
    if (!isContent(child)) return child;
    const i = index++;
    const c = child as Record<string, unknown>;
    if (c.type !== "paragraph") return child;
    const existing = Array.isArray(c.children) ? c.children : [];
    const marker = { ...(makeEmptyParagraphMarkerRun() as Record<string, unknown>), children: [{ type: "text", value: `${PARA_ID_MARKER_PREFIX}${i}${PARA_ID_MARKER_SUFFIX}` }] };
    return { ...c, children: [marker, ...existing] };
  });
  return { node: { ...obj, children: next }, ok: true };
}

/** runs配列の先頭のマーカーから、段落の通し番号を取り出して取り除く */
function extractParaIdMarker(runs: TextRun[]): { runs: TextRun[]; id: number | null } {
  const first = runs[0];
  if (!first || !first.text.startsWith(PARA_ID_MARKER_PREFIX)) return { runs, id: null };
  const body = first.text.slice(PARA_ID_MARKER_PREFIX.length);
  const end = body.indexOf(PARA_ID_MARKER_SUFFIX);
  if (end === -1) return { runs, id: null };
  const id = Number(body.slice(0, end));
  const rest = body.slice(end + PARA_ID_MARKER_SUFFIX.length);
  const newRuns = rest === "" ? runs.slice(1) : [{ ...first, text: rest }, ...runs.slice(1)];
  return { runs: newRuns, id: Number.isInteger(id) ? id : null };
}

/** インライン要素(strong/em/u/a/text)を再帰的に読み、TextRunの配列へ展開する */
function extractRuns(
  node: ChildNode,
  style: { bold: boolean; italic: boolean; underline: boolean; link?: string }
): TextRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text === "") return [];
    return [{ text, ...style }];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return [{ text: "\n", ...style }];
  // 画像：行の中の1文字(画像の目印の文字)にする。通し番号は htmlToBlocks の最後に、本文の順に付け直す
  if (tag === "img") {
    const src = el.getAttribute("src") || "";
    return src.startsWith("data:image/") ? [{ text: OBJECT_CHAR, ...style, image: { dataUri: src, ordinal: -1 } }] : [];
  }
  const nextStyle = { ...style };
  if (tag === "strong" || tag === "b") nextStyle.bold = true;
  if (tag === "em" || tag === "i") nextStyle.italic = true;
  if (tag === "u") nextStyle.underline = true;
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) nextStyle.link = href;
  }
  const runs: TextRun[] = [];
  el.childNodes.forEach((child) => {
    runs.push(...extractRuns(child, nextStyle));
  });
  return runs;
}

function isPageBreakParagraph(runs: TextRun[]): boolean {
  const joined = runs.map((r) => r.text).join("");
  return joined.trim() === PAGE_BREAK_MARKER.trim() || joined.includes(PAGE_BREAK_MARKER);
}

function isEmptyParagraphMarker(runs: TextRun[]): boolean {
  const joined = runs.map((r) => r.text).join("");
  return joined.trim() === EMPTY_PARAGRAPH_MARKER.trim() || joined.includes(EMPTY_PARAGRAPH_MARKER);
}

/**
 * runs配列の先頭からHANGING_INDENT_MARKER_PREFIX/SUFFIXで囲まれたマーカーを
 * 検出・除去し、埋め込まれていた継続行用インデント値(pt)を取り出す
 * (injectPageBreakBeforeMarkers/makeHangingIndentMarkerRunと対の関数)。
 * マーカーが無い場合はrunsをそのまま返しhangingIndentPt: nullとする。
 */
function extractHangingIndentMarker(runs: TextRun[]): { runs: TextRun[]; hangingIndentPt: number | null } {
  const first = runs[0];
  if (!first || !first.text.startsWith(HANGING_INDENT_MARKER_PREFIX)) {
    return { runs, hangingIndentPt: null };
  }
  const withoutPrefix = first.text.slice(HANGING_INDENT_MARKER_PREFIX.length);
  const suffixIndex = withoutPrefix.indexOf(HANGING_INDENT_MARKER_SUFFIX);
  if (suffixIndex === -1) return { runs, hangingIndentPt: null };
  const valueText = withoutPrefix.slice(0, suffixIndex);
  const rest = withoutPrefix.slice(suffixIndex + HANGING_INDENT_MARKER_SUFFIX.length);
  const value = Number(valueText);
  if (!Number.isFinite(value)) return { runs, hangingIndentPt: null };
  const newFirst: TextRun = { ...first, text: rest };
  const newRuns = rest === "" ? runs.slice(1) : [newFirst, ...runs.slice(1)];
  return { runs: newRuns, hangingIndentPt: value };
}

/** <table>を内部モデルのTableBlockへ変換する。colspan/rowspanによる視覚的な
 *  結合は行わないが（■28: 完全一致は保証しない）、セルの文字は失わずそのまま
 *  出力する。 */
function extractTable(tableEl: Element): TableBlock {
  const rows: TextRun[][][] = [];
  const rowEls = Array.from(tableEl.querySelectorAll(":scope > tbody > tr, :scope > tr"));
  for (const rowEl of rowEls) {
    const cells: TextRun[][] = [];
    const cellEls = Array.from(rowEl.querySelectorAll(":scope > td, :scope > th"));
    for (const cellEl of cellEls) {
      const runs: TextRun[] = [];
      cellEl.childNodes.forEach((child) => {
        runs.push(...extractRuns(child, { bold: cellEl.tagName.toLowerCase() === "th", italic: false, underline: false }));
      });
      cells.push(runs);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return { kind: "table", rows };
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** mammothが生成したHTML文字列を内部ドキュメントモデルへ変換する */
function htmlToBlocks(html: string, formatting: DocxFormatting | null): { blocks: DocBlock[]; warnings: string[] } {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: DocBlock[] = [];

  // 表: HTML上の本文直下の表の個数と、書式を読み取った表の個数が一致するときだけ、順番で対応づける
  const tableFmts = formatting ? formatting.body.flatMap((b) => (b.tag === "tbl" ? [b.table] : [])) : [];
  const htmlTableCount = Array.from(doc.body.querySelectorAll("table")).filter((t) => !t.closest("td, th")).length;
  const useTableFmts = formatting !== null && htmlTableCount === tableFmts.length;
  /** 本文の要素のうち表だったものの通し番号（表の順） */
  const tableBodyIndexes = formatting ? formatting.body.flatMap((b, i) => (b.tag === "tbl" ? [i] : [])) : [];
  let tableOrdinal = 0;

  /**
   * 段落の通し番号から、書式（段落全体・文字ごと）を段落ブロックに付ける。
   * offset：同じWordの段落の続きの部分（途中の改ページ・画像の後ろ）のとき、段落の文字の中の始まりの位置
   */
  function attachFormat(block: ParagraphBlock, id: number | null, offset = 0) {
    if (id === null) return;
    block.bodyIndex = id;
    if (offset > 0) block.contOffset = offset;
    if (!formatting) return;
    const entry = formatting.body[id];
    if (!entry || entry.tag !== "p") return;
    block.fmt = entry.para;
    const fmtChars: RunFmt[] = [];
    const fmtCodes: string[] = [];
    for (const r of entry.para.runs) {
      for (const ch of Array.from(r.text)) {
        fmtChars.push(r.fmt);
        fmtCodes.push(ch);
      }
    }
    const blockCodes = flattenRuns(block.runs.filter((r) => r.text !== "")).map((c) => c.ch);
    if (fmtCodes.slice(offset, offset + blockCodes.length).join("") === blockCodes.join("")) {
      block.charFmts = fmtChars.slice(offset, offset + blockCodes.length);
    }
  }

  /** 続きの部分の目印（段落の通し番号と始まりの位置）を取り出して取り除く */
  function extractContMarker(runs: TextRun[]): { runs: TextRun[]; id: number | null; offset: number } {
    const first = runs[0];
    if (!first || !first.text.startsWith(PARA_CONT_MARKER_PREFIX)) return { runs, id: null, offset: 0 };
    const body = first.text.slice(PARA_CONT_MARKER_PREFIX.length);
    const end = body.indexOf(PARA_CONT_MARKER_SUFFIX);
    if (end === -1) return { runs, id: null, offset: 0 };
    const [idText, offText] = body.slice(0, end).split(":");
    const rest = body.slice(end + PARA_CONT_MARKER_SUFFIX.length);
    const id = Number(idText);
    return {
      runs: rest === "" ? runs.slice(1) : [{ ...first, text: rest }, ...runs.slice(1)],
      id: Number.isInteger(id) && id >= 0 ? id : null,
      offset: Number(offText) || 0,
    };
  }


  function walkListItems(listEl: Element, ordered: boolean, level: number) {
    let index = 0;
    Array.from(listEl.children).forEach((child) => {
      if (child.tagName.toLowerCase() !== "li") return;
      index += 1;
      const runs: TextRun[] = [];
      const nestedLists: Element[] = [];
      child.childNodes.forEach((grandchild) => {
        if (
          grandchild.nodeType === Node.ELEMENT_NODE &&
          ["ul", "ol"].includes((grandchild as Element).tagName.toLowerCase())
        ) {
          nestedLists.push(grandchild as Element);
        } else {
          runs.push(...extractRuns(grandchild, { bold: false, italic: false, underline: false }));
        }
      });
      if (runs.some((r) => r.text.trim() !== "")) {
        const { runs: bareRuns, id } = extractParaIdMarker(runs);
        const block: ParagraphBlock = { kind: "paragraph", runs: bareRuns, heading: 0, list: { ordered, level, number: index } };
        attachFormat(block, id);
        blocks.push(block);
      }
      for (const nested of nestedLists) {
        walkListItems(nested, nested.tagName.toLowerCase() === "ol", level + 1);
      }
    });
  }

  function walkBlockLevel(el: Element) {
    Array.from(el.children).forEach((child) => {
      const tag = child.tagName.toLowerCase();
      if (tag in HEADING_LEVEL) {
        const runs: TextRun[] = [];
        child.childNodes.forEach((c) => runs.push(...extractRuns(c, { bold: false, italic: false, underline: false })));
        if (runs.length > 0) {
          const { runs: bareRuns, id } = extractParaIdMarker(runs);
          const block: ParagraphBlock = { kind: "paragraph", runs: bareRuns, heading: HEADING_LEVEL[tag] };
          attachFormat(block, id);
          blocks.push(block);
        }
        return;
      }
      if (tag === "p") {
        // 段落の中の画像は、行の中の1文字(画像の目印の文字)として扱う(文字と同じ行に並ぶ画像・浮動配置の画像の位置)。
        // 以前は画像のある段落の文字を捨てたり、画像を段落の外の別のかたまりにしたりしていた。
        let runs: TextRun[] = [];
        child.childNodes.forEach((c) => runs.push(...extractRuns(c, { bold: false, italic: false, underline: false })));
        let paraId: number | null = null;
        let offset = 0;
        const cont = extractContMarker(runs);
        if (cont.id !== null) {
          runs = cont.runs;
          paraId = cont.id;
          offset = cont.offset;
        } else {
          const idRes = extractParaIdMarker(runs);
          runs = idRes.runs;
          paraId = idRes.id;
        }
        const hang = extractHangingIndentMarker(runs);
        runs = hang.runs;
        if (isPageBreakParagraph(runs)) {
          blocks.push({ kind: "pagebreak" });
        } else if (isEmptyParagraphMarker(runs)) {
          // 開発指示書C-2〜C-4: mammothが本来消してしまう空段落を、
          // markEmptyParagraphsで埋め込んだマーカーから実際の空段落(runs: [])へ戻す。
          const block: ParagraphBlock = { kind: "paragraph", runs: [], heading: 0 };
          attachFormat(block, paraId, offset);
          blocks.push(block);
        } else if (runs.some((r) => r.text !== "")) {
          const block: ParagraphBlock = { kind: "paragraph", runs, heading: 0, hangingIndentPt: hang.hangingIndentPt };
          attachFormat(block, paraId, offset);
          blocks.push(block);
        }
        return;
      }
      if (tag === "ul" || tag === "ol") {
        walkListItems(child, tag === "ol", 0);
        return;
      }
      if (tag === "table") {
        const tableBlock = extractTable(child);
        if (useTableFmts) {
          tableBlock.fmt = tableFmts[tableOrdinal] ?? null;
          tableBlock.bodyIndex = tableBodyIndexes[tableOrdinal];
        }
        tableOrdinal += 1;
        blocks.push(tableBlock);
        return;
      }
      if (tag === "img") {
        const src = child.getAttribute("src") || "";
        if (src.startsWith("data:image/")) {
          blocks.push({ kind: "image", dataUri: src, altText: child.getAttribute("alt") || "" });
        }
        return;
      }
      // blockquote / div等、上記に該当しない要素は中身をそのまま段落として再帰的に扱う
      walkBlockLevel(child);
    });
  }

  walkBlockLevel(doc.body);
  // 本文の段落(表の外)の画像に、文書の順の通し番号を付ける(word/document.xml の画像の大きさ・浮動配置と対応づける)
  let ordinal = 0;
  for (const b of blocks) {
    if (b.kind !== "paragraph") continue;
    for (const r of b.runs) if (r.image) r.image = { ...r.image, ordinal: ordinal++ };
  }
  return { blocks, warnings };
}

// ---------------------------------------------------------------------------
// OOXML(word/document.xml)を直接読んだ文書モデルから、描くかたまり(段落・表・改ページ)を作る
// ---------------------------------------------------------------------------
/**
 * docx-format が word/*.xml から直接読んだ文書(段落・文字の書式・表・画像・改ページ)から、描くかたまりを作る。
 * 以前は、mammoth で本文をHTMLにしてから、別に読んだ書式を「段落の通し番号の目印」で対応づけていた。その方式では、
 * HTMLに変えるときに失われる情報(表の中の画像・入れ子の表・内容コントロール・段落スタイルの「段落の前で改ページ」など)が
 * あり、段落の数が1つでも食い違うと、文書全体の書式を使えなくなっていた。直接読むことで、本文と書式は常に同じものになる。
 * 読めない表があるなど、直接読んだ結果を使えないときは null(呼び出し側は、mammothによる読み取りに戻る)。
 */
function blocksFromOoxml(formatting: DocxFormatting): DocBlock[] | null {
  if (formatting.body.length === 0) return null;
  if (formatting.body.some((b) => b.tag === "tbl" && !b.table)) return null;
  const blocks: DocBlock[] = [];
  let ordinal = 0;
  const imageOf = (o: ParaObject | undefined, ord: number): InlineImageRef | undefined => {
    const rel = o?.rId ? formatting.rels[o.rId] : undefined;
    if (!o || !rel || rel.external) return undefined;
    return { dataUri: rel.target, ordinal: ord, ...(o.widthPt > 0 && o.heightPt > 0 ? { w: o.widthPt, h: o.heightPt } : {}) };
  };
  const linkOf = (rid: string | null): string | undefined => {
    const rel = rid ? formatting.rels[rid] : undefined;
    return rel && rel.external && /^https?:\/\//i.test(rel.target) ? rel.target : undefined;
  };
  formatting.body.forEach((b, bodyIndex) => {
    if (b.tag === "tbl") {
      blocks.push({ kind: "table", rows: [], fmt: b.table, bodyIndex });
      return;
    }
    const para = b.para;
    if (para.pageBreakBefore && blocks.length > 0 && blocks[blocks.length - 1].kind !== "pagebreak") blocks.push({ kind: "pagebreak" });
    // 文字ごとの書式・リンク・画像
    const chars: { ch: string; fmt: RunFmt; link?: string; image?: InlineImageRef }[] = [];
    let objIndex = 0;
    for (const r of para.runs) {
      const link = linkOf(r.fmt.linkRid);
      for (const ch of Array.from(r.text)) {
        if (ch === OBJECT_CHAR) {
          // 本文の段落の画像は、画像が読めなくても通し番号を進める(浮動配置の位置の情報と対応づけるため)
          chars.push({ ch, fmt: r.fmt, link, image: imageOf(para.objects[objIndex++], ordinal) });
          ordinal++;
        } else chars.push({ ch, fmt: r.fmt, link });
      }
    }
    const segment = (start: number, end: number): ParagraphBlock => {
      const runs: TextRun[] = [];
      for (const c of chars.slice(start, end)) {
        const last = runs[runs.length - 1];
        if (!c.image && last && !last.image && last.link === c.link) last.text += c.ch;
        else runs.push({ text: c.ch, bold: false, italic: false, underline: false, ...(c.link ? { link: c.link } : {}), ...(c.image ? { image: c.image } : {}) });
      }
      return { kind: "paragraph", runs, heading: 0, fmt: para, charFmts: chars.slice(start, end).map((c) => c.fmt), bodyIndex, ...(start > 0 ? { contOffset: start } : {}) };
    };
    // 段落の途中の改ページ・段区切り：前の部分・区切り・続きの部分に分ける(区切りだけの段落は、区切りだけにする)
    const breaks = [
      ...para.pageBreaks.map((k) => ({ k, column: false })),
      ...(para.columnBreaks ?? []).map((k) => ({ k, column: true })),
    ]
      .filter((b) => b.k >= 0 && b.k <= chars.length)
      .sort((x, y) => x.k - y.k);
    if (breaks.length === 0) {
      blocks.push(segment(0, chars.length));
      return;
    }
    let start = 0;
    for (const b of breaks) {
      if (b.k > start) blocks.push(segment(start, b.k));
      blocks.push(b.column ? { kind: "pagebreak", column: true } : { kind: "pagebreak" });
      start = b.k;
    }
    if (chars.length > start) blocks.push(segment(start, chars.length));
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// PDF描画
// ---------------------------------------------------------------------------
interface FlatChar {
  ch: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
  size: number;
  color: string | null;
  highlight: string | null;
  strike: boolean;
  script: "super" | "sub" | null;
  /** 文書が指定したフォント名(英数字用・日本語用)。行の組み方(文字の幅・1行の高さ)に使う。分からなければ null */
  fontAscii?: string | null;
  fontEastAsia?: string | null;
  /** 段落の中の画像(行の中に置く画像・浮動配置の画像の位置) */
  image?: InlineImageRef;
}

/** 空でない文字の並び（コードポイント単位）。書式つきの文字列との対応づけ（attachFormat）にも使う */
function flattenRuns(runs: TextRun[]): { ch: string }[] {
  const out: { ch: string }[] = [];
  for (const run of runs) for (const ch of Array.from(run.text)) out.push({ ch });
  return out;
}

/** 文字の並び（書式つき）を作る。charFmtsがあれば、文字ごとの書式（サイズ・色・蛍光ペンなど）を反映する */
function toFlatChars(runs: TextRun[], charFmts: RunFmt[] | null | undefined, defaults: { size: number; bold: boolean }): FlatChar[] {
  const out: FlatChar[] = [];
  let i = 0;
  for (const run of runs) {
    for (const ch of Array.from(run.text)) {
      const f = charFmts ? charFmts[i] : null;
      i += 1;
      out.push({
        ch,
        bold: run.bold || (f?.bold ?? false) || defaults.bold,
        italic: run.italic || (f?.italic ?? false),
        underline: run.underline || (f?.underline ?? false),
        link: run.link,
        size: f?.sizePt ?? defaults.size,
        color: f?.color ?? null,
        highlight: f?.highlight ?? null,
        strike: f?.strike ?? false,
        script: f?.script ?? null,
        fontAscii: f?.fontAscii ?? null,
        fontEastAsia: f?.fontEastAsia ?? null,
        ...(run.image ? { image: run.image } : {}),
      });
    }
  }
  return out;
}

/** 書式つきの段落（runs）から、文字の並びを作る（ヘッダー/フッター・表のセル用）。ページ番号の目印は実際の番号に置き換える */
function fmtParagraphChars(
  para: ParaFmt,
  defaults: { size: number; bold: boolean },
  pageNo = 1,
  pageCount = 1,
  res?: { image?: (o: ParaObject) => InlineImageRef | undefined; link?: (rid: string) => string | undefined }
): FlatChar[] {
  const out: FlatChar[] = [];
  let objIndex = 0;
  for (const run of para.runs) {
    const f = run.fmt;
    const link = f.linkRid && res?.link ? res.link(f.linkRid) : undefined;
    for (const ch0 of Array.from(run.text)) {
      const text = ch0 === PAGE_NUMBER_CHAR ? String(pageNo) : ch0 === PAGE_COUNT_CHAR ? String(pageCount) : ch0;
      let image: InlineImageRef | undefined;
      if (ch0 === OBJECT_CHAR) {
        const o = para.objects[objIndex++];
        image = o && res?.image ? res.image(o) : undefined;
      }
      for (const ch of Array.from(text)) {
        out.push({
          ...(link ? { link } : {}),
          ...(image ? { image } : {}),
          ch,
          bold: f.bold || defaults.bold,
          italic: f.italic,
          underline: f.underline,
          size: f.sizePt ?? defaults.size,
          color: f.color,
          highlight: f.highlight,
          strike: f.strike,
          script: f.script,
          fontAscii: f.fontAscii,
          fontEastAsia: f.fontEastAsia,
        });
      }
    }
  }
  return out;
}

function hexToRgb(hexColor: string | null, fallback = pdfLib().rgb(0.12, 0.12, 0.14)) {
  if (!hexColor || !/^[0-9a-fA-F]{6}$/.test(hexColor)) return fallback;
  return pdfLib().rgb(parseInt(hexColor.slice(0, 2), 16) / 255, parseInt(hexColor.slice(2, 4), 16) / 255, parseInt(hexColor.slice(4, 6), 16) / 255);
}

function charStyleKey(c: FlatChar): string {
  return [c.bold, c.italic, c.underline, c.link ?? "", c.size, c.color ?? "", c.highlight ?? "", c.strike, c.script ?? ""].join("|");
}

export interface WordToPdfInput {
  file: File;
}

export interface WordToPdfOutput extends Omit<PdfProcessorOutput, "url"> {
  warnings: string[];
  paragraphCount: number;
  tableCount: number;
  imageCount: number;
}

export class WordToPdfProcessor extends BrowserProcessor<WordToPdfInput, WordToPdfOutput> {
  async process({ file }: WordToPdfInput): Promise<WordToPdfOutput> {
    await ensurePdfLib({ fontkit: true });
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }
    if (file.size > MAX_DOCX_SIZE_BYTES) {
      throw new Error(
        `ファイルサイズの上限は${Math.floor(MAX_DOCX_SIZE_BYTES / 1024 / 1024)}MBです。より小さいファイルでお試しください。`
      );
    }
    const isDocx =
      file.name.toLowerCase().endsWith(".docx") ||
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (!isDocx) {
      throw new Error("Word文書(.docx)ファイルを選択してください。");
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch {
      throw new Error("ファイルの読み込みに失敗しました");
    }

    // word/document.xmlから用紙設定(セクション)・段落のpageBreakBefore情報を直接読み取る
    // (Phase 18.2 C節、詳細はsection-settings.tsとファイル冒頭のコメントを参照)。
    // 解析に失敗しても例外は投げず空の結果を返す実装のため、この呼び出し自体は失敗しない。
    const structure = parseWordDocumentStructure(arrayBuffer);

    const warnings: string[] = [];
    const section = structure.sections[0] ?? null;

    // 段落・文字・表・ヘッダー/フッターの書式（中央揃え・文字サイズ・色など）を、word/*.xmlから直接読む
    const formatting = parseDocxFormatting(arrayBuffer);
    let formattingMatched = false;

    // 本文は、word/document.xml を直接読んだ文書モデルから作る(blocksFromOoxml)。直接読めなかったときだけ、
    // 以前の方式(mammothでHTMLにしてから書式を対応づける)に戻る
    const direct = blocksFromOoxml(formatting);
    let blocks: DocBlock[];
    if (direct && direct.length > 0) {
      blocks = direct;
      formattingMatched = true;
    } else {
    const mammoth = await import("mammoth");
    let html: string;
    try {
      const result = await mammoth.convertToHtml(
        { arrayBuffer: withoutTextBoxContent(arrayBuffer) },
        {
          convertImage: mammoth.images.dataUri,
          transformDocument: ((documentNode: unknown) => {
            // 1) 段落の前で改ページ・空の段落の目印 → 2) 段落の通し番号 → 3) 本文の段落の途中の改ページで段落を分ける
            //    → 4) 残り(表の中など)の改ページを目印の段落に置き換える
            const marked = markEmptyParagraphs(injectPageBreakBeforeMarkers(documentNode, structure.bodyChildren));
            const withIds = injectParaIdMarkers(marked, formatting.body.length);
            formattingMatched = withIds.ok;
            return markPageBreaks(splitTopLevelPageBreaks(withIds.node));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any,
        }
      );
      html = result.value;
      for (const message of result.messages) {
        if (message.type === "error") warnings.push(message.message);
      }
    } catch {
      throw new Error(
        "Word文書の解析に失敗しました。ファイルが破損しているか、対応していない形式の可能性があります。"
      );
    }

    const parsed = htmlToBlocks(html, formattingMatched ? formatting : null);
    blocks = parsed.blocks;
    warnings.push(...parsed.warnings);
    warnings.push("文書の構造を直接読み取れなかったため、簡易的な読み取りで変換しました（書式の一部が反映されない場合があります）。");
    }
    const directModel = !!direct && direct.length > 0;

    if (blocks.length === 0) {
      throw new Error("このWord文書から変換できる内容が見つかりませんでした。");
    }

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }

    let doc: PdfLibTypes.PDFDocument;
    let font: PDFFont;
    try {
      doc = await pdfLib().PDFDocument.create();
      doc.registerFontkit(fontkitLib());
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    // 用紙サイズ・余白(開発指示書C-3・C-4・C-8): DOCXの最初のセクションから取得できれば
    // それを使い、取得できなければ既定値(A4・56pt)にフォールバックする。
    // セクション(用紙設定の区切り)ごとに、用紙の大きさ・向き・余白を切り替える(下の applySection)
    let pageWidth = section?.pageWidthPt ?? DEFAULT_PAGE_WIDTH;
    let pageHeight = section?.pageHeightPt ?? DEFAULT_PAGE_HEIGHT;
    let marginTop = section?.margins.top ?? DEFAULT_MARGIN;
    let marginBottom = section?.margins.bottom ?? DEFAULT_MARGIN;
    let marginLeft = section?.margins.left ?? DEFAULT_MARGIN;
    let marginRight = section?.margins.right ?? DEFAULT_MARGIN;
    let contentWidth = Math.max(50, pageWidth - marginLeft - marginRight);
    let bottomLimit = marginBottom;
    let marginTopEff = marginTop;
    /** ヘッダー・フッターの高さの分(下で求める)。セクションを切り替えたときに、上下の余白を計算し直すのに使う */
    let headerReserve = 0;
    let footerReserve = 0;

    let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
    let cursorY = pageHeight - marginTopEff;
    /** ページごとの左の余白・本文の幅(ヘッダー/フッターをページごとの用紙で描くため) */
    /** ページごとの本文の左の余白・幅と、そのページが始まったときのセクション(ヘッダー・フッターを選ぶため) */
    const pageGeom = new Map<PDFPage, { marginLeft: number; contentWidth: number; section: number }>();
    let geomSection = 0;
    pageGeom.set(page, { marginLeft, contentWidth, section: 0 });

    // ---- 段組み(w:cols)：本文の幅を段に分け、段の下まで来たら次の段へ、最後の段の下まで来たら次のページへ ----
    // marginLeft・contentWidth は「いま文字を置いている段」の左端・幅。secLeft・secWidth は、セクションの本文の左端・幅
    let secLeft = marginLeft;
    let secWidth = contentWidth;
    let colWidths: number[] = [contentWidth];
    let colSpaces: number[] = [];
    let colIndex = 0;
    /** このページ(またはセクションの始まり)の、段の上端 */
    let colTop = cursorY;
    let colSeparator = false;
    /** 段組みのページで、いちばん下まで使った段の位置(段組みのセクションを終えるときに使う) */
    let colLowest = Number.POSITIVE_INFINITY;
    /** 段の境界線を引く場所(ページ・x・上端・下端) */
    const separators: { page: PDFPage; x: number; top: number; bottom: number }[] = [];
    function setupColumns(cols: { count: number; widths: number[] | null; spaces: number[]; space: number; separator: boolean } | undefined) {
      secLeft = marginLeft;
      secWidth = contentWidth;
      const count = Math.max(1, cols?.count ?? 1);
      if (count === 1 || !cols) {
        colWidths = [secWidth];
        colSpaces = [];
        colSeparator = false;
      } else {
        colSpaces = Array.from({ length: count - 1 }, (_, i) => cols.spaces[i] ?? cols.space);
        const totalSpace = colSpaces.reduce((a, b) => a + b, 0);
        const widths = cols.widths && cols.widths.length === count ? cols.widths : Array(count).fill((secWidth - totalSpace) / count);
        // 段の幅の合計が本文の幅を超えるときは、比例して縮める
        const sum = widths.reduce((a: number, b: number) => a + b, 0) + totalSpace;
        const k = sum > secWidth + 0.5 ? (secWidth - totalSpace) / Math.max(1, sum - totalSpace) : 1;
        colWidths = widths.map((w: number) => Math.max(20, w * k));
        colSeparator = cols.separator;
      }
      colIndex = 0;
      colTop = cursorY;
      colLowest = Number.POSITIVE_INFINITY;
      marginLeft = secLeft;
      contentWidth = colWidths[0];
    }
    const columnLeft = (k: number) => secLeft + colWidths.slice(0, k).reduce((a, b) => a + b, 0) + colSpaces.slice(0, k).reduce((a, b) => a + b, 0);
    function enterColumn(k: number) {
      if (k > colIndex) colLowest = Math.min(colLowest, cursorY);
      colIndex = k;
      marginLeft = columnLeft(k);
      contentWidth = colWidths[k];
      cursorY = colTop;
    }
    /** 段の境界線を、いまのページの、段の上端から下端まで引く(段組みのセクションを終えるとき・ページを変えるとき) */
    function recordSeparators(bottom: number) {
      if (!colSeparator || colWidths.length < 2) return;
      for (let k = 1; k <= Math.min(colIndex, colWidths.length - 1); k++) separators.push({ page, x: columnLeft(k) - colSpaces[k - 1] / 2, top: colTop, bottom });
    }
    /** 次の段へ(最後の段なら、次のページへ) */
    function nextColumnOrPage() {
      if (colWidths.length > 1 && colIndex < colWidths.length - 1) enterColumn(colIndex + 1);
      else newPage();
    }

    function newPage() {
      if (doc.getPageCount() >= MAX_PAGE_COUNT) {
        throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
      }
      flushFrontDrawsRef?.(page);
      recordSeparators(bottomLimit);
      page = doc.addPage([pageWidth, pageHeight]);
      pageGeom.set(page, { marginLeft: secLeft, contentWidth: secWidth, section: geomSection });
      cursorY = pageHeight - marginTopEff;
      colTop = cursorY;
      colLowest = Number.POSITIVE_INFINITY;
      if (colWidths.length > 1) {
        colIndex = 0;
        enterColumn(0);
      }
    }

    /** 前面の図形を描く関数(下で用意する。ページを変える前に、そのページの前面の図形を描く) */
    let flushFrontDrawsRef: ((pg: PDFPage) => void) | null = null;

    /** このページに、まだ何も置いていないか(ページの先頭か) */
    const atPageTop = () => cursorY >= pageHeight - marginTopEff - 0.5;

    // ---- Wordが保存した改ページの位置(w:lastRenderedPageBreak)は「参考」として使う ----
    // Microsoft Wordは保存のたびに、そのとき組んだページの境目を文書に記録する。ただし、保存したあとに内容が変わったり、
    // フォントが違ったりすると、記録はいまの文書のページの境目と合わない。そこで、ページの区切りは常に
    // Mr.Sattoのレイアウトの計算で決め、記録の位置は「計算した結果でも、そこがページの下の端の近く(残りが3行ぶん未満)」
    // のときだけ使う(行の高さ・文字の幅のわずかな違いで、Wordより1〜2行ずれるのを防ぐため)。
    // 計算と大きく離れた記録は使わない(使わなかった数は、注意書きで知らせる)。
    const savedBreaksAvailable = formattingMatched && formatting.hasRenderedBreaks;
    const SAVED_BREAK_LINES = 3;
    let savedBreaksIgnored = 0;
    /** 記録の位置を使ってよいか：その位置で、ページの残りの高さが、その位置の行の高さの3行ぶん未満 */
    function savedBreakConsistent(roomPt: number, lineHeightPt: number): boolean {
      const ok = roomPt < SAVED_BREAK_LINES * Math.max(1, lineHeightPt);
      if (!ok) savedBreaksIgnored++;
      return ok;
    }
    /** 自然にページを変える下の限界(ページの下端からの距離)。余白にははみ出さない */
    const naturalLimit = () => bottomLimit;
    /** 自然にページを変える(下に届いた) */
    /** 内容が段・ページの下に入らないとき：段組みなら次の段へ、そうでなければ次のページへ */
    function overflowPage() {
      nextColumnOrPage();
    }

    function ensureSpace(height: number) {
      if (cursorY - height < naturalLimit() && !atPageTop()) overflowPage();
    }

    const INK = pdfLib().rgb(0.12, 0.12, 0.14);
    const defaultTabPt = formatting.defaultTabPt;
    const gridPitch = section?.docGridLinePitchPt ?? null;
    /** 「1行」の高さの倍率(文書の標準のフォントで決まる) */
    const lineFactor = formattingMatched ? lineFactorForFonts(formatting.defaultFonts) : SINGLE_LINE_SPACING_FACTOR;

    function drawSize(c: FlatChar): number {
      return c.script ? c.size * 0.65 : c.size;
    }
    // ---- 文字の幅・1行の高さは、文書が指定したフォントの寸法で求める(src/lib/fonts/office-font-metrics.ts) ----
    // PDFに描く字形は同梱のNoto Sans JPだが、行の折り返し・ページの区切りは、Wordと同じく文書のフォントの寸法で決める。
    // 寸法が分からないフォントの文字は、同梱のフォントの幅を使う(従来どおり)。
    const defaultFonts = formattingMatched ? formatting.defaultFonts : { ascii: null, eastAsia: null };
    const metricsOfChar = (c: FlatChar) =>
      fontMetricsFor(isEastAsianChar(c.ch) ? (c.fontEastAsia ?? defaultFonts.eastAsia ?? c.fontAscii ?? defaultFonts.ascii) : (c.fontAscii ?? defaultFonts.ascii));
    function widthsOf(chars: FlatChar[]): number[] {
      return chars.map((c) => {
        if (c.ch === "\t" || c.ch === "\n") return 0;
        if (c.ch === OBJECT_CHAR) return inlineImageBox(c)?.w ?? 0;
        const w = metricsOfChar(c).widthPerPt(c.ch, c.bold);
        return w !== null ? w * drawSize(c) : font.widthOfTextAtSize(c.ch, drawSize(c));
      });
    }

    // ---- 改行の決まり(禁則)：文書の設定(settings.xml)と段落の設定(w:kinsoku・w:wordWrap・w:overflowPunct)から決める ----
    const ks = formatting.kinsoku;
    const noLineStart = new Set(Array.from(ks.noLineStart ?? (ks.strict ? KINSOKU_STRICT_START : KINSOKU_STANDARD_START)));
    const noLineEnd = new Set(Array.from(ks.noLineEnd ?? KINSOKU_LINE_END));
    const breakRulesCache = new Map<string, BreakRules>();
    function breakRulesOf(fmt: ParaFmt | null): BreakRules {
      const kinsoku = fmt?.kinsoku ?? true;
      const wordWrap = fmt?.wordWrap ?? true;
      const overflowPunct = fmt?.overflowPunct ?? true;
      const key = `${kinsoku}|${wordWrap}|${overflowPunct}`;
      let r = breakRulesCache.get(key);
      if (!r) {
        r = { kinsoku, wordWrap, overflowPunct, noLineStart, noLineEnd };
        breakRulesCache.set(key, r);
      }
      return r;
    }

    interface PlacedLines {
      lines: LayoutLine[];
      heights: number[];
      sizes: number[];
      /** 行の上の余白（行間が広いとき、文字を行の下側へ寄せる量） */
      extras: number[];
    }

    /** 段落の行を組む（折り返し・タブ・揃え・行の高さ） */
    function placeParagraph(
      chars: FlatChar[],
      o: { firstX: number; contX: number; maxX: number; align: "left" | "center" | "right" | "justify"; tabs: TabStopSpec[]; paraSize: number; fmt: ParaFmt | null; legacyHeadingHeight?: boolean; fixedLineHeight?: number }
    ): PlacedLines {
      const lines = layoutParagraph(
        chars.map((c) => c.ch),
        widthsOf(chars),
        { firstX: o.firstX, contX: o.contX, maxX: o.maxX, tabs: o.tabs, defaultTab: defaultTabPt, align: o.align, breaking: breakRulesOf(o.fmt) }
      );
      const spacing: DefaultParagraphSpacing = {
        lineRule: o.fmt?.lineRule ?? structure.defaultSpacing.lineRule,
        lineValue: o.fmt?.lineValue ?? structure.defaultSpacing.lineValue,
        beforePt: null,
        afterPt: null,
      };
      const heights: number[] = [];
      const sizes: number[] = [];
      const extras: number[] = [];
      for (const line of lines) {
        // 行の高さ：その行の文字のうち、(文字の大きさ × そのフォントの1行の倍率)がいちばん大きいもの(Wordと同じ)
        let size = 0;
        let natural = 0;
        let imageH = 0;
        for (const it of line.items) {
          const c = chars[it.index];
          size = Math.max(size, c.size);
          if (c.ch === OBJECT_CHAR) {
            // 行の中の画像：行の高さは、画像の高さ以上(Wordと同じ)
            const box = inlineImageBox(c);
            if (box) {
              natural = Math.max(natural, box.h + c.size * 0.25);
              imageH = Math.max(imageH, box.h);
            }
          } else if (c.ch !== "\n") natural = Math.max(natural, c.size * metricsOfChar(c).lineFactor);
        }
        if (size === 0) size = o.paraSize;
        if (natural === 0) natural = size * lineFactor;
        const factor = natural / size;
        sizes.push(size);
        let h: number;
        let extra = 0;
        if (o.fixedLineHeight !== undefined) h = o.fixedLineHeight;
        else if (o.legacyHeadingHeight) h = size + 6;
        else {
          h = resolveLineHeight(spacing, size, gridPitch, factor);
          if (spacing.lineRule === "auto" && (spacing.lineValue ?? 240) > 240 && !gridPitch) extra = Math.max(0, h - natural);
        }
        // 行の中の画像：文字の並びの線(ベースライン)を画像の下の端に置く(画像の高さの分だけ、文字を下げる)
        if (imageH > 0) extra = Math.max(extra, Math.min(h - size, imageH - size));
        heights.push(h);
        extras.push(extra);
      }
      return { lines, heights, sizes, extras };
    }

    /** 1行ぶんの文字を描く（同じ書式が続く文字をまとめて、塗り・縁取り・下線・取り消し線・リンクを付ける） */
    function paintLine(chars: FlatChar[], line: LayoutLine, originX: number, topY: number, size: number, extra: number) {
      for (const it of line.items) {
        const c = chars[it.index];
        if (c.ch !== OBJECT_CHAR) continue;
        const box = inlineImageBox(c);
        const img = c.image ? embeddedImages.get(c.image.dataUri) : undefined;
        // 画像の下の端を、文字の並びの線(ベースライン)にそろえる
        if (box && img) page.drawImage(img, { x: originX + it.x, y: topY - extra - size, width: box.w, height: box.h });
      }
      const items = line.items.filter((it) => chars[it.index].ch !== "\t" && chars[it.index].ch !== "\n" && chars[it.index].ch !== OBJECT_CHAR);
      const baseY = topY - extra - size;
      let k = 0;
      while (k < items.length) {
        const first = chars[items[k].index];
        const key = charStyleKey(first);
        let j = k + 1;
        while (j < items.length && items[j].index === items[j - 1].index + 1 && charStyleKey(chars[items[j].index]) === key) j++;
        const group = items.slice(k, j);
        k = j;
        const ds = drawSize(first);
        const y = baseY + (first.script === "super" ? first.size * 0.35 : first.script === "sub" ? -first.size * 0.12 : 0);
        const color = first.link ? pdfLib().rgb(0.1, 0.32, 0.75) : hexToRgb(first.color, INK);
        const x0 = originX + group[0].x;
        const x1 = originX + group[group.length - 1].x + group[group.length - 1].width;
        if (first.highlight) {
          page.drawRectangle({ x: x0, y: y - ds * 0.22, width: x1 - x0, height: ds * 1.2, color: hexToRgb(first.highlight) });
        }
        if (first.bold) {
          page.pushOperators(pdfLib().setLineWidth(ds * 0.028), pdfLib().setStrokingRgbColor(color.red, color.green, color.blue), pdfLib().setTextRenderingMode(pdfLib().TextRenderingMode.FillAndOutline));
        }
        // 1文字ずつdrawTextを呼ぶ理由: 英字に数字が続く文字列を1回で描くと、PDFの
        // テキスト情報（コピー・検索用）だけが化けることがあるため（従来からの回避策）。
        for (const it of group) {
          // 文書のフォントの文字の幅(it.width)で並べる。同梱のフォントの字形の幅と違うときは、字形を横に伸縮して、その幅に収める
          const ch = chars[it.index].ch;
          const own = font.widthOfTextAtSize(ch, ds);
          const squeeze = own > 0 && it.width > 0 && Math.abs(it.width - own) > own * 0.02 && line.items.length > 0 ? Math.max(50, Math.min(150, (it.width / own) * 100)) : null;
          if (squeeze !== null) page.pushOperators(pdfLib().PDFOperator.of(pdfLib().PDFOperatorNames.SetTextHorizontalScaling, [pdfLib().PDFNumber.of(squeeze)]));
          page.drawText(ch, { x: originX + it.x, y, size: ds, font, color, ...(first.italic ? { xSkew: pdfLib().degrees(12) } : {}) });
          if (squeeze !== null) page.pushOperators(pdfLib().PDFOperator.of(pdfLib().PDFOperatorNames.SetTextHorizontalScaling, [pdfLib().PDFNumber.of(100)]));
        }
        if (first.bold) page.pushOperators(pdfLib().setTextRenderingMode(pdfLib().TextRenderingMode.Fill));
        if (first.underline || first.link) {
          page.drawLine({ start: { x: x0, y: y - 1.5 }, end: { x: x1, y: y - 1.5 }, thickness: 0.6, color });
        }
        if (first.strike) {
          page.drawLine({ start: { x: x0, y: y + ds * 0.3 }, end: { x: x1, y: y + ds * 0.3 }, thickness: 0.6, color });
        }
        if (first.link) addLinkAnnotation(doc, page, first.link, { x: x0, y: y - 2, width: x1 - x0, height: ds + 2 });
      }
    }

    /** 改ページ時1行残して段落を区切らない、が有効か(段落・スタイルに指定が無ければ、Wordの既定どおり有効) */
    function widowOn(fmt: ParaFmt | null): boolean {
      return fmt ? fmt.widowControl !== false : false;
    }

    function drawBorderLine(x1: number, y1: number, x2: number, y2: number, b: BorderFmt) {
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(0.3, b.widthPt), color: hexToRgb(b.color, pdfLib().rgb(0, 0, 0)) });
    }

    function tabSpecs(fmt: ParaFmt | null): TabStopSpec[] {
      return (fmt?.tabs ?? []).map((t) => ({ pos: t.posPt, kind: t.kind }));
    }

    /** 段落の中の、Wordが記録した改ページの位置(この部分の文字の中の位置)。0は段落の先頭 */
    function renderedBreaksOf(block: ParagraphBlock, length: number): number[] {
      if (!savedBreaksAvailable || !block.fmt) return [];
      const start = block.contOffset ?? 0;
      return block.fmt.renderedBreaks
        .filter((k) => k >= start && (k < start + length || (length === 0 && k === start)))
        .map((k) => k - start)
        .filter((k) => k === 0 || !!block.charFmts); // 段落の途中の位置は、文字の対応がとれたときだけ使う
    }

    /** 段落の行を組んだ結果(高さの見積もり用。keepNextの判定に使う) */
    function measureParagraph(block: ParagraphBlock): { heights: number[]; before: number; after: number } | null {
      const fmt = block.fmt ?? null;
      const isHeading = block.heading > 0;
      const paraSize = fmt?.baseSizePt ?? (isHeading ? Math.max(20 - (block.heading - 1) * 2, 12) : BODY_SIZE);
      const chars = toFlatChars(block.runs.filter((r) => r.text !== ""), block.charFmts, { size: paraSize, bold: isHeading });
      const left = Math.max(0, fmt?.leftPt ?? 0);
      const maxX = contentWidth - Math.max(0, fmt?.rightPt ?? 0);
      if (maxX - left <= 10) return null;
      const placed = placeParagraph(chars, { firstX: Math.max(0, left + (fmt?.firstLinePt ?? 0)), contX: left, maxX, align: fmt?.align ?? "left", tabs: tabSpecs(fmt), paraSize, fmt, legacyHeadingHeight: isHeading && !fmt });
      return { heights: placed.heights, before: fmt?.beforePt ?? 0, after: fmt?.afterPt ?? 0 };
    }

    /**
     * 回り込む図形があるときの段落：1行ずつ、その行の高さの範囲で空いている幅(図形の左右の広いほう)に行を組む。
     * 上下に回り込む図形(band)や、空きが狭すぎるところは、図形の下まで行を下げる。
     */
    function flowParagraph(chars: FlatChar[], o: { firstX: number; contX: number; maxX: number; align: "left" | "center" | "right" | "justify"; tabs: TabStopSpec[]; paraSize: number; fmt: ParaFmt | null }) {
      let idx = 0;
      let first = true;
      for (let guard = 0; idx < chars.length && guard < 10000; guard++) {
        const rest = chars.slice(idx);
        const est = placeParagraph(rest.slice(0, 1), { ...o, firstX: 0, contX: 0 }).heights[0] ?? o.paraSize * lineFactor;
        if (cursorY - est < naturalLimit() && !atPageTop()) {
          overflowPage();
          continue;
        }
        const hits = exclusions.filter((e) => e.page === page && e.top > cursorY - est && e.bottom < cursorY);
        const band = hits.filter((e) => e.band);
        if (band.length > 0) {
          cursorY = Math.min(...band.map((e) => e.bottom));
          continue;
        }
        // 空いている幅(本文の左端からの位置)
        let free: [number, number][] = [[first ? o.firstX : o.contX, o.maxX]];
        for (const e of hits) {
          const a = e.x1 - marginLeft;
          const b = e.x2 - marginLeft;
          free = free.flatMap(([l, r]) => (b <= l || a >= r ? [[l, r]] : [...(a > l ? [[l, a]] : []), ...(b < r ? [[b, r]] : [])]) as [number, number][]);
        }
        const widest = free.sort((p, q) => q[1] - q[0] - (p[1] - p[0]))[0];
        if (!widest || widest[1] - widest[0] < Math.max(18, o.paraSize * 2)) {
          cursorY = Math.min(...hits.map((e) => e.bottom));
          continue;
        }
        const placed1 = placeParagraph(rest, { ...o, firstX: widest[0], contX: widest[0], maxX: widest[1] });
        const line = placed1.lines[0];
        if (!line) break;
        paintLine(rest, line, marginLeft, cursorY, placed1.sizes[0], placed1.extras[0]);
        cursorY -= placed1.heights[0];
        const last = line.breakIndex ?? (line.items.length > 0 ? line.items[line.items.length - 1].index : 0);
        idx += Math.max(1, last + 1);
        first = false;
      }
    }

    function drawParagraph(block: ParagraphBlock, prevStyleId?: string | null, nextStyleId?: string | null, keepWithNextHeight = 0) {
      const fmt = block.fmt ?? null;
      const isHeading = block.heading > 0;
      const headingSize = Math.max(20 - (block.heading - 1) * 2, 12);
      const paraSize = fmt?.baseSizePt ?? (isHeading ? headingSize : BODY_SIZE);
      const runs = block.runs.filter((r) => r.text !== "");
      const isContinuation = (block.contOffset ?? 0) > 0;
      let chars = toFlatChars(runs, block.charFmts, { size: paraSize, bold: isHeading });
      // Wordが記録した改ページの位置(参考)。使うかどうかは、行を組んだあとに決める(下)
      let anchors = renderedBreaksOf(block, chars.length);
      const midAnchors = new Set<number>();
      // 箇条書き・番号付きの段落：行頭の記号・番号(numbering.xmlの定義どおり)と区切り(タブ・空白)を、行の先頭の文字として組む
      const numbering = !isContinuation ? (fmt?.numbering ?? null) : null;
      if (numbering && numbering.label !== "") {
        const base = chars[0] ?? toFlatChars([{ text: " ", bold: false, italic: false, underline: false }], null, { size: paraSize, bold: isHeading })[0];
        const labelChars: FlatChar[] = Array.from(numbering.label).map((ch) => ({
          ...base,
          ch,
          link: undefined,
          underline: false,
          highlight: null,
          fontAscii: numbering.fontAscii ?? base.fontAscii,
        }));
        if (numbering.suffix !== "nothing") labelChars.push({ ...base, ch: numbering.suffix === "tab" ? "\t" : " ", link: undefined, underline: false, highlight: null });
        chars = [...labelChars, ...chars];
        anchors = anchors.map((k) => (k > 0 ? k + labelChars.length : 0));
      }

      const listIndent = block.list ? 16 + block.list.level * 16 : 0;
      let firstX: number;
      let contX: number;
      if (fmt && (fmt.numbering || !block.list) && (fmt.leftPt !== null || fmt.firstLinePt !== null || fmt.numbering)) {
        const left = Math.max(0, fmt.leftPt ?? 0);
        contX = left;
        firstX = Math.max(0, left + (fmt.firstLinePt ?? 0));
      } else {
        firstX = listIndent;
        contX = block.hangingIndentPt ?? listIndent;
      }
      // 同じ段落の続きの部分(途中の改ページ・画像の後ろ)は、1行目の字下げを付けない
      if (isContinuation) firstX = contX;
      const maxX = contentWidth - Math.max(0, fmt?.rightPt ?? 0);
      if (maxX - Math.max(firstX, contX) <= 10) return;

      // ぶら下げインデントの位置は、Wordでは暗黙のタブ位置になる(箇条書きの記号の後ろのタブが、本文の始まりの位置まで進む)
      const tabs = tabSpecs(fmt);
      if (numbering && contX > firstX && !tabs.some((t) => Math.abs(t.pos - contX) < 0.5)) tabs.push({ pos: contX, kind: "left" });
      tabs.sort((a, b) => a.pos - b.pos);
      const placeOpts = { firstX, contX, maxX, align: fmt?.align ?? "left", tabs, paraSize, fmt, legacyHeadingHeight: isHeading && !fmt } as const;
      let placed = placeParagraph(chars, placeOpts);

      const topY = pageHeight - marginTopEff;
      // 「同じスタイルの段落の間は間隔を空けない」（箇条書きなど）
      const sameAsPrev = !!fmt?.contextual && prevStyleId !== undefined && prevStyleId === fmt.styleId;
      const sameAsNext = !!fmt?.contextual && nextStyleId !== undefined && nextStyleId === fmt.styleId;
      const before = sameAsPrev || isContinuation ? 0 : (fmt?.beforePt ?? 0);
      const limit = naturalLimit();

      // Wordが記録した改ページの位置(参考)：計算した結果でもページの下の端の近くなら、その位置でページを変える
      if (anchors.includes(0) && !atPageTop() && savedBreakConsistent(cursorY - before - limit, placed.heights[0] ?? paraSize)) newPage();
      const mid = anchors.filter((x) => x > 0);
      if (mid.length > 0) {
        // 記録の位置の文字を含む行が、計算した結果で、どのページのどの高さに来るかを調べる(下の改ページの決め方と同じ)
        let y = atPageTop() ? cursorY : cursorY - before;
        const honored: number[] = [];
        const decided = new Set<number>();
        placed.lines.forEach((line, i) => {
          const h = placed.heights[i];
          const first = line.items[0]?.index ?? -1;
          const last = line.items[line.items.length - 1]?.index ?? -1;
          for (const k of mid) {
            if (first < 0 || k < first || k > last || decided.has(k)) continue;
            decided.add(k);
            if (savedBreakConsistent(y - limit, h)) honored.push(k);
          }
          if (y - h < limit && y < topY - 0.01) y = topY;
          y -= h;
        });
        for (const k of honored.sort((a, b) => b - a)) {
          // その文字の前に「行の終わり」を入れる(Wordでは、そこで行もページも変わっている)
          chars = [...chars.slice(0, k), { ...chars[Math.max(0, k - 1)], ch: "\n" }, ...chars.slice(k)];
          midAnchors.add(k);
        }
        if (honored.length > 0) placed = placeParagraph(chars, placeOpts);
      }
      const totalHeight = placed.heights.reduce((a, b) => a + b, 0);
      // Wordの段落の改ページの制御(段落を分割しない・次の段落と分離しない・1行残しの制御)
      if (!atPageTop()) {
        const room = cursorY - before - limit;
        const fullPage = topY - limit;
        // 段落を分割しない(keepLines)：ページに収まらないが、1ページには収まる → 段落の前でページを変える
        if (fmt?.keepLines && totalHeight > room + 0.01 && totalHeight <= fullPage) overflowPage();
        // 次の段落と分離しない(keepNext)：この段落はページに入るが、次の段落の最初の行が同じページに入らない → 段落の前でページを変える
        // (この段落自体がページに入らないときは、段落の後ろの部分が次の段落と同じページに行くので、何もしない)
        else if (keepWithNextHeight > 0 && totalHeight <= room + 0.01 && totalHeight + keepWithNextHeight > room + 0.01 && totalHeight + keepWithNextHeight <= fullPage) overflowPage();
        // 改ページ時1行残して段落を区切らない(widowControl)：1行目だけがこのページに残る → 段落の前でページを変える
        else if (widowOn(fmt) && placed.lines.length >= 2 && placed.heights[0] <= room + 0.01 && placed.heights[0] + placed.heights[1] > room + 0.01) overflowPage();
      }
      if (before > 0 && cursorY < topY - 0.5) cursorY -= before;

      // この段落に置かれた浮動配置(画像・テキストボックス・図形)を置く(段落の中の最初の部分のときだけ)
      if (!isContinuation) placeFloats(block.bodyIndex, cursorY, marginLeft + firstX);
      // 文字が回り込む領域がこのページにあり、この段落の高さの範囲にかかるときは、1行ずつ、空いている幅で行を組む
      if (exclusions.some((e) => e.page === page && e.bottom < cursorY && e.top > cursorY - totalHeight - 1)) {
        flowParagraph(chars, placeOpts);
        if (!sameAsNext) cursorY -= fmt?.afterPt ?? 0;
        return;
      }

      // 改ページの位置を先に決める（枠線・背景色を、ページごとに正しい範囲へ描くため）
      interface Chunk { start: number; end: number; newPage: boolean; top: number; natural: boolean }
      const chunks: Chunk[] = [];
      let y = cursorY;
      let cur: Chunk = { start: 0, end: 0, newPage: false, top: y, natural: false };
      // 入れた「行の終わり」の文字の位置(元の位置 k は、それより前に入れた文字の数だけ後ろにずれている)
      const insertedBreaks = new Set([...midAnchors].sort((a, b) => a - b).map((k, i) => k + i));
      const startsAfterAnchor = (i: number) => {
        const prevBreak = i > 0 ? placed.lines[i - 1].breakIndex : undefined;
        return prevBreak !== undefined && insertedBreaks.has(prevBreak);
      };
      placed.lines.forEach((_, i) => {
        const h = placed.heights[i];
        const forced = startsAfterAnchor(i);
        if (forced || (y - h < limit && y < topY - 0.01)) {
          if (i > cur.start) {
            cur.end = i;
            chunks.push(cur);
            cur = { start: i, end: i, newPage: true, top: topY, natural: !forced };
          } else {
            cur.newPage = true;
            cur.top = topY;
            cur.natural = !forced;
          }
          y = topY;
        }
        y -= h;
      });
      cur.end = placed.lines.length;
      chunks.push(cur);
      // 改ページ時1行残して段落を区切らない(widowControl)：最後の1行だけが次のページに行く → 前のページの最後の1行も次のページへ
      if (widowOn(fmt) && midAnchors.size === 0) {
        for (let ci = 1; ci < chunks.length; ci++) {
          const a = chunks[ci - 1];
          const b = chunks[ci];
          if (b.natural && b.end - b.start === 1 && a.end - a.start >= 3) {
            a.end -= 1;
            b.start -= 1;
          } else if (b.natural && b.end - b.start === 1 && a.end - a.start === 2 && ci === 1 && !a.newPage) {
            // 2行と1行に分かれる段落：前のページに1行だけ残すことにもなるので、段落ごと次のページへ
            a.newPage = true;
            a.natural = true;
            a.top = topY;
            a.end = b.end;
            chunks.splice(1, 1);
            break;
          }
        }
      }

      const box = fmt && (fmt.fill || fmt.borders) ? fmt : null;
      chunks.forEach((chunk, ci) => {
        if (chunk.newPage) {
          if (chunk.natural) overflowPage();
          else newPage();
        }
        const chunkHeight = placed.heights.slice(chunk.start, chunk.end).reduce((a, b) => a + b, 0);
        if (box) {
          const left = marginLeft + Math.max(0, Math.min(firstX, contX)) - 3;
          const right = marginLeft + maxX + 3;
          const top = cursorY + 1;
          const bottom = cursorY - chunkHeight - 1;
          if (box.fill) page.drawRectangle({ x: left, y: bottom, width: right - left, height: top - bottom, color: hexToRgb(box.fill) });
          const b = box.borders;
          if (b) {
            if (b.top && ci === 0) drawBorderLine(left, top, right, top, b.top);
            if (b.bottom && ci === chunks.length - 1) drawBorderLine(left, bottom, right, bottom, b.bottom);
            if (b.left) drawBorderLine(left, top, left, bottom, b.left);
            if (b.right) drawBorderLine(right, top, right, bottom, b.right);
          }
        }
        for (let i = chunk.start; i < chunk.end; i++) {
          const line = placed.lines[i];
          if (block.list && i === 0 && !fmt?.numbering) {
            const prefix = block.list.ordered ? `${block.list.number ?? 1}. ` : "・";
            page.drawText(prefix, { x: marginLeft + block.list.level * 16, y: cursorY - placed.sizes[i], size: placed.sizes[i], font, color: INK });
          }
          paintLine(chars, line, marginLeft, cursorY, placed.sizes[i], placed.extras[i]);
          cursorY -= placed.heights[i];
        }
      });
      cursorY -= sameAsNext ? 0 : (fmt?.afterPt ?? (isHeading ? 6 : resolveParagraphGap(structure.defaultSpacing, gridPitch)));
    }

    // ---- 表 ----
    interface NPara { chars: FlatChar[]; fmt: ParaFmt | null; size: number }
    interface NCell {
      span: number;
      vMerge: "restart" | "continue" | null;
      fill: string | null;
      vAlign: "top" | "center" | "bottom";
      paras: NPara[];
      borders: { top?: BorderFmt | null; bottom?: BorderFmt | null; left?: BorderFmt | null; right?: BorderFmt | null };
    }
    interface NTable {
      grid: number[];
      rows: { cells: NCell[]; heightPt: number | null; cantSplit?: boolean; exactHeight?: boolean }[];
      borders: { top: BorderFmt | null; bottom: BorderFmt | null; left: BorderFmt | null; right: BorderFmt | null; insideH: BorderFmt | null; insideV: BorderFmt | null };
      indent: number;
      align: "left" | "center" | "right";
      padX: number;
      padY: number;
      fixedLineHeight?: number;
      /** 表の先頭から続く「タイトル行の繰り返し」(w:tblHeader)の行の数。表がページをまたぐとき、次のページの先頭にも描く */
      headerRows?: number;
      /** Wordが保存したとき、その行の前でページが変わったか */
      rowBreaks?: boolean[];
    }

    function normalizeTable(block: TableBlock): NTable {
      const f = block.fmt;
      if (f) {
        return {
          grid: f.gridPt,
          rows: f.rows.map((r) => ({
            heightPt: r.heightPt,
            cantSplit: r.cantSplit,
            exactHeight: r.heightRule === "exact" && r.heightPt !== null,
            cells: r.cells.map((c) => ({
              span: c.gridSpan,
              vMerge: c.vMerge,
              fill: c.fill,
              vAlign: c.vAlign,
              borders: c.borders,
              paras: c.paragraphs.map((p) => {
                const size = p.baseSizePt ?? BODY_SIZE;
                return { chars: fmtParagraphChars(p, { size, bold: false }, 1, 1, directModel ? { image: cellImage, link: cellLink } : undefined), fmt: p, size };
              }),
            })),
          })),
          borders: f.borders,
          indent: f.indentPt,
          align: f.align,
          padX: Math.max(f.cellPadLeftPt, f.cellPadRightPt),
          // セルの上下の余白は、表の設定(w:tblCellMar)どおり(Wordの既定は0)。以前は常に2ptずつ足していたため、
          // 行の多い表が1ページに入りきらず、表の途中の行が次のページへ送られていた
          padY: Math.max(f.cellPadTopPt, f.cellPadBottomPt),
          headerRows: f.rows.findIndex((r) => !r.isHeader) === -1 ? f.rows.length : f.rows.findIndex((r) => !r.isHeader),
          rowBreaks: f.rows.map((r) => r.renderedBreak),
        };
      }
      // 書式を読めなかった表: 従来どおり、等幅の列・細い灰色の罫線・9ptの文字
      const colCount = Math.max(...block.rows.map((r) => r.length));
      const edge: BorderFmt = { widthPt: 0.6, color: "BFBFC7" };
      return {
        grid: Array.from({ length: colCount }, () => contentWidth / colCount),
        rows: block.rows.map((row) => ({
          heightPt: null,
          cells: row.map((cellRuns) => ({
            span: 1,
            vMerge: null,
            fill: null,
            vAlign: "top" as const,
            borders: {},
            paras: [{ chars: toFlatChars(cellRuns.filter((r) => r.text !== ""), null, { size: 9, bold: false }), fmt: null, size: 9 }],
          })),
        })),
        borders: { top: edge, bottom: edge, left: edge, right: edge, insideH: edge, insideV: edge },
        indent: 0,
        align: "left",
        padX: 5,
        padY: 5,
        fixedLineHeight: 13,
      };
    }

    function drawTable(block: TableBlock) {
      if (block.rows.length === 0 && !block.fmt) return;
      const t = normalizeTable(block);
      if (t.grid.length === 0 || t.rows.length === 0) return;
      const totalGrid = t.grid.reduce((a, b) => a + b, 0);
      const scale = totalGrid > contentWidth ? contentWidth / totalGrid : 1;
      const grid = t.grid.map((w) => w * scale);
      const tableWidth = grid.reduce((a, b) => a + b, 0);
      const originX = marginLeft + (t.align === "center" ? (contentWidth - tableWidth) / 2 : t.align === "right" ? contentWidth - tableWidth : Math.max(0, t.indent));
      const colX = (col: number) => originX + grid.slice(0, col).reduce((a, b) => a + b, 0);
      const spanWidth = (col: number, span: number) => grid.slice(col, col + span).reduce((a, b) => a + b, 0);

      // 各セルの行の組み立て
      interface CellLine { pi: number; li: number; h: number; after: number }
      interface CellLayout { col: number; span: number; cell: NCell; paras: { placed: PlacedLines; para: NPara }[]; need: number; lines: CellLine[] }
      const layouts: CellLayout[][] = t.rows.map((row) => {
        let col = 0;
        return row.cells.map((cell) => {
          const span = Math.min(cell.span, Math.max(1, grid.length - col));
          const innerW = Math.max(10, spanWidth(col, span) - t.padX * 2);
          const paras = cell.paras.map((para) => {
            const fmt = para.fmt;
            const left = Math.max(0, fmt?.leftPt ?? 0);
            const placed = placeParagraph(para.chars, {
              firstX: Math.max(0, left + (fmt?.firstLinePt ?? 0)),
              contX: left,
              maxX: innerW - Math.max(0, fmt?.rightPt ?? 0),
              align: fmt?.align ?? "left",
              tabs: tabSpecs(fmt),
              paraSize: para.size,
              fmt,
              fixedLineHeight: t.fixedLineHeight,
            });
            return { placed, para };
          });
          let need = 0;
          for (const p of paras) need += p.placed.heights.reduce((a, b) => a + b, 0) + (t.fixedLineHeight === undefined ? Math.min(p.para.fmt?.afterPt ?? 0, 6) : 0);
          // セルの中の行を、上から順に並べたもの(行の途中でページを分けるときに使う)
          const lines: CellLine[] = [];
          paras.forEach((p, pi) => {
            const n = p.placed.lines.length;
            p.placed.heights.forEach((h, li) => lines.push({ pi, li, h, after: li === n - 1 && t.fixedLineHeight === undefined ? Math.min(p.para.fmt?.afterPt ?? 0, 6) : 0 }));
          });
          const layout: CellLayout = { col, span, cell, paras, need: need + t.padY * 2, lines };
          col += span;
          return layout;
        });
      });

      // 行の高さ（縦に結合したセルは、結合した行の合計で足りるようにする）
      const rowHeights = layouts.map((row, ri) => {
        // 高さが「固定」(w:hRule="exact")の行は、中身に関係なくその高さ(はみ出す文字は描かない。Wordと同じ)
        if (t.rows[ri].exactHeight) return Math.max(1, t.rows[ri].heightPt ?? 10);
        let h = t.rows[ri].heightPt ?? 0;
        for (const l of row) if (l.cell.vMerge === null) h = Math.max(h, l.need);
        return Math.max(h, 10);
      });
      layouts.forEach((row, ri) => {
        for (const l of row) {
          if (l.cell.vMerge !== "restart") continue;
          let last = ri;
          for (let r = ri + 1; r < layouts.length; r++) {
            const same = layouts[r].find((x) => x.col === l.col && x.cell.vMerge === "continue");
            if (!same) break;
            last = r;
          }
          const sum = rowHeights.slice(ri, last + 1).reduce((a, b) => a + b, 0);
          if (l.need > sum) rowHeights[last] += l.need - sum;
        }
      });

      const lastRow = layouts.length - 1;
      const headerRows = Math.min(t.headerRows ?? 0, layouts.length);

      // ---- 縦に結合したセル(w:vMerge)：結合の範囲(開始の行〜最後の行)を、ページごとの「区間」に分けて描く ----
      // 結合したセルの文字は、結合の範囲の行を描くあいだ、ページの中で使える高さに入るだけ描き、ページが変わったら
      // 次のページの区間に続きを描く(以前は、結合したセルを、開始の行のページにまとめて描いていたため、範囲がページを
      // またぐと、紙の下にはみ出していた)。
      interface MergeGroup { l: CellLayout; r0: number; r1: number; pos: number; segTop: number | null; split: boolean }
      const groups: MergeGroup[] = [];
      layouts.forEach((row, ri) => {
        for (const l of row) {
          if (l.cell.vMerge !== "restart") continue;
          let r1 = ri;
          for (let r = ri + 1; r < layouts.length; r++) {
            if (!layouts[r].find((x) => x.col === l.col && x.cell.vMerge === "continue")) break;
            r1 = r;
          }
          groups.push({ l, r0: ri, r1, pos: 0, segTop: null, split: false });
        }
      });
      const groupsAt = (ri: number) => groups.filter((g) => g.r0 <= ri && ri <= g.r1);
      /** 結合したセルの、ページの中の区間(上端 g.segTop 〜 下端 bottom)を描く。final は結合の範囲の最後の区間 */
      const flushGroup = (g: MergeGroup, bottom: number, final: boolean) => {
        if (g.segTop === null) return;
        const l = g.l;
        const top = g.segTop;
        const h = Math.max(0, top - bottom);
        const x = colX(l.col);
        const w = spanWidth(l.col, l.span);
        if (l.cell.fill) page.drawRectangle({ x, y: bottom, width: w, height: h, color: hexToRgb(l.cell.fill) });
        const lastCol = l.col + l.span >= grid.length;
        const side = (own: BorderFmt | null | undefined, outer: BorderFmt | null, inner: BorderFmt | null, isEdge: boolean) => (own !== undefined ? own : isEdge ? outer : inner);
        const tb = side(l.cell.borders.top, t.borders.top, t.borders.insideH, g.r0 === 0);
        const bb = side(l.cell.borders.bottom, t.borders.bottom, t.borders.insideH, g.r1 >= lastRow);
        const lb = side(l.cell.borders.left, t.borders.left, t.borders.insideV, l.col === 0);
        const rb = side(l.cell.borders.right, t.borders.right, t.borders.insideV, lastCol);
        if (tb) drawBorderLine(x, top, x + w, top, tb);
        if (bb) drawBorderLine(x, bottom, x + w, bottom, bb);
        if (lb) drawBorderLine(x, top, x, bottom, lb);
        if (rb) drawBorderLine(x + w, top, x + w, bottom, rb);
        // 文字：最後の区間は残りをすべて(行の高さは足りるようにしてある)、途中の区間は入るだけ
        const end = final ? l.lines.length : fitLines(l, g.pos, h);
        const restH = restNeed(l, g.pos) - t.padY * 2;
        const offset = final && !g.split ? (l.cell.vAlign === "center" ? Math.max(0, (h - t.padY * 2 - restH) / 2) : l.cell.vAlign === "bottom" ? Math.max(0, h - t.padY * 2 - restH) : 0) : 0;
        let cy = top - t.padY - offset;
        for (let k = g.pos; k < end; k++) {
          const ln = l.lines[k];
          const p = l.paras[ln.pi];
          paintLine(p.para.chars, p.placed.lines[ln.li], x + t.padX, cy, p.placed.sizes[ln.li], p.placed.extras[ln.li]);
          cy -= ln.h + ln.after;
        }
        g.pos = end;
        g.segTop = null;
        if (!final) g.split = true;
      };
      /** ページを変える前に、結合したセルの、このページの区間を描く */
      const flushGroupsForPageBreak = () => {
        for (const g of groups) if (g.segTop !== null) flushGroup(g, cursorY, false);
      };
      /** 行 ri の高さ(結合の範囲の最後の行は、結合したセルの残りの文字が入るように、必要なら高くする) */
      const effectiveRowHeight = (ri: number, rowTop: number) => {
        let h = rowHeights[ri];
        for (const g of groups) {
          if (g.r1 !== ri) continue;
          const segTop = g.segTop ?? rowTop;
          h = Math.max(h, restNeed(g.l, g.pos) - (segTop - rowTop));
        }
        return h;
      };
      const tablePageBreak = (ri: number) => {
        flushGroupsForPageBreak();
        overflowPage();
        if (ri >= headerRows) repeatHeader();
      };
      /** ページの先頭に、タイトル行を繰り返して描く */
      let repeating = false;
      const repeatHeader = () => {
        if (headerRows === 0 || repeating) return;
        repeating = true;
        for (let hr = 0; hr < headerRows; hr++) drawRow(hr);
        repeating = false;
      };
      const headerHeight = rowHeights.slice(0, headerRows).reduce((a, b) => a + b, 0);
      /** 行の途中でページを分けられるか。「行の途中で改ページしない」(w:cantSplit)の行でも、1ページに入らない高さなら分ける(Wordと同じ) */
      const splittable = (ri: number) => {
        if (t.fixedLineHeight !== undefined || t.rows[ri].exactHeight) return false;
        const fullRoom = pageHeight - marginTopEff - naturalLimit() - (ri >= headerRows ? headerHeight : 0);
        return !t.rows[ri].cantSplit || rowHeights[ri] > fullRoom + 0.01;
      };
      /** セル c の、行 from から入るだけの行(高さ room の中)。戻り値は、次に描く行の番号 */
      const fitLines = (l: CellLayout, from: number, room: number) => {
        let used = t.padY * 2;
        let k = from;
        while (k < l.lines.length && used + l.lines[k].h <= room + 0.01) {
          used += l.lines[k].h + l.lines[k].after;
          k++;
        }
        return k;
      };
      const restNeed = (l: CellLayout, from: number) => t.padY * 2 + l.lines.slice(from).reduce((a, x) => a + x.h + x.after, 0);
      /** 行の中の、結合していないセル(縦に結合したセルは、結合の区間として別に描く) */
      const ownCells = (ri: number) => layouts[ri].map((l, c) => ({ l, c })).filter((x) => x.l.cell.vMerge === null);
      const drawRowWithPaging = (ri: number) => {
        // Wordが保存したとき、この行の前でページが変わった
        if (t.rowBreaks?.[ri] && savedBreaksAvailable && !atPageTop() && savedBreakConsistent(cursorY - naturalLimit(), rowHeights[ri])) {
          flushGroupsForPageBreak();
          newPage();
          if (ri >= headerRows) repeatHeader();
        }
        const rowHeight = effectiveRowHeight(ri, cursorY);
        if (cursorY - rowHeight >= naturalLimit() - 0.01) {
          drawRow(ri);
          return;
        }
        if (!splittable(ri)) {
          // 分けられない行：次のページへ送る
          if (!atPageTop()) tablePageBreak(ri);
          drawRow(ri);
          return;
        }
        // 行の途中でページを分ける：各セルの、ページに入るところまでの行を描き、残りを次のページに描く(Wordと同じ)。
        // 縦に結合したセルは、ページを変えるときに、その区間を描く(flushGroupsForPageBreak)
        let pos = layouts[ri].map(() => 0);
        let drawn = 0;
        for (let guard = 0; guard < 500; guard++) {
          const room = cursorY - naturalLimit();
          const own = ownCells(ri);
          // 残りの高さ：このセルの残りの文字・行の高さの指定の残り・結合したセル(この行で終わるもの)の残りの文字
          const groupNeed = Math.max(0, ...groupsAt(ri).filter((g) => g.r1 === ri).map((g) => restNeed(g.l, g.pos) - ((g.segTop ?? cursorY) - cursorY)));
          const need = Math.max(...own.map(({ l, c }) => restNeed(l, pos[c])), rowHeights[ri] - drawn, groupNeed, 0);
          if (need <= room + 0.01) {
            drawRowPart(ri, pos, null, need);
            for (const g of groupsAt(ri)) if (g.r1 === ri) flushGroup(g, cursorY, true);
            return;
          }
          let take = layouts[ri].map((l, c) => (l.cell.vMerge === null ? fitLines(l, pos[c], room) : pos[c]));
          const groupProgress = groupsAt(ri).some((g) => fitLines(g.l, g.pos, (g.segTop ?? cursorY) - naturalLimit()) > g.pos);
          if (own.every(({ c }) => take[c] === pos[c]) && !groupProgress) {
            if (!atPageTop()) {
              tablePageBreak(ri);
              continue;
            }
            // ページの先頭でも1行も入らない(行が高すぎる)：各セル1行ずつ描いて進める
            take = layouts[ri].map((l, c) => (l.cell.vMerge === null ? Math.min(l.lines.length, pos[c] + 1) : pos[c]));
          }
          const partH = Math.max(0, ...own.map(({ l, c }) => t.padY * 2 + l.lines.slice(pos[c], take[c]).reduce((a, x) => a + x.h + x.after, 0)));
          // 結合したセルの区間も、このページの下端まで使う
          const partHeight = groupsAt(ri).length > 0 ? Math.max(partH, room) : partH;
          drawRowPart(ri, pos, take, partHeight);
          drawn += partHeight;
          pos = take;
          tablePageBreak(ri);
        }
      };
      /** 行の一部(各セルの、行 from から to の手前まで。to が null なら最後まで)を、高さ h で描く */
      const drawRowPart = (ri: number, from: number[], to: number[] | null, h: number) => {
        const rowTop = cursorY;
        const draws: (() => void)[] = [];
        for (const g of groupsAt(ri)) if (g.segTop === null) g.segTop = rowTop;
        layouts[ri].forEach((l, c) => {
          if (l.cell.vMerge !== null) return;
          const x = colX(l.col);
          const w = spanWidth(l.col, l.span);
          if (l.cell.fill) page.drawRectangle({ x, y: rowTop - h, width: w, height: h, color: hexToRgb(l.cell.fill) });
          draws.push(() => {
            const lastCol = l.col + l.span >= grid.length;
            const side = (own: BorderFmt | null | undefined, outer: BorderFmt | null, inner: BorderFmt | null, isEdge: boolean) => (own !== undefined ? own : isEdge ? outer : inner);
            const top = side(l.cell.borders.top, t.borders.top, t.borders.insideH, ri === 0);
            const bottom = side(l.cell.borders.bottom, t.borders.bottom, t.borders.insideH, ri >= lastRow);
            const left = side(l.cell.borders.left, t.borders.left, t.borders.insideV, l.col === 0);
            const right = side(l.cell.borders.right, t.borders.right, t.borders.insideV, lastCol);
            if (top) drawBorderLine(x, rowTop, x + w, rowTop, top);
            if (bottom) drawBorderLine(x, rowTop - h, x + w, rowTop - h, bottom);
            if (left) drawBorderLine(x, rowTop, x, rowTop - h, left);
            if (right) drawBorderLine(x + w, rowTop, x + w, rowTop - h, right);
            let cy = rowTop - t.padY;
            const end = to ? to[c] : l.lines.length;
            for (let k = from[c]; k < end; k++) {
              const ln = l.lines[k];
              const p = l.paras[ln.pi];
              paintLine(p.para.chars, p.placed.lines[ln.li], x + t.padX, cy, p.placed.sizes[ln.li], p.placed.extras[ln.li]);
              cy -= ln.h + ln.after;
            }
          });
        });
        for (const d of draws) d();
        cursorY = rowTop - h;
      };
      const drawRow = (ri: number) => {
        const rowTop = cursorY;
        // 縦に結合したセル：結合の区間を始める(タイトル行を繰り返すときは、以前どおり、結合の範囲をまとめて描く)
        const useGroups = !repeating;
        const rowHeight = useGroups ? effectiveRowHeight(ri, rowTop) : rowHeights[ri];
        if (useGroups) for (const g of groupsAt(ri)) if (g.segTop === null) g.segTop = rowTop;
        const draws: (() => void)[] = [];
        for (const l of layouts[ri]) {
          if (l.cell.vMerge === "continue") continue;
          if (useGroups && l.cell.vMerge === "restart") continue;
          let spanRows = 1;
          if (l.cell.vMerge === "restart") {
            for (let r = ri + 1; r < layouts.length; r++) {
              if (!layouts[r].find((x) => x.col === l.col && x.cell.vMerge === "continue")) break;
              spanRows++;
            }
          }
          const h = rowHeights.slice(ri, ri + spanRows).reduce((a, b) => a + b, 0);
          const x = colX(l.col);
          const w = spanWidth(l.col, l.span);
          if (l.cell.fill) page.drawRectangle({ x, y: rowTop - h, width: w, height: h, color: hexToRgb(l.cell.fill) });
          draws.push(() => {
            // 罫線（セルの指定 > 表の外枠/内側の指定）
            const lastCol = l.col + l.span >= grid.length;
            const endRow = ri + spanRows - 1 >= lastRow;
            const side = (own: BorderFmt | null | undefined, outer: BorderFmt | null, inner: BorderFmt | null, isEdge: boolean) => (own !== undefined ? own : isEdge ? outer : inner);
            const top = side(l.cell.borders.top, t.borders.top, t.borders.insideH, ri === 0);
            const bottom = side(l.cell.borders.bottom, t.borders.bottom, t.borders.insideH, endRow);
            const left = side(l.cell.borders.left, t.borders.left, t.borders.insideV, l.col === 0);
            const right = side(l.cell.borders.right, t.borders.right, t.borders.insideV, lastCol);
            if (top) drawBorderLine(x, rowTop, x + w, rowTop, top);
            if (bottom) drawBorderLine(x, rowTop - h, x + w, rowTop - h, bottom);
            if (left) drawBorderLine(x, rowTop, x, rowTop - h, left);
            if (right) drawBorderLine(x + w, rowTop, x + w, rowTop - h, right);
            // 文字
            const contentH = l.need - t.padY * 2;
            const offset = l.cell.vAlign === "center" ? Math.max(0, (h - t.padY * 2 - contentH) / 2) : l.cell.vAlign === "bottom" ? Math.max(0, h - t.padY * 2 - contentH) : 0;
            let cy = rowTop - t.padY - offset;
            for (const p of l.paras) {
              p.placed.lines.forEach((line, i) => {
                // 高さが固定の行：行の高さからはみ出す文字の行は描かない(Wordと同じ)
                if (t.rows[ri].exactHeight && cy - p.placed.heights[i] < rowTop - h - 0.5) return;
                paintLine(p.para.chars, line, x + t.padX, cy, p.placed.sizes[i], p.placed.extras[i]);
                cy -= p.placed.heights[i];
              });
              if (t.fixedLineHeight === undefined) cy -= Math.min(p.para.fmt?.afterPt ?? 0, 6);
            }
          });
        }
        for (const d of draws) d();
        cursorY = rowTop - rowHeight;
        if (useGroups) for (const g of groupsAt(ri)) if (g.r1 === ri) flushGroup(g, cursorY, true);
      };
      // 表の最初の行の前でページが変わった記録 → 表の前でページを変える
      if (t.rowBreaks?.[0] && savedBreaksAvailable && !atPageTop() && savedBreakConsistent(cursorY - naturalLimit(), rowHeights[0] ?? 0)) newPage();
      for (let ri = 0; ri < layouts.length; ri++) drawRowWithPaging(ri);
      cursorY -= block.fmt ? 0 : PARAGRAPH_GAP;
    }

    async function drawImage(block: ImageBlock) {
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(block.dataUri);
      if (!match) {
        warnings.push("画像データの形式を認識できなかったため省略しました");
        return;
      }
      const [, mimeType, base64] = match;
      let bytes: Uint8Array;
      try {
        const binary = atob(base64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } catch {
        warnings.push("画像データの読み込みに失敗したため省略しました");
        return;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        warnings.push(`画像サイズが大きすぎるため省略しました（${block.altText || "無題の画像"}）`);
        return;
      }

      let embedded;
      try {
        if (mimeType === "image/png") {
          embedded = await doc.embedPng(bytes);
        } else if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
          embedded = await doc.embedJpg(bytes);
        } else {
          warnings.push(`対応していない画像形式(${mimeType})のため省略しました`);
          return;
        }
      } catch {
        warnings.push("破損している可能性のある画像を省略しました");
        return;
      }

      const maxHeight = pageHeight - marginTopEff - bottomLimit;
      // 画像の大きさ：Wordの文書に保存されている大きさ(wp:extent)。分からないときは、画像の画素数(96dpi)。
      // どちらも、本文の幅・高さに収まるように縮める(拡大はしない)。以前は小さい画像も本文の幅いっぱいに拡大していた
      const saved = imageSizesUsable && block.ordinal !== undefined ? formatting.bodyImages[block.ordinal] : undefined;
      let width = saved && saved.widthPt > 0 ? saved.widthPt : embedded.width * 0.75;
      let height = saved && saved.heightPt > 0 ? saved.heightPt : embedded.height * 0.75;
      const shrink = Math.min(1, contentWidth / Math.max(1, width), maxHeight / Math.max(1, height));
      width *= shrink;
      height *= shrink;
      if (width <= 0 || height <= 0) {
        width = contentWidth;
        height = contentWidth * 0.5;
      }
      ensureSpace(height);
      page.drawImage(embedded, { x: marginLeft, y: cursorY - height, width, height });
      cursorY -= height + (saved ? 0 : PARAGRAPH_GAP);
    }

    // ---- ヘッダー / フッター ----
    // セクションごとのヘッダー・フッター(docx-format の sectionHeaders。前のセクションから引き継いだものを含む)。
    // セクションの数が本文の構造と合わないときは、最初のセクションのものを、すべてのページに使う(以前の方式)
    const hfSections =
      formatting.sectionHeaders.length > 0 && formatting.sectionHeaders.length === structure.sections.length
        ? formatting.sectionHeaders
        : [{ refs: formatting.refs ?? { headers: {}, footers: {}, titlePg: false, headerDistancePt: 36, footerDistancePt: 36 }, headers: formatting.headers, footers: formatting.footers }];
    const hfOfSection = (i: number) => hfSections[Math.min(i, hfSections.length - 1)];
    /** ヘッダー・フッターの段落の中の画像(行の中に置く画像)：部品の参照(header1.xml.rels など)で、画像のファイルを決める */
    const hfImage = (hf: HeaderFooterFmt) => (o: ParaObject): InlineImageRef | undefined => {
      if (o.anchored) return undefined; // 浮動配置の画像は、行の中に置かない(別に描く)
      const rel = o.rId ? hf.rels[o.rId] : undefined;
      if (!rel || rel.external) return undefined;
      return { dataUri: rel.target, ordinal: -1, ...(o.widthPt > 0 && o.heightPt > 0 ? { w: o.widthPt, h: o.heightPt } : {}) };
    };
    const headerFooterParts = (hf: HeaderFooterFmt | undefined) =>
      hf && hf.paragraphs.some((p) => p.runs.some((r) => r.text.trim() !== "" && r.text.replace(new RegExp(OBJECT_CHAR, "g"), "").trim() !== "") || p.objects.length > 0) ? hf : undefined;
    const hfMeasure = (hf: HeaderFooterFmt | undefined, pageNo: number, pageCount: number) => {
      const out: { chars: FlatChar[]; placed: PlacedLines; fmt: ParaFmt }[] = [];
      let total = 0;
      if (!hf) return { out, total };
      for (const p of hf.paragraphs) {
        const size = p.baseSizePt ?? BODY_SIZE;
        const chars = fmtParagraphChars(p, { size, bold: false }, pageNo, pageCount, { image: hfImage(hf) });
        const left = Math.max(0, p.leftPt ?? 0);
        const placed = placeParagraph(chars, {
          firstX: Math.max(0, left + (p.firstLinePt ?? 0)),
          contX: left,
          maxX: contentWidth - Math.max(0, p.rightPt ?? 0),
          align: p.align ?? "left",
          tabs: tabSpecs(p),
          paraSize: size,
          fmt: p,
        });
        total += placed.heights.reduce((a, b) => a + b, 0) + (p.afterPt ?? 0);
        out.push({ chars, placed, fmt: p });
      }
      return { out, total };
    };
    const kindsOf = (i: number) => {
      const hf = hfOfSection(i);
      return {
        refs: hf.refs,
        headers: (["default", "first", "even"] as const).map((k) => headerFooterParts(hf.headers[k])),
        footers: (["default", "first", "even"] as const).map((k) => headerFooterParts(hf.footers[k])),
      };
    };
    /** セクションの、ヘッダー・フッターが本文を押し下げる/押し上げる位置(ヘッダーの距離＋ヘッダーの高さ。無ければ0) */
    function reservesOf(i: number): { header: number; footer: number } {
      const k = kindsOf(i);
      const maxH = Math.max(0, ...k.headers.map((h) => hfMeasure(h, 1, 1).total));
      const maxF = Math.max(0, ...k.footers.map((f) => hfMeasure(f, 1, 1).total));
      return { header: maxH > 0 ? k.refs.headerDistancePt + maxH : 0, footer: maxF > 0 ? k.refs.footerDistancePt + maxF : 0 };
    }

    // ---- セクション(用紙設定の区切り)の切り替え ----
    // Wordの文書は、途中で用紙の大きさ・向き・余白を変えられる(セクション区切り)。区切りの種類が「次のページから」
    // (既定)・「奇数/偶数ページから」なら新しいページから、「現在の位置から」なら同じページのまま余白だけ変える
    // (用紙の大きさが変わるときは、Wordと同じく新しいページから)。以前は最初のセクションの設定を文書全体に使い、
    // セクション区切りでページも変えていなかった。
    let currentSection = 0;
    function applySection(index: number) {
      const sec = structure.sections[index];
      if (!sec) return;
      const sizeChanged = Math.abs(sec.pageWidthPt - pageWidth) > 0.5 || Math.abs(sec.pageHeightPt - pageHeight) > 0.5;
      const breakPage = sec.startType !== "continuous" || sizeChanged;
      pageWidth = sec.pageWidthPt;
      pageHeight = sec.pageHeightPt;
      marginTop = sec.margins.top;
      marginBottom = sec.margins.bottom;
      marginLeft = sec.margins.left;
      marginRight = sec.margins.right;
      contentWidth = Math.max(50, pageWidth - marginLeft - marginRight);
      // 段組みのセクションを終える：次の内容は、いちばん下まで使った段の下から始める(段の高さをそろえる処理はしない)
      if (colWidths.length > 1) {
        const bottomY = Math.min(colLowest, cursorY);
        recordSeparators(bottomY);
        cursorY = bottomY;
      }
      ({ header: headerReserve, footer: footerReserve } = reservesOf(index));
      marginTopEff = headerReserve > 0 ? Math.max(marginTop, headerReserve) : marginTop;
      bottomLimit = footerReserve > 0 ? Math.max(marginBottom, footerReserve) : marginBottom;
      setupColumns(sec.columns);
      if (!breakPage) {
        // 「現在の位置から」のセクション：ページのヘッダー・フッターは、ページが始まったときのセクションのまま(Wordと同じ)
        pageGeom.set(page, pageGeom.get(page) ?? { marginLeft: secLeft, contentWidth: secWidth, section: geomSection });
        return;
      }
      geomSection = index;
      if (atPageTopOf(page)) {
        // まだ何も描いていないページは、そのページの用紙を新しいセクションの用紙にする
        page.setSize(pageWidth, pageHeight);
        pageGeom.set(page, { marginLeft: secLeft, contentWidth: secWidth, section: index });
        cursorY = pageHeight - marginTopEff;
      } else newPage();
      // 奇数/偶数ページから：ページ番号が合わないときは、白紙のページを1枚はさむ(Wordと同じ)
      const n = doc.getPageCount();
      if ((sec.startType === "oddPage" && n % 2 === 0) || (sec.startType === "evenPage" && n % 2 === 1)) newPage();
    }
    /** そのページに何も描いていないか(描いた位置は記録していないので、今のページで、書き始めの位置のままか) */
    function atPageTopOf(pg: PDFPage) {
      return pg === page && pageDrawn.get(pg) !== true && atPageTop();
    }
    const pageDrawn = new Map<PDFPage, boolean>();
    const sectionOf = (bodyIndex: number | undefined) => (bodyIndex === undefined ? null : structure.bodyChildren[bodyIndex]?.sectionIndex ?? null);
    const imageRunCount = blocks.reduce((n, b) => n + (b.kind === "paragraph" ? b.runs.filter((r) => r.image).length : 0), 0);
    const imageSizesUsable = directModel || (formattingMatched && imageRunCount === formatting.bodyImages.length);

    let paragraphCount = 0;

    // ---- 画像・図形・テキストボックス ----
    // 段落の中の画像は、先にすべてPDFに埋め込んでおく(行を描くときに使う)
    const embeddedImages = new Map<string, PdfLibTypes.PDFImage>();
    flushFrontDrawsRef = (pg) => flushFrontDraws(pg);
    const imageByOrdinal = new Map<number, string>();
    // 表のセルの中の画像(文書の中のファイルの参照)
    const cellImage = (o: ParaObject): InlineImageRef | undefined => {
      const rel = o.rId ? formatting.rels[o.rId] : undefined;
      if (!rel || rel.external) return undefined;
      return { dataUri: rel.target, ordinal: -1, ...(o.widthPt > 0 && o.heightPt > 0 ? { w: o.widthPt, h: o.heightPt } : {}) };
    };
    const cellLink = (rid: string): string | undefined => {
      const rel = formatting.rels[rid];
      return rel && rel.external && /^https?:\/\//i.test(rel.target) ? rel.target : undefined;
    };
    const imageKeys = new Set<string>();
    for (const b of blocks) {
      if (b.kind === "paragraph") for (const r of b.runs) if (r.image) imageKeys.add(r.image.dataUri);
      if (b.kind === "table" && b.fmt && directModel)
        for (const row of b.fmt.rows) for (const cell of row.cells) for (const p of cell.paragraphs) for (const o of p.objects) {
          const ref = cellImage(o);
          if (ref) imageKeys.add(ref.dataUri);
        }
    }
    // ヘッダー・フッターの画像(行の中の画像・浮動配置の画像。部品ごとの参照で、画像のファイルを決める)
    for (const sec of hfSections)
      for (const hf of [...Object.values(sec.headers), ...Object.values(sec.footers)])
        for (const p of hf?.paragraphs ?? [])
          for (const o of p.objects) {
            const rel = o.rId ? hf!.rels[o.rId] : undefined;
            if (rel && !rel.external) imageKeys.add(rel.target);
          }
    // 文書の中の画像のファイル(word/media/…)を、使うものだけ取り出す(ブラウザの中で。外には送らない)
    const mediaFiles = new Map<string, Uint8Array>();
    const wantedMedia = [...imageKeys].filter((k) => !k.startsWith("data:"));
    if (wantedMedia.length > 0) {
      try {
        const wanted = new Set(wantedMedia);
        const files = unzipSync(new Uint8Array(arrayBuffer), { filter: (info) => wanted.has(info.name) });
        for (const [name, data] of Object.entries(files)) mediaFiles.set(name, data);
      } catch {
        warnings.push("画像の読み込みに失敗したため、画像を省略しました");
      }
    }
    for (const b of blocks) {
      if (b.kind !== "paragraph") continue;
      for (const r of b.runs) if (r.image && r.image.ordinal >= 0) imageByOrdinal.set(r.image.ordinal, r.image.dataUri);
    }
    for (const key of imageKeys) {
      const img = await embedImageKey(key);
      if (img) embeddedImages.set(key, img);
    }

    // 最初のセクションの、ヘッダー・フッターの高さの分だけ、本文の上下の位置を決める(画像の大きさも含めるため、画像を埋め込んだあと)
    ({ header: headerReserve, footer: footerReserve } = reservesOf(0));
    if (headerReserve > 0) marginTopEff = Math.max(marginTop, headerReserve);
    if (footerReserve > 0) bottomLimit = Math.max(marginBottom, footerReserve);
    cursorY = pageHeight - marginTopEff;
    setupColumns(structure.sections[0]?.columns);

    /** 浮動配置(wp:anchor)の画像の通し番号 → その位置・大きさ・折り返し */
    const floatByImage = new Map<number, FloatObject>();
    if (imageSizesUsable) for (const f of formatting.floats) if (f.kind === "image" && f.imageOrdinal !== null) floatByImage.set(f.imageOrdinal, f);
    /** 行の中に置く画像の大きさ(浮動配置の画像は null。行の中では幅0で、別に置く) */
    function inlineImageBox(c: FlatChar): { w: number; h: number } | null {
      if (!c.image) return null;
      if (c.image.ordinal >= 0 && floatByImage.has(c.image.ordinal)) return null;
      const img = embeddedImages.get(c.image.dataUri);
      if (!img) return null;
      const saved = c.image.w && c.image.h ? { widthPt: c.image.w, heightPt: c.image.h } : imageSizesUsable && c.image.ordinal >= 0 ? formatting.bodyImages[c.image.ordinal] : undefined;
      let w = saved && saved.widthPt > 0 ? saved.widthPt : img.width * 0.75;
      let h = saved && saved.heightPt > 0 ? saved.heightPt : img.height * 0.75;
      // 本文の幅・高さに収まるように縮める(拡大はしない)
      const shrink = Math.min(1, contentWidth / Math.max(1, w), (pageHeight - marginTopEff - bottomLimit) / Math.max(1, h));
      w *= shrink;
      h *= shrink;
      return { w, h };
    }

    /** 文字が回り込む領域(このページの、浮動配置の画像・図形)。PDFの座標(下が0)。band=上下に回り込む(横には文字を置かない) */
    interface Exclusion { page: PDFPage; x1: number; x2: number; top: number; bottom: number; band: boolean }
    const exclusions: Exclusion[] = [];
    /** 文字の前面に置く図形(そのページの文字を描いたあとに描く) */
    const frontDraws: { page: PDFPage; draw: () => void }[] = [];
    const flushFrontDraws = (pg: PDFPage) => {
      for (let i = 0; i < frontDraws.length; i++) {
        if (frontDraws[i].page !== pg) continue;
        const saved = page;
        page = pg;
        frontDraws[i].draw();
        page = saved;
        frontDraws.splice(i--, 1);
      }
    };

    /** 浮動配置の左上の位置(PDFの座標)。Wordの位置の基準(用紙・余白・段・段落・行)と、距離または揃えから求める */
    function floatPosition(f: FloatObject, paraTopY: number, paraLeftX: number): { x: number; top: number } {
      const frameH: [number, number] =
        f.h.rel === "page" ? [0, pageWidth]
        : f.h.rel === "leftMargin" ? [0, marginLeft]
        : f.h.rel === "rightMargin" ? [pageWidth - marginRight, marginRight]
        : f.h.rel === "character" ? [paraLeftX, contentWidth]
        : [marginLeft, contentWidth];
      let x = frameH[0] + (f.h.offsetPt ?? 0);
      if (f.h.align === "center") x = frameH[0] + (frameH[1] - f.widthPt) / 2;
      else if (f.h.align === "right" || f.h.align === "outside") x = frameH[0] + frameH[1] - f.widthPt;
      else if (f.h.align === "left" || f.h.align === "inside") x = frameH[0];
      const frameV: [number, number] =
        f.v.rel === "page" ? [pageHeight, pageHeight]
        : f.v.rel === "topMargin" ? [pageHeight, marginTop]
        : f.v.rel === "bottomMargin" ? [marginBottom, marginBottom]
        : f.v.rel === "margin" ? [pageHeight - marginTop, pageHeight - marginTop - marginBottom]
        : [paraTopY, 0];
      let top = frameV[0] - (f.v.offsetPt ?? 0);
      if (f.v.align === "center") top = frameV[0] - (frameV[1] - f.heightPt) / 2;
      else if (f.v.align === "bottom" || f.v.align === "outside") top = frameV[0] - frameV[1] + f.heightPt;
      else if (f.v.align === "top" || f.v.align === "inside") top = frameV[0];
      return { x, top };
    }

    /**
     * 画像を、ページの中身のいちばん下(文字の背面)に描く。ページの描画の命令の列の先頭に、画像を描く命令を入れる
     * (ヘッダー/フッターは本文のあとに描くため、そのまま描くと本文の文字の上に重なってしまう)
     */
    function drawImageBehind(pg: PDFPage, img: PdfLibTypes.PDFImage, x: number, y: number, w: number, h: number) {
      const lib = pdfLib();
      const name = pg.node.newXObject("Image", img.ref);
      const ops = [lib.pushGraphicsState(), ...lib.drawImage(name, { x, y, width: w, height: h, rotate: lib.degrees(0), xSkew: lib.degrees(0), ySkew: lib.degrees(0) }), lib.popGraphicsState()];
      const ref = doc.context.register(doc.context.contentStream(ops));
      pg.node.normalize();
      const contents = pg.node.Contents();
      if (contents instanceof lib.PDFArray) contents.insert(0, ref);
      else pg.drawImage(img, { x, y, width: w, height: h });
    }

    /** 浮動配置の画像・図形・テキストボックスを描く */
    function drawFloatObject(f: FloatObject, x: number, top: number) {
      const w = f.widthPt;
      const h = f.heightPt;
      if (f.kind === "image") {
        const uri = f.imageOrdinal !== null ? imageByOrdinal.get(f.imageOrdinal) : undefined;
        const img = uri ? embeddedImages.get(uri) : undefined;
        if (img) page.drawImage(img, { x, y: top - h, width: w, height: h });
        return;
      }
      const fill = f.fill ? hexToRgb(f.fill) : undefined;
      const border = f.line ? hexToRgb(f.line) : undefined;
      const bw = border ? Math.max(0.25, f.lineWidthPt) : 0;
      if (f.geometry === "ellipse") page.drawEllipse({ x: x + w / 2, y: top - h / 2, xScale: w / 2, yScale: h / 2, color: fill, borderColor: border, borderWidth: bw });
      else if (f.geometry === "line") page.drawLine({ start: { x, y: top }, end: { x: x + w, y: top - h }, thickness: bw || 0.75, color: border ?? INK });
      else if (fill || border) page.drawRectangle({ x, y: top - h, width: w, height: h, color: fill, borderColor: border, borderWidth: bw });
      if (f.kind !== "textbox") return;
      // テキストボックスの中の段落：箱の内側の幅で行を組み、箱の高さまで描く(はみ出す分は描かない。Wordと同じ)
      const innerW = w - f.inset.left - f.inset.right;
      const bottomY = top - h + f.inset.bottom;
      let y = top - f.inset.top;
      for (const para of f.paragraphs) {
        const size = para.baseSizePt ?? BODY_SIZE;
        const chars = fmtParagraphChars(para, { size, bold: false });
        const left = Math.max(0, para.leftPt ?? 0);
        const placedBox = placeParagraph(chars, { firstX: Math.max(0, left + (para.firstLinePt ?? 0)), contX: left, maxX: Math.max(10, innerW - Math.max(0, para.rightPt ?? 0)), align: para.align ?? "left", tabs: tabSpecs(para), paraSize: size, fmt: para });
        y -= para.beforePt ?? 0;
        for (let i = 0; i < placedBox.lines.length; i++) {
          if (y - placedBox.heights[i] < bottomY - 0.5) return;
          paintLine(chars, placedBox.lines[i], x + f.inset.left, y, placedBox.sizes[i], placedBox.extras[i]);
          y -= placedBox.heights[i];
        }
        y -= para.afterPt ?? 0;
      }
    }

    /** 段落に置かれた浮動配置を、いまのページに置く(位置を決めて描き、文字が回り込む領域を記録する) */
    /**
     * 浮動配置の物の、文字を置かない範囲。四角形の折り返しは、物の外接の四角形(＋周りの間隔)。
     * 外周(tight)・内部(through)の折り返しで輪郭(wp:wrapPolygon)があるときは、物の高さを細い帯に分け、
     * 帯ごとに輪郭の左右の端を求める(輪郭に沿って文字が近づく)。文字を置く側の指定(左だけ・右だけ・広い方だけ)にも従う。
     */
    function exclusionsOf(f: FloatObject, x: number, top: number): { x1: number; x2: number; top: number; bottom: number; band: boolean }[] {
      const band = f.wrapKind === "topAndBottom";
      const sideAdjust = (x1: number, x2: number): [number, number] => {
        const colL = marginLeft;
        const colR = marginLeft + contentWidth;
        let side = f.wrapSide;
        if (side === "largest") side = x1 - colL >= colR - x2 ? "left" : "right";
        if (side === "left") return [x1, Math.max(x2, pageWidth)];
        if (side === "right") return [Math.min(x1, 0), x2];
        return [x1, x2];
      };
      const poly = (f.wrapKind === "tight" || f.wrapKind === "through") && f.polygon ? f.polygon : null;
      if (!poly || band) {
        const [x1, x2] = band ? [x - f.dist.left, x + f.widthPt + f.dist.right] : sideAdjust(x - f.dist.left, x + f.widthPt + f.dist.right);
        return [{ x1, x2, top: top + f.dist.top, bottom: top - f.heightPt - f.dist.bottom, band }];
      }
      // 輪郭の、高さ y0〜y1(0〜1)の帯の中での左右の端(0〜1)
      const extentIn = (y0: number, y1: number): [number, number] | null => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < poly.length; i++) {
          const [ax, ay] = poly[i];
          const [bx, by] = poly[(i + 1) % poly.length];
          // 辺のうち、帯の中にある部分の端の点
          const t0 = ay === by ? 0 : Math.max(0, Math.min(1, (y0 - ay) / (by - ay)));
          const t1 = ay === by ? 1 : Math.max(0, Math.min(1, (y1 - ay) / (by - ay)));
          for (const t of [t0, t1]) {
            const py = ay + (by - ay) * t;
            if (py < y0 - 1e-9 || py > y1 + 1e-9) continue;
            const px = ax + (bx - ax) * t;
            lo = Math.min(lo, px);
            hi = Math.max(hi, px);
          }
          if (ay >= y0 && ay <= y1) {
            lo = Math.min(lo, ax);
            hi = Math.max(hi, ax);
          }
        }
        return lo <= hi ? [lo, hi] : null;
      };
      const STRIPS = 16;
      const out: { x1: number; x2: number; top: number; bottom: number; band: boolean }[] = [];
      for (let i = 0; i < STRIPS; i++) {
        const y0 = i / STRIPS;
        const y1 = (i + 1) / STRIPS;
        const e = extentIn(y0, y1);
        if (!e) continue;
        const [x1, x2] = sideAdjust(x + e[0] * f.widthPt - f.dist.left, x + e[1] * f.widthPt + f.dist.right);
        out.push({ x1, x2, top: top - y0 * f.heightPt + (i === 0 ? f.dist.top : 0), bottom: top - y1 * f.heightPt - (i === STRIPS - 1 ? f.dist.bottom : 0), band: false });
      }
      return out;
    }

    function placeFloats(bodyIndex: number | undefined, paraTopY: number, paraLeftX: number) {
      if (bodyIndex === undefined || !formattingMatched) return;
      for (const f of formatting.floats) {
        if (f.bodyIndex !== bodyIndex) continue;
        if (f.kind === "image" && (!imageSizesUsable || f.imageOrdinal === null)) continue;
        const { x, top } = floatPosition(f, paraTopY, paraLeftX);
        const pg = page;
        if (f.wrap === "none" && !f.behind) frontDraws.push({ page: pg, draw: () => drawFloatObject(f, x, top) });
        else drawFloatObject(f, x, top);
        if (f.wrap !== "none") for (const ex of exclusionsOf(f, x, top)) exclusions.push({ page: pg, ...ex });
      }
    }

    /** 画像(文書の中のファイルのパス、または data URI)を、PDFに埋め込む */
    async function embedImageKey(key: string): Promise<PdfLibTypes.PDFImage | null> {
      if (key.startsWith("data:")) return embedDataUri(key);
      const bytes = mediaFiles.get(key);
      if (!bytes) return null;
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        warnings.push("画像サイズが大きすぎるため省略しました");
        return null;
      }
      // 画像の種類は、ファイルの中身(先頭のバイト)で見分ける
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      try {
        if (isPng) return await doc.embedPng(bytes);
        if (isJpg) return await doc.embedJpg(bytes);
      } catch {
        warnings.push("破損している可能性のある画像を省略しました");
        return null;
      }
      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      warnings.push(`対応していない画像形式(${ext || "不明"})のため省略しました`);
      return null;
    }

    /** 画像のdata URIを、PDFに埋め込む */
    async function embedDataUri(uri: string): Promise<PdfLibTypes.PDFImage | null> {
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(uri);
      if (!match) return null;
      try {
        const binary = atob(match[2]);
        if (binary.length > MAX_IMAGE_BYTES) {
          warnings.push("画像サイズが大きすぎるため省略しました");
          return null;
        }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (match[1] === "image/png") return await doc.embedPng(bytes);
        if (match[1] === "image/jpeg" || match[1] === "image/jpg") return await doc.embedJpg(bytes);
        warnings.push(`対応していない画像形式(${match[1]})のため省略しました`);
        return null;
      } catch {
        warnings.push("破損している可能性のある画像を省略しました");
        return null;
      }
    }
    let tableCount = 0;
    let imageCount = 0;

    /** 「次の段落と分離しない」段落のあとに続けて同じページに置く必要がある高さ(次の段落の最初の行。続けて分離しない段落があれば足す) */
    function keepNextHeight(bi: number): number {
      let total = 0;
      for (let j = bi + 1; j < Math.min(blocks.length, bi + 8); j++) {
        const nb = blocks[j];
        if (nb.kind === "pagebreak") return 0;
        if (nb.kind === "image") return total + 40;
        if (nb.kind === "table") return total + BODY_SIZE * SINGLE_LINE_SPACING_FACTOR + 4;
        const m = measureParagraph(nb);
        if (!m) return total;
        if (nb.fmt?.keepNext) {
          total += m.before + m.heights.reduce((a, b) => a + b, 0) + m.after;
          continue;
        }
        // 次の段落の最初の行(改ページ時1行残さない設定なら、最初の2行)
        const firstLines = m.heights.slice(0, widowOn(nb.fmt ?? null) && m.heights.length >= 2 ? 2 : 1).reduce((a, b) => a + b, 0);
        return total + m.before + firstLines;
      }
      return total;
    }

    let prevStyleId: string | null | undefined;
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      // セクションが変わったら、用紙・余白を切り替える
      const sec = block.kind === "pagebreak" ? null : sectionOf(block.bodyIndex);
      if (sec !== null && sec > currentSection) {
        for (let k = currentSection + 1; k <= sec; k++) applySection(k);
        currentSection = sec;
      }
      if (block.kind === "pagebreak") {
        if (block.column) nextColumnOrPage();
        else newPage();
        prevStyleId = undefined;
        continue;
      }
      pageDrawn.set(page, true);
      if (block.kind === "paragraph") {
        if (block.runs.some((r) => r.text.trim() !== "")) paragraphCount++;
        const next = blocks[bi + 1];
        const nextStyleId = next && next.kind === "paragraph" && next.fmt ? next.fmt.styleId : undefined;
        drawParagraph(block, prevStyleId, nextStyleId, block.fmt?.keepNext ? keepNextHeight(bi) : 0);
        prevStyleId = block.fmt ? block.fmt.styleId : undefined;
        continue;
      }
      prevStyleId = undefined;
      if (block.kind === "table") {
        tableCount++;
        drawTable(block);
        continue;
      }
      if (block.kind === "image") {
        imageCount++;
        await drawImage(block);
        continue;
      }
    }

    // ページごとにヘッダー/フッターを描く（ページ番号・総ページ数は、ここで実際の数に置き換える）
    // どのヘッダー/フッターを使うか：そのページが始まったときのセクションの、先頭ページ用(そのセクションの最初のページで、
    // w:titlePg があるとき)・偶数ページ用(w:evenAndOddHeaders があり、偶数ページのとき)・既定、の順に選ぶ(Wordと同じ)
    {
      const pages = doc.getPages();
      const pageCount = pages.length;
      let prevSection = -1;
      /** ヘッダー/フッターの段落の中の、浮動配置の画像を描く(文字の背面の画像は、ページの中身のいちばん下に描く) */
      const drawHfFloats = (hf: HeaderFooterFmt, para: ParaFmt, paraTopY: number) => {
        for (const o of para.objects) {
          if (!o.anchored || !o.float || o.float.kind !== "image") continue;
          const rel = o.rId ? hf.rels[o.rId] : undefined;
          const img = rel && !rel.external ? embeddedImages.get(rel.target) : undefined;
          if (!img) continue;
          const { x, top } = floatPosition(o.float, paraTopY, marginLeft);
          if (o.float.behind) drawImageBehind(page, img, x, top - o.float.heightPt, o.float.widthPt, o.float.heightPt);
          else page.drawImage(img, { x, y: top - o.float.heightPt, width: o.float.widthPt, height: o.float.heightPt });
        }
      };
      pages.forEach((pg, idx) => {
        page = pg;
        const geom = pageGeom.get(pg);
        const si = geom?.section ?? 0;
        const firstOfSection = si !== prevSection;
        prevSection = si;
        const sec = structure.sections[si];
        if (sec) {
          pageWidth = sec.pageWidthPt;
          marginTop = sec.margins.top;
          marginBottom = sec.margins.bottom;
          marginLeft = sec.margins.left;
          marginRight = sec.margins.right;
        }
        if (geom) {
          marginLeft = geom.marginLeft;
          contentWidth = geom.contentWidth;
        }
        pageHeight = pg.getSize().height;
        pageWidth = pg.getSize().width;
        const pageNo = idx + 1;
        const k = kindsOf(si);
        const pick = (kinds: (HeaderFooterFmt | undefined)[]) => {
          const [dflt, first, even] = kinds;
          if (k.refs.titlePg && firstOfSection) return first;
          if (formatting.evenAndOdd && pageNo % 2 === 0) return even;
          return dflt;
        };
        const headerHf = pick(k.headers);
        const header = hfMeasure(headerHf, pageNo, pageCount);
        let y = pageHeight - k.refs.headerDistancePt;
        for (const item of header.out) {
          if (headerHf) drawHfFloats(headerHf, item.fmt, y);
          item.placed.lines.forEach((line, i) => {
            paintLine(item.chars, line, marginLeft, y, item.placed.sizes[i], item.placed.extras[i]);
            y -= item.placed.heights[i];
          });
          y -= item.fmt.afterPt ?? 0;
        }
        const footerHf = pick(k.footers);
        const footer = hfMeasure(footerHf, pageNo, pageCount);
        y = k.refs.footerDistancePt + footer.total;
        for (const item of footer.out) {
          if (footerHf) drawHfFloats(footerHf, item.fmt, y);
          item.placed.lines.forEach((line, i) => {
            paintLine(item.chars, line, marginLeft, y, item.placed.sizes[i], item.placed.extras[i]);
            y -= item.placed.heights[i];
          });
          y -= item.fmt.afterPt ?? 0;
        }
      });
    }

    // 段の境界線(w:sep)
    recordSeparators(Math.min(colLowest, cursorY));
    for (const sp of separators) sp.page.drawLine({ start: { x: sp.x, y: sp.top }, end: { x: sp.x, y: sp.bottom }, thickness: 0.5, color: INK });
    // 文字の前面に置く図形を描く(まだ描いていないページの分)
    for (const pg of doc.getPages()) flushFrontDraws(pg);
    if (savedBreaksIgnored > 0) {
      warnings.push(
        `Wordで保存したときに記録されたページの区切りのうち${savedBreaksIgnored}か所は、今回のレイアウトの計算と大きく離れていたため使っていません（保存したあとに内容が変わった、またはフォントが違う可能性があります）。`
      );
    }
    if (formattingMatched && formatting.savedByWord && formatting.savedPageCount && formatting.savedPageCount !== doc.getPageCount()) {
      warnings.push(`Wordで保存されたときのページ数は${formatting.savedPageCount}ページですが、PDFは${doc.getPageCount()}ページになりました。`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return {
      blob,
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
      warnings: Array.from(new Set(warnings)),
      paragraphCount,
      tableCount,
      imageCount,
    };
  }
}
