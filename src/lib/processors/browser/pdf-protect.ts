import { BrowserProcessor, type PdfProcessorOutput } from "../types";
import { loadPdfDoc } from "./pdf";
import { encryptPdfDocument, type PdfPermissions } from "@/lib/pdf/encrypt";
import { getPdfjs } from "@/lib/pdf/pdfjs-client";

export interface PdfProtectInput {
  file: File;
  userPassword: string;
  ownerPassword?: string;
  permissions: PdfPermissions;
}

export interface PdfProtectOutput extends PdfProcessorOutput {
  /** 保存したPDFをパスワードなしで開こうとして、拒否されたことを確認できたか */
  rejectsWithoutPassword: boolean;
  /** 保存したPDFを指定のパスワードで開き直し、ページ数が一致したか */
  verifiedWithPassword: boolean;
}

/**
 * PDFパスワード保護。暗号化後のファイルを、実際にPDF.jsで「パスワードなし→拒否」
 * 「パスワードあり→開ける」の両方を確かめてから返す(暗号化したつもりで壊れたファイルを渡さないため)。
 */
export class PdfPasswordProtectProcessor extends BrowserProcessor<PdfProtectInput, PdfProtectOutput> {
  async process({ file, userPassword, ownerPassword, permissions }: PdfProtectInput): Promise<PdfProtectOutput> {
    const doc = await loadPdfDoc(file, { updateMetadata: false });
    const pageCount = doc.getPageCount();
    const bytes = await encryptPdfDocument(doc, { userPassword, ownerPassword, permissions });

    const pdfjs = await getPdfjs();
    let rejectsWithoutPassword = false;
    try {
      const task = pdfjs.getDocument({ data: bytes.slice() });
      await task.promise;
      await task.destroy();
    } catch (e) {
      rejectsWithoutPassword = e instanceof Error && e.name === "PasswordException";
    }
    let verifiedWithPassword = false;
    try {
      const task = pdfjs.getDocument({ data: bytes.slice(), password: userPassword });
      const pdf = await task.promise;
      verifiedWithPassword = pdf.numPages === pageCount;
      await task.destroy();
    } catch {
      verifiedWithPassword = false;
    }
    if (!verifiedWithPassword || !rejectsWithoutPassword) {
      throw new Error("暗号化したPDFの確認に失敗しました。別のPDFでお試しください。");
    }

    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return {
      blob,
      url: URL.createObjectURL(blob),
      pageCount,
      sizeBytes: blob.size,
      rejectsWithoutPassword,
      verifiedWithPassword,
    };
  }
}
