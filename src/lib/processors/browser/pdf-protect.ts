import { BrowserProcessor, type PdfProcessorOutput } from "../types";
import { loadPdfDoc } from "./pdf";
import { encryptPdfDocument, type PdfPermissions } from "@/lib/pdf/encrypt";
import { getPdfjs, PDFJS_ASSET_OPTIONS } from "@/lib/pdf/pdfjs-client";

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
    // 確かめるために開いたPDFは、開けた・開けなかったにかかわらず、必ず閉じる（作業用スレッドを残さない。ロードマップC 工程2）
    const noPasswordTask = pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_ASSET_OPTIONS });
    try {
      await noPasswordTask.promise;
    } catch (e) {
      rejectsWithoutPassword = e instanceof Error && e.name === "PasswordException";
    } finally {
      await noPasswordTask.destroy().catch(() => {});
    }
    let verifiedWithPassword = false;
    const passwordTask = pdfjs.getDocument({ data: bytes.slice(), password: userPassword, ...PDFJS_ASSET_OPTIONS });
    try {
      const pdf = await passwordTask.promise;
      verifiedWithPassword = pdf.numPages === pageCount;
    } catch {
      verifiedWithPassword = false;
    } finally {
      await passwordTask.destroy().catch(() => {});
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
