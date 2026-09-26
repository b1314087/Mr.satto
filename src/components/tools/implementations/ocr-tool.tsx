"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { OcrProcessor, type OcrOutput } from "@/lib/processors/browser/ocr";
import { terminateOcrWorker, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const LANGUAGE_OPTIONS: { value: OcrLanguageOption; label: string }[] = [
  { value: "ja+en", label: "日本語＋英語" },
  { value: "ja", label: "日本語のみ" },
  { value: "en", label: "英語のみ" },
];

/**
 * OCR（Phase 2-D）。
 *
 * PDF→テキスト（既存）とは対象が異なる：
 *   - PDF→テキスト … PDFに既に文字情報があるケース向け
 *   - OCR（本ツール）… 画像、または文字情報を持たないスキャンPDF向け
 * 内部でも1ページずつ「文字情報があるか」を判定し、ある場合はOCRを
 * 行わずそのまま抽出する（重複処理をしない）。
 *
 * ファイルは常にブラウザ内で処理され、外部のサーバーには送信されない
 * （BrowserProcessorとして実装しているため。理由は最終報告を参照）。
 */
export function OcrTool() {
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<OcrLanguageOption>("ja+en");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OcrOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);

  // Phase 7: OCR用Tesseract.js Workerは一度生成されるとページ内で使い回される
  // 設計だが、terminateOcrWorker()がこれまでどこからも呼ばれておらず、
  // OCRページを離れた後もWASM＋言語データを積んだWorkerがメモリに残り
  // 続けていた。ページを離れる（コンポーネントがunmountされる）タイミングで
  // 明示的に終了させる（OCRの認識ロジック自体は変更していない）。
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setCopied(false);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setCopied(false);
    setCancelRequested(false);
    cancelRef.current = false;
    setProgressLabel("準備中...");

    try {
      const output = await new OcrProcessor().process({
        file,
        language,
        isCancelled: () => cancelRef.current,
        onPageProgress: (info) => {
          const percent = Math.round(info.pageProgress * 100);
          if (info.totalPages <= 1) {
            setProgressLabel(`OCR処理中... ${percent}%`);
          } else if (info.method === "ocr") {
            setProgressLabel(
              `OCR処理中 ${info.currentPage} / ${info.totalPages}ページ（このページ ${percent}%）`
            );
          } else {
            setProgressLabel(`文字情報を抽出中 ${info.currentPage} / ${info.totalPages}ページ`);
          }
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

  function handleCancel() {
    cancelRef.current = true;
    setCancelRequested(true);
  }

  function handleDownload() {
    if (!file || !result) return;
    const blob = new Blob(["﻿" + result.combinedText], {
      type: "text/plain;charset=utf-8",
    });
    downloadBlob(blob, `${stripExtension(file.name)}-ocr.txt`);
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.combinedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("クリップボードへのコピーに失敗しました。テキストを選択してコピーしてください。");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          画像（JPG・PNG・WebP）またはPDFから文字を読み取ります。処理はすべてブラウザ内で行われ、
          ファイルが外部のサーバーへ送信されることはありません。
        </p>
        <p>
          画像の品質や文字の状態（かすれ・手書き・低解像度など）によって認識結果が異なる場合があります。完全に正確な文字起こしを保証するものではありません。
        </p>
        <p>
          すでに文字情報を持つPDF（コピー&ペーストできるPDF）をお持ちの場合は、
          <Link href="/tools/pdf-to-text" className="text-blue-600 underline dark:text-blue-400">
            PDF→テキスト
          </Link>
          の方が高速に処理できます。OCRはスキャンした画像・文字情報のないPDF向けです。
        </p>
      </div>

      <FileDropzone
        accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        maxSizeMB={50}
        label="画像またはPDFをドラッグ&ドロップ"
        hint="またはタップして選択（JPG / PNG / WebP / PDF、上限50MB）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            言語
          </legend>
          <div className="flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  language === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                <input
                  type="radio"
                  name="ocr-language"
                  value={opt.value}
                  checked={language === opt.value}
                  onChange={() => setLanguage(opt.value)}
                  className="sr-only"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {file && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            文字を読み取る
          </button>
          {status === "processing" && !cancelRequested && (
            <button
              type="button"
              onClick={handleCancel}
              className="w-fit rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-red-400 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              中断する
            </button>
          )}
          {cancelRequested && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              現在のページの処理が終わり次第、中断します...
            </span>
          )}
        </div>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progressLabel || "処理中..."}
        successLabel="文字の読み取りが完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            {result.cancelled && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                中断されました（途中のページまでの結果です）
              </span>
            )}
            <span>
              {result.isSingleImage
                ? "1枚の画像を処理しました"
                : `${result.pages.length}ページを処理しました`}
            </span>
          </div>

          {!result.isSingleImage && result.pages.length > 1 && (
            <details className="w-full text-xs text-neutral-500 dark:text-neutral-400">
              <summary className="cursor-pointer select-none">ページごとの結果を見る</summary>
              <ul className="mt-2 flex flex-col gap-2">
                {result.pages.map((page) => (
                  <li
                    key={page.pageNumber}
                    className="rounded-lg border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-medium text-neutral-600 dark:text-neutral-300">
                        Page {page.pageNumber}
                      </span>
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800">
                        {page.method === "ocr" ? "OCR" : "テキスト抽出"}
                      </span>
                      {page.confidence !== null && (
                        <span>信頼度目安 {Math.round(page.confidence)}%</span>
                      )}
                    </div>
                    <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-200">
                      {page.text || "（文字は検出されませんでした）"}
                    </pre>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <pre className="max-h-64 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
            {result.combinedText || "（文字は検出されませんでした）"}
          </pre>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              {copied ? "コピーしました" : "全文コピー"}
            </button>
          </div>

          <RewardedDownloadGate onDownload={handleDownload} label="TXTをダウンロード" />
        </div>
      )}
    </div>
  );
}
