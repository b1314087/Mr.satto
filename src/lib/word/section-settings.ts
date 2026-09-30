import { unzipSync } from "fflate";

/**
 * DOCX（word/document.xml）内部XMLから、ページ設定（セクション情報）を
 * 直接読み取る（Phase 18.2 C節）。
 *
 * mammoth（既存依存。DOCX→HTML変換に使用）は、見出し・段落・書式・リスト・表・
 * 画像などの「内容」はHTMLへ変換するが、セクション区切り(w:sectPr)・用紙サイズ
 * (w:pgSz)・余白(w:pgMar)・「段落の前で改ページ」(w:pageBreakBefore)といった
 * 「ページ構造」に関する情報はmammothの中間ドキュメントモデルの時点で読み捨てられる
 * （node_modules/mammoth/lib/docx/body-reader.js のignoreElementsにw:sectPr・
 * w:pPrが含まれ、pageBreakBeforeを読み取るコードも存在しないことを確認済み）。
 *
 * これらは開発指示書C-3・C-4・C-8・C-9・C-11の実現に必須のため、Excel側
 * （src/lib/excel/ooxml-page-settings.ts）と同じ方針で、新しい巨大なWord解析
 * ライブラリを追加する代わりに、既存のfflate（ZIP解凍）とブラウザ標準の
 * DOMParserだけでdocument.xmlを直接読む。取得に失敗しても例外は投げず、
 * 「情報なし」として呼び出し側のフォールバック（既定のA4・既定の余白）に
 * 進む（PDF変換自体を止めないため）。
 */

const TWIPS_PER_POINT = 20;

export interface SectionMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SectionSettings {
  /** pt単位 */
  pageWidthPt: number;
  pageHeightPt: number;
  orientation: "portrait" | "landscape";
  /** pt単位 */
  margins: SectionMargins;
}

/** 文書本文(w:body)の直下の子要素のうち、段落(w:p)・表(w:tbl)だけを対象に、
 *  mammothの中間ドキュメントモデル(Document.children、同じくw:p/w:tblだけが
 *  1つずつ対応するノードになる。w:sectPr等はmammoth側でも読み捨てられるため
 *  インデックスがずれない)と同じ並び・同じ個数になるように記録する。 */
export interface BodyChildHint {
  tag: "p" | "tbl";
  /** その段落(w:p)が <w:pPr><w:pageBreakBefore/></w:pPr> を持つか */
  pageBreakBefore: boolean;
}

/**
 * 文書既定の行間・段落前後の間隔（外出先PC修正指示書§32-35「Wordで1ページの
 * 文書がPDFで2ページになる」対応）。
 *
 * 個々の段落(w:p)ごとのw:pPr/w:spacing上書きまでは追跡しない
 * （段落ごとにmammothの中間木・最終的なDocBlock配列とのインデックス対応を
 * 保つのが難しいため）。代わりに、文書のほぼ全ての本文段落に効いている
 * 「既定値」だけを、word/styles.xmlの<w:docDefaults>と"Normal"スタイルから
 * 読み取る。これは一部の個別段落の特殊な行間設定までは再現できないが、
 * 「PDF側の行間・段落間隔が実際の文書設定より常に広すぎて、本来1ページに
 * 収まるはずの文書が2ページ目にあふれる」という報告された不具合の根本原因
 * （後述）には直接対処できる。
 *
 * 【なぜこれが根本原因なのか】
 * 従来のword-to-pdf.tsは、本文の行間を実寸フォントサイズに関係なく
 * 固定値15pt(LINE_HEIGHT)、段落後の間隔を固定値6pt(PARAGRAPH_GAP)としていた。
 * 実際のWordの既定（英語版Office既定のCalibri 11pt・行間1.08・段落後8pt等、
 * 日本語版Officeの既定である游明朝/メイリオ・行間1.0(単一)・段落後0pt等）は
 * 文書によって様々だが、本実装が長年使ってきた本文サイズ10.5ptに対する
 * 「1.43倍」という行間(15pt)は、Wordの「単一行間隔」(通常は概ね1.15〜1.2倍
 * 程度)よりも常に大きく、段落後6pt固定も「段落後0pt」を既定にしている
 * 文書（ビジネス文書に多い）では常に余分な間隔を追加してしまう。これが
 * 積み重なることで、Word上は1ページに収まる文章がPDFでは2ページ目へ
 * あふれる、という報告された症状を引き起こしていた。
 */
export interface DefaultParagraphSpacing {
  /** w:spacing@w:lineRule。auto=倍数指定(240=1行)、exact/atLeast=絶対値(twips) */
  lineRule: "auto" | "exact" | "atLeast" | null;
  /** lineRule="auto"のとき: 240を1行とする倍数の生値。exact/atLeastのとき: pt単位の絶対値 */
  lineValue: number | null;
  /** pt単位。段落前の間隔 */
  beforePt: number | null;
  /** pt単位。段落後の間隔 */
  afterPt: number | null;
}

export interface WordDocumentStructure {
  /** 文書内に現れる順のセクション設定一覧。通常のDOCXではほぼ必ず1個。 */
  sections: SectionSettings[];
  bodyChildren: BodyChildHint[];
  /** 取得できなかった場合は全フィールドnullの空オブジェクト（呼び出し側は既存の固定値にフォールバックする） */
  defaultSpacing: DefaultParagraphSpacing;
}

function twipsToPt(twips: number): number {
  return twips / TWIPS_PER_POINT;
}

function parseSectPr(sectPrEl: Element): SectionSettings {
  const pgSz = sectPrEl.getElementsByTagName("w:pgSz")[0];
  const pgMar = sectPrEl.getElementsByTagName("w:pgMar")[0];

  const wAttr = pgSz?.getAttribute("w:w");
  const hAttr = pgSz?.getAttribute("w:h");
  const wTwips = wAttr ? Number(wAttr) : 11906; // 既定: A4縦(210mm)相当
  const hTwips = hAttr ? Number(hAttr) : 16838; // 既定: A4縦(297mm)相当
  const orientAttr = pgSz?.getAttribute("w:orient");
  const orientation: "portrait" | "landscape" =
    orientAttr === "landscape" ? "landscape" : orientAttr === "portrait" ? "portrait" : wTwips > hTwips ? "landscape" : "portrait";

  const marginAttr = (name: string, fallback: number) => {
    const v = pgMar?.getAttribute(name);
    return v !== null && v !== undefined ? twipsToPt(Number(v)) : fallback;
  };

  return {
    pageWidthPt: twipsToPt(wTwips),
    pageHeightPt: twipsToPt(hTwips),
    orientation,
    margins: {
      top: marginAttr("w:top", 56.7), // 既定: 1inch(72pt)よりやや狭いWordの標準値(1417twips)相当
      bottom: marginAttr("w:bottom", 56.7),
      left: marginAttr("w:left", 56.7),
      right: marginAttr("w:right", 56.7),
    },
  };
}

function hasPageBreakBefore(pEl: Element): boolean {
  const pPr = pEl.getElementsByTagName("w:pPr")[0];
  if (!pPr) return false;
  const el = pPr.getElementsByTagName("w:pageBreakBefore")[0];
  if (!el) return false;
  // w:val="0"/"false" の場合のみ無効。属性自体が無ければ有効(既定true)とみなす(OOXML仕様どおり)。
  const val = el.getAttribute("w:val");
  return val === null || !(val === "0" || val.toLowerCase() === "false");
}

const EMPTY_DEFAULT_SPACING: DefaultParagraphSpacing = {
  lineRule: null,
  lineValue: null,
  beforePt: null,
  afterPt: null,
};

/** w:pPr/w:spacing 1つから DefaultParagraphSpacing を読み取る（無ければ全てnull） */
function parseSpacingEl(pPrEl: Element | undefined): DefaultParagraphSpacing {
  const spacing = pPrEl?.getElementsByTagName("w:spacing")[0];
  if (!spacing) return { ...EMPTY_DEFAULT_SPACING };

  const lineAttr = spacing.getAttribute("w:line");
  const lineRuleAttr = spacing.getAttribute("w:lineRule");
  let lineRule: DefaultParagraphSpacing["lineRule"] = null;
  let lineValue: number | null = null;
  if (lineAttr !== null) {
    const raw = Number(lineAttr);
    if (lineRuleAttr === "exact" || lineRuleAttr === "atLeast") {
      lineRule = lineRuleAttr;
      lineValue = twipsToPt(raw); // exact/atLeastのw:lineはtwips単位の絶対値
    } else {
      // lineRule省略時の既定は"auto"(倍数指定)。w:lineは240を1行とする値。
      lineRule = "auto";
      lineValue = raw;
    }
  }

  const beforeAttr = spacing.getAttribute("w:before");
  const afterAttr = spacing.getAttribute("w:after");
  // beforeAutospacing/afterAutospacing="1"の場合、w:before/afterの数値自体は
  // Wordが自動計算する値の目安に過ぎず信頼できないため、指定なし(null)として扱う
  const beforeAuto = spacing.getAttribute("w:beforeAutospacing") === "1";
  const afterAuto = spacing.getAttribute("w:afterAutospacing") === "1";

  return {
    lineRule,
    lineValue,
    beforePt: !beforeAuto && beforeAttr !== null ? twipsToPt(Number(beforeAttr)) : null,
    afterPt: !afterAuto && afterAttr !== null ? twipsToPt(Number(afterAttr)) : null,
  };
}

/**
 * word/styles.xmlの<w:docDefaults>と"Normal"（w:type="paragraph" w:default="1"、
 * 通常はw:styleId="Normal"）スタイルから、文書全体の既定段落間隔を読み取る。
 * Normal側の指定がdocDefaultsを上書きする（OOXMLの継承順序どおり）。
 * 取得できない場合はEMPTY_DEFAULT_SPACINGを返す。
 */
function parseDefaultParagraphSpacing(stylesXmlText: string | null): DefaultParagraphSpacing {
  if (!stylesXmlText) return { ...EMPTY_DEFAULT_SPACING };
  try {
    const doc = new DOMParser().parseFromString(stylesXmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return { ...EMPTY_DEFAULT_SPACING };

    const docDefaults = doc.getElementsByTagName("w:docDefaults")[0];
    const pPrDefault = docDefaults?.getElementsByTagName("w:pPrDefault")[0]?.getElementsByTagName("w:pPr")[0];
    const fromDocDefaults = parseSpacingEl(pPrDefault);

    let fromNormal: DefaultParagraphSpacing = { ...EMPTY_DEFAULT_SPACING };
    const styleEls = Array.from(doc.getElementsByTagName("w:style"));
    const normalStyle =
      styleEls.find((s) => s.getAttribute("w:type") === "paragraph" && s.getAttribute("w:styleId") === "Normal") ??
      styleEls.find((s) => s.getAttribute("w:type") === "paragraph" && s.getAttribute("w:default") === "1");
    if (normalStyle) {
      fromNormal = parseSpacingEl(normalStyle.getElementsByTagName("w:pPr")[0]);
    }

    return {
      lineRule: fromNormal.lineRule ?? fromDocDefaults.lineRule,
      lineValue: fromNormal.lineValue ?? fromDocDefaults.lineValue,
      beforePt: fromNormal.beforePt ?? fromDocDefaults.beforePt,
      afterPt: fromNormal.afterPt ?? fromDocDefaults.afterPt,
    };
  } catch {
    return { ...EMPTY_DEFAULT_SPACING };
  }
}

/** DOCX(ArrayBuffer)から、セクション設定と本文直下の構造ヒントを読み取る。
 *  取得に失敗した場合は空の結果を返す(呼び出し側は必ず既定値へフォールバックする)。 */
export function parseWordDocumentStructure(arrayBuffer: ArrayBuffer): WordDocumentStructure {
  const empty: WordDocumentStructure = { sections: [], bodyChildren: [], defaultSpacing: { ...EMPTY_DEFAULT_SPACING } };
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = unzipSync(bytes, {
      filter: (info) => info.name === "word/document.xml" || info.name === "word/styles.xml",
    });
    const xmlBytes = entries["word/document.xml"];
    if (!xmlBytes) return empty;
    const xmlText = new TextDecoder("utf-8").decode(xmlBytes);
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return empty;

    const stylesBytes = entries["word/styles.xml"];
    const defaultSpacing = parseDefaultParagraphSpacing(
      stylesBytes ? new TextDecoder("utf-8").decode(stylesBytes) : null
    );

    const body = doc.getElementsByTagName("w:body")[0];
    if (!body) return empty;

    const sections: SectionSettings[] = [];
    const bodyChildren: BodyChildHint[] = [];

    for (const child of Array.from(body.children)) {
      const tag = child.tagName;
      if (tag === "w:p") {
        bodyChildren.push({ tag: "p", pageBreakBefore: hasPageBreakBefore(child) });
        // 段落内に埋め込まれたw:sectPr(セクション区切り)があれば、そのセクションの設定を記録する
        const pPr = child.getElementsByTagName("w:pPr")[0];
        const embeddedSectPr = pPr?.getElementsByTagName("w:sectPr")[0];
        if (embeddedSectPr) sections.push(parseSectPr(embeddedSectPr));
      } else if (tag === "w:tbl") {
        bodyChildren.push({ tag: "tbl", pageBreakBefore: false });
      }
      // それ以外(bookmarkStart等)はmammoth側でも中間モデルへ現れないため、記録しない
      // （インデックスの対応関係を崩さないため、意図的に読み飛ばす）。
    }

    // 本文直下、末尾のw:sectPr(段落に属さない、文書最後のセクションの設定)
    const finalSectPr = Array.from(body.children).find((c) => c.tagName === "w:sectPr");
    if (finalSectPr) sections.push(parseSectPr(finalSectPr));

    return { sections, bodyChildren, defaultSpacing };
  } catch {
    return empty;
  }
}
