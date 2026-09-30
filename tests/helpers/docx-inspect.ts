/**
 * テスト側（Node.js実行環境）でのDOCX内容検証ヘルパー。
 *
 * 生成されたDOCXから実際のテキストを取り出して確認するための最小限の
 * ヘルパー。新しい依存は追加せず、tests/fixtures/docx-writer.ts や
 * アプリ本体のsection-settings.tsと同じく、fflateでZIPを解凍し
 * word/document.xmlの<w:t>要素の中身を単純な正規表現で連結するだけに
 * とどめる（テストコード側だけで完結させる方針。厳密なXMLパースは不要）。
 */
export async function readDocxText(filePath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const { unzipSync, strFromU8 } = await import("fflate");
  const bytes = new Uint8Array(await fs.readFile(filePath));
  const entries = unzipSync(bytes, { filter: (info) => info.name === "word/document.xml" });
  const xml = entries["word/document.xml"] ? strFromU8(entries["word/document.xml"]) : "";
  return Array.from(xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g))
    .map((m) => m[1])
    .join(" ");
}
