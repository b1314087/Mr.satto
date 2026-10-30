"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { ParagraphList } from "@/components/tools/implementations/shared/paragraph-compare";
import { PreviewColumn, PreviewNotice, PreviewShell } from "@/components/tools/implementations/shared/before-after-table";
import { extractBodyTexts } from "@/components/tools/implementations/shared/docx-preview";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { loadDocxPackage } from "@/lib/word/docx-text-ops";
import { WordToPdfProcessor, type WordToPdfOutput } from "@/lib/processors/browser/word-to-pdf";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

async function loadDocxBodyTexts(file: File): Promise<string[]> {
  const pkg = await loadDocxPackage(file);
  return extractBodyTexts(pkg.documentXmlText);
}

/**
 * Word（DOCX）→ PDF（Phase 9）。
 *
 * 「Wordと見た目が完全に一致すること」は目的にせず、段落・見出し・太字/斜体/
 * 下線・箇条書き・番号付きリスト・改ページ・表・画像・リンクといった基本要素を
 * 実用的な精度でPDF化することを目的にしている。
 */
export function WordToPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WordToPdfOutput | null>(null);

  // プレビュー: 変換前は文書の本文(段落・表)のテキスト、変換後は生成したPDFの1ページ目を表示する
  const { data: bodyTexts, error: previewError, loading } = useAsyncFileData(file, loadDocxBodyTexts);
  const resultPdf = useMemo(
    () => (result ? new File([result.blob], "converted-preview.pdf", { type: "application/pdf" }) : null),
    [result]
  );
  const paragraphItems = useMemo(
    () => (bodyTexts ?? []).filter((t) => t.trim() !== "").map((text) => ({ text })),
    [bodyTexts]
  );

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);

    try {
      const output = await new WordToPdfProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.pdf`);
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">複雑なレイアウトは、元のWordと一致しない場合があります。</p>

      <FileDropzone
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        maxSizeMB={30}
        label="Word文書(.docx)をドラッグ&ドロップ"
        hint="またはタップして選択（上限30MB）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (bodyTexts || previewError || loading || resultPdf) && (
        <PreviewShell
          title="変換内容のプレビュー"
          loading={loading}
          notes={[
            "変換前は文書内のテキストを表示しています(書式・画像は反映されません)。変換後のPDFの見た目は、変換したあとに1ページ目の画像で確認できます。",
          ]}
        >
          {previewError && <PreviewNotice message={previewError} />}
          {bodyTexts && (
            <PreviewColumn label="Word文書の本文(先頭の段落・表)">
              <ParagraphList items={paragraphItems} maxItems={20} label="Word文書の本文" />
            </PreviewColumn>
          )}
          {resultPdf && <PdfThumbnails file={resultPdf} maxPages={1} width={260} title="変換後PDFの1ページ目" />}
        </PreviewShell>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          PDFに変換する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="変換中..." successLabel="PDFの生成が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          {result.warnings.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {result.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
