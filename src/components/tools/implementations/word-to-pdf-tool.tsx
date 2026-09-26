"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { WordToPdfProcessor, type WordToPdfOutput } from "@/lib/processors/browser/word-to-pdf";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

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
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          Word文書（.docx）をPDFに変換します。段落・見出し・太字/斜体/下線・箇条書き・番号付きリスト・
          改ページ・表・画像・リンクを可能な範囲で反映しますが、元のWordと見た目が完全に一致することは
          保証しません。処理はブラウザ内で完結し、ファイルが外部のサーバーへ送信されることはありません。
        </p>
        <p>
          テキストボックス・SmartArt・WordArt・複雑な段組み・マクロ・高度なページレイアウトなどは
          再現できない場合があります。また、太字・斜体は専用の書体データを追加していないため、
          既存の日本語書体を加工した疑似的な表現になります。
        </p>
      </div>

      <FileDropzone
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        maxSizeMB={30}
        label="Word文書(.docx)をドラッグ&ドロップ"
        hint="またはタップして選択（上限30MB）"
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
          PDFに変換する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="変換中..." successLabel="PDFの生成が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>ページ数: {result.pageCount}</span>
            <span>段落数: {result.paragraphCount}</span>
            <span>表: {result.tableCount}個</span>
            <span>画像: {result.imageCount}個</span>
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
            <span>複雑なレイアウトは元のWordと完全に一致しない場合があります。生成後のPDFを開いて内容をご確認ください。</span>
          </div>

          {result.warnings.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {result.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
        </div>
      )}
    </div>
  );
}
