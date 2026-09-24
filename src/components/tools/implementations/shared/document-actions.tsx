"use client";

import { useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  DocumentPdfProcessor,
  buildDocumentFileName,
  type DocumentPdfOutput,
} from "@/lib/processors/browser/document-pdf";
import { validateDocumentForm } from "@/lib/documents/validation";
import { DOCUMENT_TYPE_META, type DocumentFormState } from "@/lib/documents/types";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/**
 * 帳票共通: PDF生成・ダウンロード・印刷導線。
 *
 * UI（本コンポーネント）はDocumentPdfProcessorのprocess()を呼び出すだけで、
 * PDF生成ロジック自体は持たない（開発指示書■8: UI/Processorの分離）。
 */
export function DocumentActions({ form }: { form: DocumentFormState }) {
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentPdfOutput | null>(null);
  const meta = DOCUMENT_TYPE_META[form.type];

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new DocumentPdfProcessor().process({ form });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの生成に失敗しました");
      setStatus("error");
    }
  }

  const preValidationError = validateDocumentForm(form);

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={handleGenerate}
        disabled={status === "processing"}
        title={preValidationError ?? undefined}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {status === "processing" ? "作成中..." : meta.actionLabel}
      </button>

      <ProcessingStatus state={status} processingLabel="PDFを作成中..." successLabel="PDFを作成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, buildDocumentFileName(form))}
            label="PDFをダウンロード"
          />
          <button
            type="button"
            onClick={() => window.open(result.url, "_blank", "noopener,noreferrer")}
            className="text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
          >
            新しいタブでPDFを開く（印刷はこちらから）
          </button>
        </div>
      )}
    </div>
  );
}
