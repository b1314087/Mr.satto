import { BrowserProcessor, type NamedFileOutput } from "../types";
import { canvasToBlob } from "./image";
import { stripExtension } from "@/lib/utils/format";

/**
 * PDF→画像 Processor（Phase 2-A）。
 *
 * pdf.ts の他のPDF系Processorは pdf-lib（PDF生成・編集用）を使うが、
 * PDFページをラスタ画像として描画する処理はpdf-libの対象外のため、
 * レンダリング専用の pdfjs-dist（Mozilla PDF.js）を別途利用する。
 * 目的の異なるライブラリのため、既存の pdf.ts に混在させず
 * ファイルを分けている。
 *
 * レンダリングはCanvas 2D経由でブラウザ上で完結し、ファイルは
 * 外部に送信されない。
 */

let pdfjsLibPromise: ReturnType<typeof importPdfjs> | null = null;

/**
 * pdfjs-dist は比較的重いライブラリ（Workerスクリプトのみで約1.3MB）のため、
 * このツールが実際に使われるまで読み込まない（動的import）。
 * Workerの参照先は public/pdf.worker.min.mjs に配置した静的ファイルとし、
 * バンドラー(Turbopack)依存のアセット解決に頼らない、確実な方式にしている。
 *
 * バージョンは意図的に最新(6.x)ではなく 4.10.38 に固定している。
 * 6.x系はレンダリング内部で `Map.prototype.getOrInsertComputed`
 * （非常に新しいJS機能）を前提にしており、これをサポートしない
 * ブラウザ（検証に使ったChromiumを含む）では実行時エラーになることを
 * 実機検証で確認したため。4.10.38は広く使われている安定版で、
 * 対応ブラウザの幅が広い。
 */
async function importPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjsLib;
}

function getPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = importPdfjs();
  }
  return pdfjsLibPromise;
}

export interface PdfToImageInput {
  file: File;
  mimeType: "image/png" | "image/jpeg";
  /** 描画解像度の倍率。既定値2（画面表示の等倍PDF座標に対して2倍精細） */
  scale?: number;
}

export interface PdfToImageOutputItem extends NamedFileOutput {
  pageNumber: number;
  width: number;
  height: number;
}

export class PdfToImageProcessor extends BrowserProcessor<
  PdfToImageInput,
  PdfToImageOutputItem[]
> {
  async process({ file, mimeType, scale = 2 }: PdfToImageInput): Promise<PdfToImageOutputItem[]> {
    const pdfjsLib = await getPdfjs();
    const bytes = await file.arrayBuffer();

    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (/password/i.test(message)) {
        throw new Error(
          "パスワード保護されたPDFは処理できません。パスワードを解除してから再度お試しください。"
        );
      }
      throw new Error(
        `${file.name} の読み込みに失敗しました。PDFファイルが破損している可能性があります。`
      );
    }

    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }

    const base = stripExtension(file.name);
    const pad = String(pdf.numPages).length;
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const outputs: PdfToImageOutputItem[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("Canvasの初期化に失敗しました");

        await page.render({ canvasContext, viewport }).promise;
        const blob = await canvasToBlob(canvas, mimeType, 0.92);

        outputs.push({
          blob,
          suggestedName: `${base}-${String(pageNumber).padStart(pad, "0")}.${ext}`,
          sizeBytes: blob.size,
          pageNumber,
          width: canvas.width,
          height: canvas.height,
        });
      }
    } catch {
      throw new Error("PDFのページ画像化に失敗しました");
    }

    return outputs;
  }
}
