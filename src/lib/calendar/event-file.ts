/**
 * 予定表として取り込むファイルの種類の判定と、CSVの読み取り（純粋な処理だけ。ブラウザ内で使う）。
 * 判定は、拡張子とMIMEタイプの両方を見る（ドラッグ&ドロップでは、選択ダイアログのaccept属性が効かないため）。
 */
import type { EventCellValue } from "./event-import";

export type EventFileKind = "excel" | "csv" | "pdf" | "image" | "legacy-excel" | "unsupported";

const IMAGE_EXT = /\.(png|jpe?g)$/i;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg"]);

export function classifyEventFile(file: { name: string; type: string }): EventFileKind {
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(name)) return "excel";
  if (/\.xls$/.test(name)) return "legacy-excel";
  if (/\.(csv|tsv)$/.test(name) || type === "text/csv") return "csv";
  if (/\.pdf$/.test(name) || type === "application/pdf") return "pdf";
  if (IMAGE_EXT.test(name) || IMAGE_MIME.has(type)) return "image";
  return "unsupported";
}

/** 選択ダイアログに渡す accept（画像は拡張子とMIMEの両方。スマートフォンでは、HEICの写真が自動でJPEGに変換される） */
export const EVENT_FILE_ACCEPT = ".xlsx,.xlsm,.csv,.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const UNSUPPORTED_FILE_MESSAGE =
  "このファイル形式には対応していません。Excel（.xlsx）・CSV・PDF・画像（PNG・JPG・JPEG）のいずれかを選んでください。";
export const LEGACY_EXCEL_MESSAGE = "古い形式（.xls）は読み込めません。Excelで「名前を付けて保存」から、Excelブック（.xlsx）にして選んでください。";

/** CSVの文字コードを判定して文字にする。UTF-8（BOMつき含む）で読めなければ、Excelの日本語CSVに多いShift_JISとして読む */
export function decodeCsvBytes(bytes: ArrayBuffer): string {
  // Excelの「Unicodeテキスト」で保存したファイルは、BOMつきのUTF-16。UTF-8やShift_JISとして読むと文字化けして、
  // 読めない行が大量に出てしまう（AIに送る対象にもなってしまう）ため、BOMで判定して先に読む
  const head = new Uint8Array(bytes.slice(0, 2));
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes).replace(/^\uFEFF/, "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** CSV（カンマ・タブ区切り、ダブルクォートで囲んだ項目・改行を含む項目に対応）→ 行 × セルの文字 */
export function parseCsv(text: string): EventCellValue[][] {
  const delimiter = text.split(/\r?\n/, 1)[0].includes("\t") && !text.split(/\r?\n/, 1)[0].includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
