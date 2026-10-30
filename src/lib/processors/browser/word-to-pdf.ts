import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  degrees,
  setTextRenderingMode,
  TextRenderingMode,
  setLineWidth,
  setStrokingRgbColor,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { addLinkAnnotation } from "@/lib/pdf/pdf-link-annotation";
import { parseWordDocumentStructure, type BodyChildHint, type DefaultParagraphSpacing } from "@/lib/word/section-settings";
import {
  parseDocxFormatting,
  PAGE_NUMBER_CHAR,
  PAGE_COUNT_CHAR,
  type BorderFmt,
  type DocxFormatting,
  type HeaderFooterFmt,
  type ParaFmt,
  type RunFmt,
  type TableFmt,
} from "@/lib/word/docx-format";
import { layoutParagraph, type LayoutLine, type TabStopSpec } from "@/lib/word/word-layout";

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
function resolveLineHeight(spacing: DefaultParagraphSpacing, size: number, gridLinePitchPt: number | null): number {
  if (spacing.lineRule === "exact" && spacing.lineValue !== null) {
    // exact指定は行グリッドより優先される(Word自体の挙動)
    return spacing.lineValue;
  }
  let natural: number;
  if (spacing.lineRule === "atLeast" && spacing.lineValue !== null) {
    natural = Math.max(spacing.lineValue, size * SINGLE_LINE_SPACING_FACTOR);
  } else if (spacing.lineRule === "auto" && spacing.lineValue !== null) {
    const multiplier = spacing.lineValue / 240; // 240 = 1行(単一間隔)
    natural = size * SINGLE_LINE_SPACING_FACTOR * multiplier;
  } else {
    // 文書側から行間情報が全く取得できなかった場合: 従来の固定値(15pt)ではなく、
    // Wordの単一行間隔によりまだ近いフォントサイズ比例の値にフォールバックする
    natural = size * SINGLE_LINE_SPACING_FACTOR;
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

// ---------------------------------------------------------------------------
// 内部ドキュメントモデル
// ---------------------------------------------------------------------------
interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
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
}
interface TableBlock {
  kind: "table";
  rows: TextRun[][][]; // rows[row][col] = そのセルのruns
  /** word/document.xmlから読み取った、表の書式（セル結合・背景色・列幅など。読み取れた場合のみ） */
  fmt?: TableFmt | null;
}
interface ImageBlock {
  kind: "image";
  dataUri: string;
  altText: string;
}
interface PageBreakBlock {
  kind: "pagebreak";
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
  let tableOrdinal = 0;

  /** 段落の通し番号から、書式（段落全体・文字ごと）を段落ブロックに付ける */
  function attachFormat(block: ParagraphBlock, id: number | null) {
    if (!formatting || id === null) return;
    const entry = formatting.body[id];
    if (!entry || entry.tag !== "p") return;
    block.fmt = entry.para;
    const fmtChars: RunFmt[] = [];
    let fmtText = "";
    for (const r of entry.para.runs) {
      for (const ch of Array.from(r.text)) {
        fmtChars.push(r.fmt);
        fmtText += ch;
      }
    }
    const blockText = flattenRuns(block.runs.filter((r) => r.text !== ""))
      .map((c) => c.ch)
      .join("");
    if (fmtText === blockText) block.charFmts = fmtChars;
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
        const runs: TextRun[] = [];
        let hasImage = false;
        child.childNodes.forEach((c) => {
          if (c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName.toLowerCase() === "img") {
            hasImage = true;
            const img = c as Element;
            const src = img.getAttribute("src") || "";
            if (src.startsWith("data:image/")) {
              blocks.push({ kind: "image", dataUri: src, altText: img.getAttribute("alt") || "" });
            } else {
              warnings.push("data URI形式でない画像を検出したため省略しました");
            }
          } else {
            runs.push(...extractRuns(c, { bold: false, italic: false, underline: false }));
          }
        });
        if (!hasImage) {
          const { runs: idStripped, id: paraId } = extractParaIdMarker(runs);
          const { runs: strippedRuns, hangingIndentPt } = extractHangingIndentMarker(idStripped);
          if (isPageBreakParagraph(strippedRuns)) {
            blocks.push({ kind: "pagebreak" });
          } else if (isEmptyParagraphMarker(strippedRuns)) {
            // 開発指示書C-2〜C-4: mammothが本来消してしまう空段落を、
            // markEmptyParagraphsで埋め込んだマーカーから実際の空段落(runs: [])へ戻す。
            const block: ParagraphBlock = { kind: "paragraph", runs: [], heading: 0 };
            attachFormat(block, paraId);
            blocks.push(block);
          } else {
            const block: ParagraphBlock = { kind: "paragraph", runs: strippedRuns, heading: 0, hangingIndentPt };
            attachFormat(block, paraId);
            blocks.push(block);
          }
        }
        return;
      }
      if (tag === "ul" || tag === "ol") {
        walkListItems(child, tag === "ol", 0);
        return;
      }
      if (tag === "table") {
        const tableBlock = extractTable(child);
        if (useTableFmts) tableBlock.fmt = tableFmts[tableOrdinal] ?? null;
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
  return { blocks, warnings };
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
      });
    }
  }
  return out;
}

/** 書式つきの段落（runs）から、文字の並びを作る（ヘッダー/フッター・表のセル用）。ページ番号の目印は実際の番号に置き換える */
function fmtParagraphChars(para: ParaFmt, defaults: { size: number; bold: boolean }, pageNo = 1, pageCount = 1): FlatChar[] {
  const out: FlatChar[] = [];
  for (const run of para.runs) {
    const f = run.fmt;
    for (const ch0 of Array.from(run.text)) {
      const text = ch0 === PAGE_NUMBER_CHAR ? String(pageNo) : ch0 === PAGE_COUNT_CHAR ? String(pageCount) : ch0;
      for (const ch of Array.from(text)) {
        out.push({
          ch,
          bold: f.bold || defaults.bold,
          italic: f.italic,
          underline: f.underline,
          size: f.sizePt ?? defaults.size,
          color: f.color,
          highlight: f.highlight,
          strike: f.strike,
          script: f.script,
        });
      }
    }
  }
  return out;
}

function hexToRgb(hexColor: string | null, fallback = rgb(0.12, 0.12, 0.14)) {
  if (!hexColor || !/^[0-9a-fA-F]{6}$/.test(hexColor)) return fallback;
  return rgb(parseInt(hexColor.slice(0, 2), 16) / 255, parseInt(hexColor.slice(2, 4), 16) / 255, parseInt(hexColor.slice(4, 6), 16) / 255);
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
    if (structure.sections.length > 1) {
      warnings.push(
        "この文書には複数のセクション（用紙設定が変わる区切り）が含まれています。現在の実装では最初のセクションの用紙設定（用紙サイズ・向き・余白）を文書全体に適用しており、2つ目以降のセクションで用紙設定が変わる場合は反映されません。"
      );
    }

    // 段落・文字・表・ヘッダー/フッターの書式（中央揃え・文字サイズ・色など）を、word/*.xmlから直接読む
    const formatting = parseDocxFormatting(arrayBuffer);
    let formattingMatched = false;

    const mammoth = await import("mammoth");
    let html: string;
    try {
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        {
          convertImage: mammoth.images.dataUri,
          transformDocument: ((documentNode: unknown) => {
            const marked = markEmptyParagraphs(markPageBreaks(injectPageBreakBeforeMarkers(documentNode, structure.bodyChildren)));
            const withIds = injectParaIdMarkers(marked, formatting.body.length);
            formattingMatched = withIds.ok;
            return withIds.node;
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

    const { blocks, warnings: parseWarnings } = htmlToBlocks(html, formattingMatched ? formatting : null);
    warnings.push(...parseWarnings);

    if (blocks.length === 0) {
      throw new Error("このWord文書から変換できる内容が見つかりませんでした。");
    }

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }

    let doc: PDFDocument;
    let font: PDFFont;
    try {
      doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    // 用紙サイズ・余白(開発指示書C-3・C-4・C-8): DOCXの最初のセクションから取得できれば
    // それを使い、取得できなければ既定値(A4・56pt)にフォールバックする。
    const pageWidth = section?.pageWidthPt ?? DEFAULT_PAGE_WIDTH;
    const pageHeight = section?.pageHeightPt ?? DEFAULT_PAGE_HEIGHT;
    const marginTop = section?.margins.top ?? DEFAULT_MARGIN;
    const marginBottom = section?.margins.bottom ?? DEFAULT_MARGIN;
    const marginLeft = section?.margins.left ?? DEFAULT_MARGIN;
    const marginRight = section?.margins.right ?? DEFAULT_MARGIN;
    const contentWidth = Math.max(50, pageWidth - marginLeft - marginRight);
    let bottomLimit = marginBottom;
    let marginTopEff = marginTop;

    let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
    let cursorY = pageHeight - marginTopEff;

    function newPage() {
      if (doc.getPageCount() >= MAX_PAGE_COUNT) {
        throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
      }
      page = doc.addPage([pageWidth, pageHeight]);
      cursorY = pageHeight - marginTopEff;
    }

    function ensureSpace(height: number) {
      if (cursorY - height < bottomLimit) newPage();
    }

    const INK = rgb(0.12, 0.12, 0.14);
    const defaultTabPt = formatting.defaultTabPt;
    const gridPitch = section?.docGridLinePitchPt ?? null;

    function drawSize(c: FlatChar): number {
      return c.script ? c.size * 0.65 : c.size;
    }
    function widthsOf(chars: FlatChar[]): number[] {
      return chars.map((c) => (c.ch === "\t" || c.ch === "\n" ? 0 : font.widthOfTextAtSize(c.ch, drawSize(c))));
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
        { firstX: o.firstX, contX: o.contX, maxX: o.maxX, tabs: o.tabs, defaultTab: defaultTabPt, align: o.align }
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
        let size = 0;
        for (const it of line.items) size = Math.max(size, chars[it.index].size);
        if (size === 0) size = o.paraSize;
        sizes.push(size);
        let h: number;
        let extra = 0;
        if (o.fixedLineHeight !== undefined) h = o.fixedLineHeight;
        else if (o.legacyHeadingHeight) h = size + 6;
        else {
          h = resolveLineHeight(spacing, size, gridPitch);
          if (spacing.lineRule === "auto" && (spacing.lineValue ?? 240) > 240 && !gridPitch) extra = Math.max(0, h - size * SINGLE_LINE_SPACING_FACTOR);
        }
        heights.push(h);
        extras.push(extra);
      }
      return { lines, heights, sizes, extras };
    }

    /** 1行ぶんの文字を描く（同じ書式が続く文字をまとめて、塗り・縁取り・下線・取り消し線・リンクを付ける） */
    function paintLine(chars: FlatChar[], line: LayoutLine, originX: number, topY: number, size: number, extra: number) {
      const items = line.items.filter((it) => chars[it.index].ch !== "\t" && chars[it.index].ch !== "\n");
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
        const color = first.link ? rgb(0.1, 0.32, 0.75) : hexToRgb(first.color, INK);
        const x0 = originX + group[0].x;
        const x1 = originX + group[group.length - 1].x + group[group.length - 1].width;
        if (first.highlight) {
          page.drawRectangle({ x: x0, y: y - ds * 0.22, width: x1 - x0, height: ds * 1.2, color: hexToRgb(first.highlight) });
        }
        if (first.bold) {
          page.pushOperators(setLineWidth(ds * 0.028), setStrokingRgbColor(color.red, color.green, color.blue), setTextRenderingMode(TextRenderingMode.FillAndOutline));
        }
        // 1文字ずつdrawTextを呼ぶ理由: 英字に数字が続く文字列を1回で描くと、PDFの
        // テキスト情報（コピー・検索用）だけが化けることがあるため（従来からの回避策）。
        for (const it of group) {
          page.drawText(chars[it.index].ch, { x: originX + it.x, y, size: ds, font, color, ...(first.italic ? { xSkew: degrees(12) } : {}) });
        }
        if (first.bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
        if (first.underline || first.link) {
          page.drawLine({ start: { x: x0, y: y - 1.5 }, end: { x: x1, y: y - 1.5 }, thickness: 0.6, color });
        }
        if (first.strike) {
          page.drawLine({ start: { x: x0, y: y + ds * 0.3 }, end: { x: x1, y: y + ds * 0.3 }, thickness: 0.6, color });
        }
        if (first.link) addLinkAnnotation(doc, page, first.link, { x: x0, y: y - 2, width: x1 - x0, height: ds + 2 });
      }
    }

    function drawBorderLine(x1: number, y1: number, x2: number, y2: number, b: BorderFmt) {
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(0.3, b.widthPt), color: hexToRgb(b.color, rgb(0, 0, 0)) });
    }

    function tabSpecs(fmt: ParaFmt | null): TabStopSpec[] {
      return (fmt?.tabs ?? []).map((t) => ({ pos: t.posPt, kind: t.kind }));
    }

    function drawParagraph(block: ParagraphBlock, prevStyleId?: string | null, nextStyleId?: string | null) {
      const fmt = block.fmt ?? null;
      const isHeading = block.heading > 0;
      const headingSize = Math.max(20 - (block.heading - 1) * 2, 12);
      const paraSize = fmt?.baseSizePt ?? (isHeading ? headingSize : BODY_SIZE);
      const runs = block.runs.filter((r) => r.text !== "");
      const chars = toFlatChars(runs, block.charFmts, { size: paraSize, bold: isHeading });

      const listIndent = block.list ? 16 + block.list.level * 16 : 0;
      let firstX: number;
      let contX: number;
      if (fmt && !block.list && (fmt.leftPt !== null || fmt.firstLinePt !== null)) {
        const left = Math.max(0, fmt.leftPt ?? 0);
        contX = left;
        firstX = Math.max(0, left + (fmt.firstLinePt ?? 0));
      } else {
        firstX = listIndent;
        contX = block.hangingIndentPt ?? listIndent;
      }
      const maxX = contentWidth - Math.max(0, fmt?.rightPt ?? 0);
      if (maxX - Math.max(firstX, contX) <= 10) return;

      const placed = placeParagraph(chars, {
        firstX,
        contX,
        maxX,
        align: fmt?.align ?? "left",
        tabs: tabSpecs(fmt),
        paraSize,
        fmt,
        legacyHeadingHeight: isHeading && !fmt,
      });

      const topY = pageHeight - marginTopEff;
      // 「同じスタイルの段落の間は間隔を空けない」（箇条書きなど）
      const sameAsPrev = !!fmt?.contextual && prevStyleId !== undefined && prevStyleId === fmt.styleId;
      const sameAsNext = !!fmt?.contextual && nextStyleId !== undefined && nextStyleId === fmt.styleId;
      const before = sameAsPrev ? 0 : (fmt?.beforePt ?? 0);
      if (before > 0 && cursorY < topY - 0.5) cursorY -= before;

      // 改ページの位置を先に決める（枠線・背景色を、ページごとに正しい範囲へ描くため）
      interface Chunk { start: number; end: number; newPage: boolean; top: number }
      const chunks: Chunk[] = [];
      let y = cursorY;
      let cur: Chunk = { start: 0, end: 0, newPage: false, top: y };
      placed.lines.forEach((_, i) => {
        const h = placed.heights[i];
        if (y - h < bottomLimit && y < topY - 0.01) {
          if (i > cur.start) {
            cur.end = i;
            chunks.push(cur);
            cur = { start: i, end: i, newPage: true, top: topY };
          } else {
            cur.newPage = true;
            cur.top = topY;
          }
          y = topY;
        }
        y -= h;
      });
      cur.end = placed.lines.length;
      chunks.push(cur);

      const box = fmt && (fmt.fill || fmt.borders) ? fmt : null;
      chunks.forEach((chunk, ci) => {
        if (chunk.newPage) newPage();
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
          if (block.list && i === 0) {
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
      rows: { cells: NCell[]; heightPt: number | null }[];
      borders: { top: BorderFmt | null; bottom: BorderFmt | null; left: BorderFmt | null; right: BorderFmt | null; insideH: BorderFmt | null; insideV: BorderFmt | null };
      indent: number;
      align: "left" | "center" | "right";
      padX: number;
      padY: number;
      fixedLineHeight?: number;
    }

    function normalizeTable(block: TableBlock): NTable {
      const f = block.fmt;
      if (f) {
        return {
          grid: f.gridPt,
          rows: f.rows.map((r) => ({
            heightPt: r.heightPt,
            cells: r.cells.map((c) => ({
              span: c.gridSpan,
              vMerge: c.vMerge,
              fill: c.fill,
              vAlign: c.vAlign,
              borders: c.borders,
              paras: c.paragraphs.map((p) => {
                const size = p.baseSizePt ?? BODY_SIZE;
                return { chars: fmtParagraphChars(p, { size, bold: r.isHeader }), fmt: p, size };
              }),
            })),
          })),
          borders: f.borders,
          indent: f.indentPt,
          align: f.align,
          padX: Math.max(f.cellPadLeftPt, f.cellPadRightPt),
          padY: 2,
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
      interface CellLayout { col: number; span: number; cell: NCell; paras: { placed: PlacedLines; para: NPara }[]; need: number }
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
          const layout: CellLayout = { col, span, cell, paras, need: need + t.padY * 2 };
          col += span;
          return layout;
        });
      });

      // 行の高さ（縦に結合したセルは、結合した行の合計で足りるようにする）
      const rowHeights = layouts.map((row, ri) => {
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
      for (let ri = 0; ri < layouts.length; ri++) {
        const rowHeight = rowHeights[ri];
        ensureSpace(rowHeight);
        const rowTop = cursorY;
        const draws: (() => void)[] = [];
        for (const l of layouts[ri]) {
          if (l.cell.vMerge === "continue") continue;
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
                paintLine(p.para.chars, line, x + t.padX, cy, p.placed.sizes[i], p.placed.extras[i]);
                cy -= p.placed.heights[i];
              });
              if (t.fixedLineHeight === undefined) cy -= Math.min(p.para.fmt?.afterPt ?? 0, 6);
            }
          });
        }
        for (const d of draws) d();
        cursorY = rowTop - rowHeight;
      }
      cursorY -= PARAGRAPH_GAP;
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
      let { width, height } = embedded.scaleToFit(contentWidth, maxHeight);
      if (width <= 0 || height <= 0) {
        width = contentWidth;
        height = contentWidth * 0.5;
      }
      ensureSpace(height);
      page.drawImage(embedded, { x: marginLeft, y: cursorY - height, width, height });
      cursorY -= height + PARAGRAPH_GAP;
    }

    // ---- ヘッダー / フッター ----
    const headerFooterParts = (hf: HeaderFooterFmt | undefined) => (hf && hf.paragraphs.some((p) => p.runs.some((r) => r.text.trim() !== "")) ? hf : undefined);
    const hfMeasure = (hf: HeaderFooterFmt | undefined, pageNo: number, pageCount: number) => {
      const out: { chars: FlatChar[]; placed: PlacedLines; fmt: ParaFmt }[] = [];
      let total = 0;
      if (!hf) return { out, total };
      for (const p of hf.paragraphs) {
        const size = p.baseSizePt ?? BODY_SIZE;
        const chars = fmtParagraphChars(p, { size, bold: false }, pageNo, pageCount);
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
    const refs = formatting.refs;
    const headerKinds = (["default", "first", "even"] as const).map((k) => headerFooterParts(formatting.headers[k]));
    const footerKinds = (["default", "first", "even"] as const).map((k) => headerFooterParts(formatting.footers[k]));
    const maxHeaderH = Math.max(0, ...headerKinds.map((h) => hfMeasure(h, 1, 1).total));
    const maxFooterH = Math.max(0, ...footerKinds.map((f) => hfMeasure(f, 1, 1).total));
    if (maxHeaderH > 0) marginTopEff = Math.max(marginTop, (refs?.headerDistancePt ?? 36) + maxHeaderH);
    if (maxFooterH > 0) bottomLimit = Math.max(marginBottom, (refs?.footerDistancePt ?? 36) + maxFooterH);
    cursorY = pageHeight - marginTopEff;

    let paragraphCount = 0;
    let tableCount = 0;
    let imageCount = 0;

    let prevStyleId: string | null | undefined;
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      if (block.kind === "pagebreak") {
        newPage();
        prevStyleId = undefined;
        continue;
      }
      if (block.kind === "paragraph") {
        if (block.runs.some((r) => r.text.trim() !== "")) paragraphCount++;
        const next = blocks[bi + 1];
        const nextStyleId = next && next.kind === "paragraph" && next.fmt ? next.fmt.styleId : undefined;
        drawParagraph(block, prevStyleId, nextStyleId);
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
    {
      const pages = doc.getPages();
      const pageCount = pages.length;
      const pick = (kinds: (HeaderFooterFmt | undefined)[], pageNo: number) => {
        const [dflt, first, even] = kinds;
        if (refs?.titlePg && pageNo === 1) return first;
        if (formatting.evenAndOdd && pageNo % 2 === 0) return even;
        return dflt;
      };
      pages.forEach((pg, idx) => {
        page = pg;
        const pageNo = idx + 1;
        const header = hfMeasure(pick(headerKinds, pageNo), pageNo, pageCount);
        let y = pageHeight - (refs?.headerDistancePt ?? 36);
        for (const item of header.out) {
          item.placed.lines.forEach((line, i) => {
            paintLine(item.chars, line, marginLeft, y, item.placed.sizes[i], item.placed.extras[i]);
            y -= item.placed.heights[i];
          });
          y -= item.fmt.afterPt ?? 0;
        }
        const footer = hfMeasure(pick(footerKinds, pageNo), pageNo, pageCount);
        y = (refs?.footerDistancePt ?? 36) + footer.total;
        for (const item of footer.out) {
          item.placed.lines.forEach((line, i) => {
            paintLine(item.chars, line, marginLeft, y, item.placed.sizes[i], item.placed.extras[i]);
            y -= item.placed.heights[i];
          });
          y -= item.fmt.afterPt ?? 0;
        }
      });
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
