import { unzipSync } from "fflate";
import { MAX_FILE_SIZE_MULTIPLIER } from "@/lib/plans/file-size";

/**
 * Excel・Wordのファイルの、拡張子と中身（実際の形式）の確認。
 * .xlsx/.xlsm/.docx は ZIP の形式（先頭が "PK"）で、中に決まった部品がある。
 * 古い形式（.xls/.doc）は、まったく別の形式（先頭が D0 CF 11 E0）のため、ブラウザの中では安全に読めない。
 */
export const MAX_OFFICE_FILE_MB = 30;

export type OfficeKind = "excel" | "word";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

export class OfficeFileError extends Error {}

function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name.toLowerCase());
  return m ? m[1] : "";
}

/**
 * 形式を確かめて、ZIPの中身（部品のパス → 中身）を返す。問題があれば、利用者に見せる文の OfficeFileError を投げる。
 * ZIPの展開は、確認に必要な部品だけ（[Content_Types].xml と本体の部品）。
 */
export async function checkOfficeFile(file: File, kind: OfficeKind): Promise<Uint8Array> {
  const ext = extOf(file.name);
  const okExt = kind === "excel" ? ["xlsx", "xlsm"] : ["docx"];
  if (kind === "word" && ext === "doc") {
    throw new OfficeFileError("古い形式のWord文書（.doc）には対応していません。Wordで「名前を付けて保存」から「Word文書（.docx）」を選んで保存し直してから、お試しください。");
  }
  if (kind === "excel" && ext === "xls") {
    throw new OfficeFileError("古い形式のExcelファイル（.xls）には対応していません。Excelで「名前を付けて保存」から「Excelブック（.xlsx）」を選んで保存し直してから、お試しください。");
  }
  if (!okExt.includes(ext)) {
    throw new OfficeFileError(kind === "excel" ? "Excelファイル（.xlsx・.xlsm）を選択してください。" : "Word文書（.docx）を選択してください。");
  }
  // プランごとの上限はファイル選択の欄で確かめる。ここは、いちばん大きいプランの上限での安全装置
  if (file.size > MAX_OFFICE_FILE_MB * MAX_FILE_SIZE_MULTIPLIER * 1024 * 1024) {
    throw new OfficeFileError(`ファイルが大きすぎます（上限${MAX_OFFICE_FILE_MB * MAX_FILE_SIZE_MULTIPLIER}MB）。`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (hasMagic(bytes, OLE_MAGIC)) {
    throw new OfficeFileError(
      kind === "excel"
        ? "このファイルは、拡張子は .xlsx ですが、中身は古い形式（.xls）または暗号化されたファイルです。パスワードを解除するか、.xlsx形式で保存し直してからお試しください。"
        : "このファイルは、拡張子は .docx ですが、中身は古い形式（.doc）または暗号化されたファイルです。パスワードを解除するか、.docx形式で保存し直してからお試しください。"
    );
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new OfficeFileError(`${file.name} は${kind === "excel" ? "Excel" : "Word"}のファイルとして読み込めませんでした。ファイルが壊れているか、別の形式の可能性があります。`);
  }
  const main = kind === "excel" ? "xl/workbook.xml" : "word/document.xml";
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (f) => f.name === "[Content_Types].xml" || f.name === main });
  } catch {
    throw new OfficeFileError(`${file.name} を開けませんでした。ファイルが壊れている可能性があります。`);
  }
  if (!parts[main]) {
    throw new OfficeFileError(
      kind === "excel"
        ? `${file.name} にはExcelのブックが含まれていません（Word・PowerPointなど、別のOfficeのファイルの可能性があります）。`
        : `${file.name} にはWordの文書が含まれていません（Excel・PowerPointなど、別のOfficeのファイルの可能性があります）。`
    );
  }
  return bytes;
}
