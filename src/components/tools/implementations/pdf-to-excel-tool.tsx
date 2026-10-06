"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import { PdfToExcelProcessor, previewPdfToExcelRows, type PdfToExcelOutput } from "@/lib/processors/browser/pdf-to-excel";
import { terminateOcrWorker } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

type TablePreview = { file: File; hasTextLayer: boolean; rows: string[][] } | { file: File; error: string };

/**
 * PDF→Excel（Phase 2-D）。
 *
 * 「どんなPDFでも完全にExcel化できる」ことは目的にせず、PDFに埋め込まれた
 * 文字の座標情報から表の行・列構造を推定してExcelのセルへ配置する
 * （src/lib/pdf/table-reconstruction.ts）。複雑な結合セル・複数の独立した表が
 * 混在するレイアウトなどは、実際の構造どおりに再現できない場合がある。
 *
 * スキャンした画像のPDF（文字情報のないページ）は、ブラウザ内のOCR(tesseract.js)で
 * 文字と座標を読み取ってから同じ表認識に渡す。OCRは誤読があり得るため、結果の
 * ダウンロード前に「内容を確認してください」と案内する。
 */
export function PdfToExcelTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfToExcelOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");

  // OCR用のWorker(WASM)はセッション中使い回すため、画面を離れるときに解放する
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  // ファイルを選んだ時点で、先頭ページから作られるExcelの表をプレビューする(変換と同じ表の推定)
  const [preview, setPreview] = useState<TablePreview | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    previewPdfToExcelRows(file)
      .then((o) => {
        if (!cancelled) setPreview({ file, hasTextLayer: o.hasTextLayer, rows: o.rows });
      })
      .catch((e) => {
        if (!cancelled) setPreview({ file, error: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);
  const currentPreview = file && preview && preview.file === file ? preview : null;

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
      const output = await new PdfToExcelProcessor().process({
        file,
        onPageProgress: (info) => {
          if (info.method === "ocr") {
            const pct = Math.round((info.ocrProgress ?? 0) * 100);
            setProgressLabel(
              `スキャン画像を文字認識中(OCR) ${info.currentPage} / ${info.totalPages} ページ（${pct}%）。初回は認識データの読み込みに時間がかかります`
            );
          } else {
            setProgressLabel(`ページを解析中 ${info.currentPage} / ${info.totalPages}`);
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

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          PDF内の文字の位置情報から表の行・列を推定し、Excelのセルに変換します。処理はブラウザ内で完結し、
          ファイルが外部のサーバーへ送信されることはありません。
        </p>
        <p>
          罫線・結合セルの再現も試みますが（PDFの見た目を解析した推定によるもので、常に完全に正確とは限りません）、
          複数の表が混在する複雑なレイアウトでは、正しく変換できない場合があります。
          どんなPDFでも完全にExcel化できるものではありません。
        </p>
        <p>
          スキャンした画像のPDF（文字情報のないページ）は、ブラウザ内の文字認識(OCR・日本語と英数字)で読み取ります。
          OCRは誤読が出ることがあるため、ダウンロード後は必ず内容を確認してください。スキャン画像は最大20ページまでで、
          罫線は再現されません。画像が鮮明で、傾きや影が少ないほど正確になります。
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
        <div data-testid="tool-preview" className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <PdfThumbnails file={file} pages={[1]} maxPages={1} width={160} title="先頭ページ(元のPDF)" className="sm:shrink-0" />
          <section
            aria-label="Excelの表のプレビュー"
            className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              Excelの表の先頭ページのプレビュー
            </p>
            {!currentPreview ? (
              <p className="text-xs text-neutral-400">読み込み中…</p>
            ) : "error" in currentPreview ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{currentPreview.error}</p>
            ) : currentPreview.hasTextLayer ? (
              currentPreview.rows.length > 0 ? (
                <CsvPreviewTable rows={currentPreview.rows} maxRows={10} maxCols={8} />
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400">先頭ページから表として認識できる内容が見つかりませんでした。</p>
              )
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                先頭ページに文字情報がないため(スキャン画像のPDFなど)、プレビューでは読み取りません。変換を実行すると画像認識で文字を読み取ります。
              </p>
            )}
          </section>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          Excelに変換する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progressLabel || "処理中..."}
        successLabel="Excelファイルの生成が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>検出ページ数: {result.pageCount}</span>
            <span>検出行数: {result.totalRowCount}</span>
            <span>ファイルサイズ: {(result.sizeBytes / 1024).toFixed(1)} KB</span>
          </div>

          {result.usedOcr && (
            <div className="flex items-start gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
              <span>
                スキャン画像のページ（
                {result.pages
                  .filter((p) => p.method === "ocr")
                  .map((p) => p.pageNumber)
                  .join(", ")}
                ページ目）はOCRで読み取りました
                {result.ocrAverageConfidence !== null && `（信頼度の目安 ${Math.round(result.ocrAverageConfidence)}%）`}
                。誤読や列のずれがあり得るため、ダウンロード後に内容をご確認ください。
              </span>
            </div>
          )}

          {result.pages.some((p) => p.rowCount === 0) && (
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
                表として認識できなかったページがあります（
                {result.pages
                  .filter((p) => p.rowCount === 0)
                  .map((p) => p.pageNumber)
                  .join(", ")}
                ページ目）。そのページの内容はExcelに含まれていません。
              </span>
            </div>
          )}

          {result.previewRows.length > 0 && (
            <div className="w-full overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
              <table className="min-w-full text-left text-xs text-neutral-700 dark:text-neutral-200">
                <tbody>
                  {result.previewRows.map((row, i) => (
                    <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      {row.map((cell, j) => (
                        <td key={j} className="whitespace-nowrap px-3 py-1.5">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.totalRowCount > result.previewRows.length && (
                <p className="px-3 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">
                  ほか {result.totalRowCount - result.previewRows.length} 行（プレビューは先頭
                  {result.previewRows.length}行のみ表示）
                </p>
              )}
            </div>
          )}

          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
