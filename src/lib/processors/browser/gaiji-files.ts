import { loadDocxPackage, parseDocumentXml } from "@/lib/word/docx-text-ops";
import { columnIndexToLetter, readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import { SCAN_MAX_CHARS, type ScanUnit } from "@/lib/gaiji/detect";

/**
 * 外字・特殊文字チェックで、ファイルから文字を取り出す（すべてブラウザ内。ファイルは外部へ送らない）。
 * 取り出すのは文字だけで、ファイルは書き換えない。
 */

export type GaijiFileKind = "text" | "docx" | "xlsx" | "pdf" | "legacy-office" | "unsupported";

// 古い形式（.doc・.xls）も選べるようにして、読み込めない理由と保存し直し方を、ツール側の案内で伝える
export const GAIJI_FILE_ACCEPT = ".txt,.csv,.tsv,.md,.docx,.xlsx,.pdf,.doc,.xls";
export const GAIJI_FILE_MAX_MB = 20;
/** PDFを調べるページ数の上限 */
export const GAIJI_PDF_MAX_PAGES = 100;

export const GAIJI_LEGACY_MESSAGE =
  "古い形式（.doc・.xls）は、読み込めません。Word・Excelで開いて、.docx・.xlsx として保存し直してから、選んでください。";
export const GAIJI_UNSUPPORTED_MESSAGE = "このファイル形式には対応していません。テキスト（.txt・.csv・.tsv・.md）、Word（.docx）、Excel（.xlsx）、PDFを選んでください。";

export function classifyGaijiFile(file: { name: string }): GaijiFileKind {
  const name = file.name.toLowerCase();
  if (/\.(txt|csv|tsv|md)$/.test(name)) return "text";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".pdf")) return "pdf";
  if (/\.(doc|xls)$/.test(name)) return "legacy-office";
  return "unsupported";
}

export interface LoadedGaijiFile {
  kind: Exclude<GaijiFileKind, "legacy-office" | "unsupported">;
  units: ScanUnit[];
  /** 利用者に伝えておくこと（読み込み方法・読み取れなかった範囲など） */
  notes: string[];
  /** テキストファイルのとき、画面のテキスト欄に入れる文字 */
  text?: string;
}

function checkLength(units: ScanUnit[]): void {
  let total = 0;
  for (const u of units) total += u.text.length;
  if (total > SCAN_MAX_CHARS) throw new Error(`文字数が多すぎます（${SCAN_MAX_CHARS.toLocaleString("ja-JP")}文字までです）。ファイルを分けて、調べてください。`);
}

/** テキストファイルを読む。UTF-8として読めなければ、Shift_JISとして読む（先頭のBOMは取り除く） */
export function decodeTextBytes(bytes: Uint8Array): { text: string; encoding: "UTF-8" | "Shift_JIS" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "Shift_JIS" };
  }
}

async function loadText(file: File): Promise<LoadedGaijiFile> {
  const { text, encoding } = decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
  const notes = [`${encoding}として読み込みました。`];
  if (encoding === "Shift_JIS") {
    notes.push("UTF-8として読み込めなかったため、Shift_JISとして読み込みました。Shift_JISのファイルでは、外字などの文字が、保存の時点で別の文字や「?」になっていることがあります。");
  }
  const units: ScanUnit[] = text.split(/\r\n|\r|\n/).map((line, i) => ({ label: `${i + 1}行目`, text: line }));
  checkLength(units);
  return { kind: "text", units, notes, text };
}

const DOCX_PARTS: { test: RegExp; label: string }[] = [
  { test: /^word\/document\.xml$/, label: "本文" },
  { test: /^word\/header\d*\.xml$/, label: "ヘッダー" },
  { test: /^word\/footer\d*\.xml$/, label: "フッター" },
  { test: /^word\/footnotes\.xml$/, label: "脚注" },
  { test: /^word\/endnotes\.xml$/, label: "文末脚注" },
];

async function loadDocx(file: File): Promise<LoadedGaijiFile> {
  const pkg = await loadDocxPackage(file);
  const units: ScanUnit[] = [];
  const decoder = new TextDecoder("utf-8");
  for (const [entryName, bytes] of Object.entries(pkg.entries)) {
    const part = DOCX_PARTS.find((p) => p.test.test(entryName));
    if (!part) continue;
    const xml = entryName === "word/document.xml" ? pkg.documentXmlText : decoder.decode(bytes);
    const doc = parseDocumentXml(xml);
    const paragraphs = Array.from(doc.getElementsByTagName("w:p"));
    let n = 0;
    for (const p of paragraphs) {
      n++;
      const text = Array.from(p.getElementsByTagName("w:t"))
        .map((t) => t.textContent ?? "")
        .join("");
      if (text !== "") units.push({ label: `${part.label}の段落${n}`, text });
    }
  }
  checkLength(units);
  return {
    kind: "docx",
    units,
    notes: [
      "本文・ヘッダー・フッター・脚注の文字を調べました（表の中の文字も含みます）。テキストボックス・図形の中の文字、画像の中の文字は調べていません。",
      "Wordの箇条書きの記号（Symbol・Wingdingsフォントの●など）は、私用領域の文字として出ることがあります。表示が正しければ、問題ありません。",
    ],
  };
}

async function loadXlsx(file: File): Promise<LoadedGaijiFile> {
  const sheets = await readXlsxSheets(file);
  const units: ScanUnit[] = [];
  for (const sheet of sheets) {
    sheet.rows.forEach((row, r) => {
      row.forEach((value, c) => {
        if (typeof value === "string" && value !== "") units.push({ label: `「${sheet.name}」の${columnIndexToLetter(c)}${r + 1}`, text: value });
      });
    });
  }
  checkLength(units);
  return {
    kind: "xlsx",
    units,
    notes: [`${sheets.length}枚のシートの、文字のセルを調べました（数値・日付のセル、数式、図形・コメントの中の文字は調べていません）。`],
  };
}

async function loadPdf(file: File, onProgress?: (done: number, total: number) => void): Promise<LoadedGaijiFile> {
  const pdf = await loadPdfDocument(file);
  if (pdf.numPages > GAIJI_PDF_MAX_PAGES) {
    throw new Error(`ページ数が多すぎます（${GAIJI_PDF_MAX_PAGES}ページまでです。このPDFは${pdf.numPages}ページです）。ページを分けて、調べてください。`);
  }
  const units: ScanUnit[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? (item.str as string) : "")).join("");
    if (text !== "") units.push({ label: `${p}ページ`, text });
    onProgress?.(p, pdf.numPages);
  }
  checkLength(units);
  const notes = [
    "PDFに埋め込まれた文字の情報を調べました。PDFでは、文字の見た目（字形）と、文字のコードが別々に保存されるため、画面で正しく見える文字でも、コードが別の文字になっていることがあります（これを見つけるためのチェックです）。",
    "逆に、外字が画像やフォント独自のコードで入っている場合は、検出できないことがあります。",
  ];
  if (units.length === 0) notes.unshift("文字の情報がありません。スキャンした画像のPDFの可能性があります（このツールは、画像の中の文字は調べません）。");
  return { kind: "pdf", units, notes };
}

export async function loadGaijiFile(file: File, onProgress?: (done: number, total: number) => void): Promise<LoadedGaijiFile> {
  const kind = classifyGaijiFile(file);
  if (kind === "legacy-office") throw new Error(GAIJI_LEGACY_MESSAGE);
  if (kind === "unsupported") throw new Error(GAIJI_UNSUPPORTED_MESSAGE);
  if (file.size > GAIJI_FILE_MAX_MB * 1024 * 1024) throw new Error(`ファイルが大きすぎます（${GAIJI_FILE_MAX_MB}MBまでです）。`);
  switch (kind) {
    case "text":
      return loadText(file);
    case "docx":
      return loadDocx(file);
    case "xlsx":
      return loadXlsx(file);
    case "pdf":
      return loadPdf(file, onProgress);
  }
}
