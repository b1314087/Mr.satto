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

export interface WordDocumentStructure {
  /** 文書内に現れる順のセクション設定一覧。通常のDOCXではほぼ必ず1個。 */
  sections: SectionSettings[];
  bodyChildren: BodyChildHint[];
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

/** DOCX(ArrayBuffer)から、セクション設定と本文直下の構造ヒントを読み取る。
 *  取得に失敗した場合は空の結果を返す(呼び出し側は必ず既定値へフォールバックする)。 */
export function parseWordDocumentStructure(arrayBuffer: ArrayBuffer): WordDocumentStructure {
  const empty: WordDocumentStructure = { sections: [], bodyChildren: [] };
  try {
    const bytes = new Uint8Array(arrayBuffer);
    const entries = unzipSync(bytes, { filter: (info) => info.name === "word/document.xml" });
    const xmlBytes = entries["word/document.xml"];
    if (!xmlBytes) return empty;
    const xmlText = new TextDecoder("utf-8").decode(xmlBytes);
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return empty;

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

    return { sections, bodyChildren };
  } catch {
    return empty;
  }
}
