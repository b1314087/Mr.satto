import { getBodyElement, parseDocumentXml } from "@/lib/word/docx-text-ops";

/**
 * word-to-pdf のプレビュー用に、Word文書の本文を段落テキストの配列として取り出す。
 * 本文直下の段落(w:p)はそのまま、表(w:tbl)は1行ずつ「 | 」区切りの1段落にする。
 */
export function extractBodyTexts(documentXmlText: string): string[] {
  const doc = parseDocumentXml(documentXmlText);
  const body = getBodyElement(doc);
  const textOf = (el: Element) =>
    Array.from(el.getElementsByTagName("w:t"))
      .map((t) => t.textContent ?? "")
      .join("");
  const result: string[] = [];
  for (const child of Array.from(body.children)) {
    if (child.tagName === "w:p") {
      result.push(textOf(child));
    } else if (child.tagName === "w:tbl") {
      for (const tr of Array.from(child.getElementsByTagName("w:tr"))) {
        const cells = Array.from(tr.getElementsByTagName("w:tc")).map((tc) => textOf(tc));
        result.push(`【表】 ${cells.join(" | ")}`);
      }
    }
  }
  return result;
}
