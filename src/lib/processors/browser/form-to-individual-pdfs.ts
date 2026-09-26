import { BrowserProcessor } from "../types";
import { createZip } from "@/lib/utils/zip";
import { sanitizeFileName, dedupeFileNames } from "@/lib/utils/format";
import { renderPersonPdf } from "@/lib/forms/template-renderer";
import { resolvePhotoForIdentifier, type PhotoLookupEntry } from "@/lib/forms/photo-matching";
import type { ColumnMapping, FieldDefinition, ParsedTable } from "@/lib/forms/types";

/**
 * フォーム回答から個別PDFを一括作成（Phase 11 ツール②）。
 *
 * テンプレートPDF + フィールド配置 + CSV/Excelの行データ + （必要なら）写真を
 * 受け取り、1人につき1つのPDFを生成し、最終的にfflateでZIPへまとめる。
 *
 * メモリに関する方針（開発指示書37章）：1人分のPDFを生成 -> そのバイト列だけを
 * 保持 -> 次の人の処理、という順番で進め、pdf-libのPDFDocumentインスタンスや
 * 画像のデコード結果を人ごとに使い回さない（renderPersonPdf側で人ごとに
 * 新しいPDFDocumentを作る設計にしている）。
 *
 * ファイル名（開発指示書25章）：既定は連番（001.pdf, 002.pdf...）。
 * 個人情報をファイル名に含めることはデバイス上での情報露出になりうるため、
 * 氏名等を含めるかはユーザーが明示的に選択した場合のみ（naming: "name"）。
 * どちらの場合もsanitizeFileName()を通し、重複時はdedupeFileNames()で一意化する。
 */

export type FilenameStrategy = "sequential" | "name";

export interface FormToIndividualPdfsInput {
  templateBytes: ArrayBuffer;
  fields: FieldDefinition[];
  table: ParsedTable;
  mapping: ColumnMapping;
  /** photoフィールドのID -> 写真の識別子として使うCSV/Excel列名 */
  photoColumnMapping: Record<string, string | null>;
  photoLookup: PhotoLookupEntry[];
  filenameStrategy: FilenameStrategy;
  /** ファイル名に使う場合の列名（filenameStrategy: "name"のとき使用） */
  filenameColumn?: string | null;
  onProgress?: (info: { current: number; total: number }) => void;
}

export interface FormToIndividualPdfsOutput {
  zipBlob: Blob;
  sizeBytes: number;
  personCount: number;
  missingPhotoCount: number;
}

function getColumnIndex(headers: string[], columnName: string | null | undefined): number {
  if (!columnName) return -1;
  return headers.indexOf(columnName);
}

export class FormToIndividualPdfsProcessor extends BrowserProcessor<
  FormToIndividualPdfsInput,
  FormToIndividualPdfsOutput
> {
  async process({
    templateBytes,
    fields,
    table,
    mapping,
    photoColumnMapping,
    photoLookup,
    filenameStrategy,
    filenameColumn,
    onProgress,
  }: FormToIndividualPdfsInput): Promise<FormToIndividualPdfsOutput> {
    if (table.rows.length === 0) {
      throw new Error("データ行がありません。CSV・Excelファイルの中身をご確認ください。");
    }
    if (fields.length === 0) {
      throw new Error("フィールドが1つも配置されていません。テンプレートにフィールドを配置してください。");
    }

    const textFields = fields.filter((f) => f.dataType === "text");
    const photoFields = fields.filter((f) => f.dataType === "photo");
    const fieldColumnIndex = new Map<string, number>();
    for (const field of textFields) {
      fieldColumnIndex.set(field.id, getColumnIndex(table.headers, mapping[field.id]));
    }
    const photoColumnIndexByField = new Map<string, number>();
    for (const field of photoFields) {
      photoColumnIndexByField.set(field.id, getColumnIndex(table.headers, photoColumnMapping[field.id]));
    }
    const filenameColumnIndex = filenameStrategy === "name" ? getColumnIndex(table.headers, filenameColumn) : -1;

    const zipNames: string[] = [];
    const zipBlobs: Blob[] = [];
    let missingPhotoCount = 0;
    const total = table.rows.length;
    const digits = String(total).length;

    for (let i = 0; i < total; i++) {
      const row = table.rows[i];

      const textValues: Record<string, string> = {};
      for (const field of textFields) {
        const idx = fieldColumnIndex.get(field.id) ?? -1;
        textValues[field.id] = idx >= 0 ? row[idx] ?? "" : "";
      }

      const photoValues: Record<string, File | null> = {};
      for (const field of photoFields) {
        const idx = photoColumnIndexByField.get(field.id) ?? -1;
        const identifier = idx >= 0 ? row[idx] ?? "" : "";
        const photo = identifier ? resolvePhotoForIdentifier(identifier, photoLookup) : null;
        photoValues[field.id] = photo;
        if (identifier && !photo) missingPhotoCount += 1;
      }

      let pdfBytes: Uint8Array;
      try {
        pdfBytes = await renderPersonPdf({ templateBytes, fields, textValues, photoValues });
      } catch (e) {
        throw new Error(`${i + 1}件目の処理中にエラーが発生しました: ${e instanceof Error ? e.message : "不明なエラー"}`);
      }

      const sequential = String(i + 1).padStart(digits, "0");
      let baseName = sequential;
      if (filenameStrategy === "name" && filenameColumnIndex >= 0) {
        const nameValue = row[filenameColumnIndex]?.trim();
        if (nameValue) baseName = `${sequential}_${sanitizeFileName(nameValue)}`;
      }

      zipNames.push(sanitizeFileName(`${baseName}.pdf`));
      zipBlobs.push(new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }));

      onProgress?.({ current: i + 1, total });
    }

    const dedupedNames = dedupeFileNames(zipNames);
    const zipBlob = await createZip(dedupedNames.map((name, i) => ({ name, blob: zipBlobs[i] })));

    return {
      zipBlob,
      sizeBytes: zipBlob.size,
      personCount: total,
      missingPhotoCount,
    };
  }
}
