import { readXlsxSheets, type XlsxSheet } from "@/lib/excel/xlsx-simple-io";

/** テスト用: xlsxのバイト列を、アプリの読み込み処理（画面と同じ readXlsxSheets）で読み取る */
export async function readXlsxFileAsSheets(bytes: Uint8Array, name: string): Promise<XlsxSheet[]> {
  const file = new File([new Uint8Array(bytes)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return readXlsxSheets(file);
}
