"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfToWordProcessor, type PdfToWordOutput } from "@/lib/processors/browser/pdf-to-word";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

/**
 * PDF→Word（Phase 2-D）。
 *
 * 「PDFの見た目を100%再現すること」ではなく「編集しやすいWord文書に
 * 変換すること」を目的にしている（開発指示書の優先順位に明記）。
 * 2段組・特殊フォント・画像などを含む複雑なレイアウトは、そのままの
 * 見た目では再現されない場合がある旨をUIで明示する。
 */
export function PdfToWordTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfToWordOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");

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
    setProgressLabel("解析中...");

    try {
      const output = await new PdfToWordProcessor().process({
        file,
        onPageProgress: (info) => {
          setProgressLabel(`ページを解析中 ${info.currentPage} / ${info.totalPages}`);
        },
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    } finally {
      setProgressLabel("");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.docx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          PDF内の文字を編集可能なWord文書（.docx）に変換します。段落構造・見出し・簡単な表は
          できる範囲で維持しますが、PDFの見た目をそのまま100%再現することは目的にしていません。
          処理はブラウザ内で完結し、ファイルが外部のサーバーへ送信されることはありません。
        </p>
        <p>
          2段組・ヘッダーやフッター・特殊なフォント・画像を含む複雑なレイアウトは、
          元のPDFどおりに再現されない場合があります（画像の埋め込みは今回のバージョンでは未対応です）。
          まずは「文字が編集できる状態にすること」を優先しています。
        </p>
      </div>

      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={50}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択（上限50MB）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          Wordに変換する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progressLabel || "処理中..."}
        successLabel="Word文書の生成が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>ページ数: {result.pageCount}</span>
            <span>段落数: {result.paragraphCount}</span>
            <span>見出し数: {result.headingCount}</span>
            <span>表: {result.tableCount}個</span>
            <span>ファイルサイズ: {(result.sizeBytes / 1024).toFixed(1)} KB</span>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <span>
              複雑なレイアウト（2段組・表の結合セル・特殊なフォント等）は元のPDFどおりに
              再現されていない場合があります。生成後の文書はWordで開いて内容をご確認ください。
            </span>
          </div>

          <RewardedDownloadGate onDownload={handleDownload} label="Word文書をダウンロード" />
        </div>
      )}
    </div>
  );
}
