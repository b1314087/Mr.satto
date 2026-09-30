import { unzipSync, zipSync, type Zippable } from "fflate";

/**
 * Word段落整理（Tool 9）・Word番号振り直し（Tool 10）が共通で使う、
 * .docx（OOXML）を直接編集するための最小限のユーティリティ。
 *
 * 既存依存の docx（新規Documentの組み立て専用・書き込み専用）も
 * mammoth（DOCX→HTMLの非可逆変換・読み取り専用）も、
 * 「既存の.docxの内部構造を保ったまま、テキストだけを書き換えて保存し直す」
 * ことができない。そのため、Excel側のooxml-page-settings.ts・
 * word/section-settings.tsと同じ方針で、新しい巨大なWord解析ライブラリを
 * 追加する代わりに、既存のfflate（ZIP解凍・再圧縮）とブラウザ標準の
 * DOMParser/XMLSerializerだけでword/document.xmlを直接読み書きする。
 *
 * 変更するのはword/document.xmlの中身だけで、それ以外のZIPエントリ
 * （スタイル・テーマ・画像・[Content_Types].xml等）はバイト列のまま
 * 再圧縮して保持するため、Wordの内部構造（書式・画像・レイアウト）への
 * 影響を最小限にとどめる。
 */

const DEFAULT_XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export interface DocxPackage {
  /** ZIP内の全エントリ（word/document.xml以外はそのまま保持する） */
  entries: Record<string, Uint8Array>;
  documentXmlText: string;
  xmlDeclaration: string;
}

/** .docxファイルを読み込み、ZIPエントリ一式とdocument.xmlのテキストを取り出す */
export async function loadDocxPackage(file: File): Promise<DocxPackage> {
  const buf = await file.arrayBuffer();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error(
      `${file.name} を読み込めませんでした。Wordファイル(.docx)が破損しているか、対応していない形式の可能性があります。`
    );
  }
  const docXmlBytes = entries["word/document.xml"];
  if (!docXmlBytes) {
    throw new Error("このファイルはWord文書(.docx)として認識できませんでした");
  }
  const documentXmlText = new TextDecoder("utf-8").decode(docXmlBytes);
  const declMatch = /^<\?xml[^>]*\?>/.exec(documentXmlText);
  return {
    entries,
    documentXmlText,
    xmlDeclaration: declMatch ? declMatch[0] : DEFAULT_XML_DECLARATION,
  };
}

/** document.xmlのテキストをXML DOMとして解析する */
export function parseDocumentXml(documentXmlText: string): Document {
  const doc = new DOMParser().parseFromString(documentXmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Word文書の内部データを解析できませんでした（対応していない形式の可能性があります）");
  }
  return doc;
}

/** 編集後のXML DOMを文字列へ戻す（XML宣言を保持する） */
export function serializeDocumentXml(doc: Document, xmlDeclaration: string): string {
  const serialized = new XMLSerializer().serializeToString(doc);
  return serialized.startsWith("<?xml") ? serialized : `${xmlDeclaration}\n${serialized}`;
}

/** word/document.xmlだけを差し替えて.docxを再構築する */
export function buildDocxBlob(pkg: DocxPackage, newDocumentXmlText: string): Blob {
  const newEntries: Zippable = {};
  for (const [name, data] of Object.entries(pkg.entries)) {
    newEntries[name] = name === "word/document.xml" ? new TextEncoder().encode(newDocumentXmlText) : data;
  }
  let zipped: Uint8Array;
  try {
    zipped = zipSync(newEntries, { level: 6 });
  } catch {
    throw new Error("Word文書の生成に失敗しました");
  }
  return new Blob([new Uint8Array(zipped)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export function getBodyElement(doc: Document): Element {
  const body = doc.getElementsByTagName("w:body")[0];
  if (!body) throw new Error("Word文書の本文（w:body）が見つかりませんでした");
  return body;
}

/** 段落(w:p)内の全テキストランを連結した文字列 */
export function getParagraphText(pEl: Element): string {
  return Array.from(pEl.getElementsByTagName("w:t"))
    .map((t) => t.textContent ?? "")
    .join("");
}

/**
 * 段落が「空白行」かどうかを判定する。
 * テキストが空（または空白のみ）で、かつ図形(w:drawing)や画像(w:pict)を
 * 含まない場合にのみ「空白」とみなす（画像だけの段落を誤って削除しないため）。
 */
export function isParagraphBlank(pEl: Element): boolean {
  const text = getParagraphText(pEl).trim();
  if (text !== "") return false;
  if (pEl.getElementsByTagName("w:drawing").length > 0) return false;
  if (pEl.getElementsByTagName("w:pict").length > 0) return false;
  return true;
}

/**
 * 本文(w:body)直下の段落(w:p)だけを取得する（表(w:tbl)内のセルの段落は含まない）。
 * 表のセルは必ず1つ以上の段落を持たなければならないOOXMLの制約があるため、
 * 段落の削除・並べ替えは本文直下の段落のみを対象にする（安全側に倒す設計）。
 */
export function getTopLevelParagraphs(body: Element): Element[] {
  return Array.from(body.children).filter((c) => c.tagName === "w:p");
}

/** 文書全体（表のセル内も含む）の全テキストラン(w:t)を取得する */
export function getAllTextRuns(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName("w:t"));
}
