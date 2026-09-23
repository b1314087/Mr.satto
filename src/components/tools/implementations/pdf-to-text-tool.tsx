"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfToTextProcessor, type PdfToTextOutput } from "@/lib/processors/browser/pdf-render";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

/**
 * PDF→テキスト。
 * 文字情報として埋め込まれたテキストの抽出のみを対象とし、
 * スキャン画像PDFのOCRは今回実装しない（開発指示書■10・■25）。
 * 抽出できるテキストが1文字もなかった場合は、エラーにはせず
 * その旨を案内する（正常に処理は完了しているため）。
 */
export function PdfToTextTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfToTextOutput | null>(null);

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
      const output = await new PdfToTextProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    const blob = new Blob(["﻿" + result.combinedText], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${stripExtension(file.name)}.txt`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={100}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
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
          テキストを抽出する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="テキスト抽出が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページから抽出しました
          </p>

          {!result.hasExtractableText && (
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
                このPDFには抽出可能な文字情報がない可能性があります。スキャンした画像のPDFの場合、文字情報を持たないため抽出できません（OCR機能は今回のバージョンでは未対応です）。
              </span>
            </div>
          )}

          <pre className="max-h-64 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
            {result.combinedText || "（抽出されたテキストはありません）"}
          </pre>

          <RewardedDownloadGate onDownload={handleDownload} label="テキストをダウンロード" />
        </div>
      )}
    </div>
  );
}
