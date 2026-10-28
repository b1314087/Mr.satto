"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import {
  DEFAULT_PDF_TO_EXCEL_OPTIONS,
  PdfToExcelProcessor,
  previewPdfToExcelRows,
  type PdfToExcelLayoutNotes,
  type PdfToExcelOptions,
  type PdfToExcelOutput,
} from "@/lib/processors/browser/pdf-to-excel";
import { terminateOcrWorker } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

type TablePreview =
  | { file: File; hasTextLayer: boolean; rows: string[][]; layout: PdfToExcelLayoutNotes | null }
  | { file: File; error: string };

/** 整形の結果(または見つかった構造)を、利用者向けの短い文にする */
function describeLayout(layout: PdfToExcelLayoutNotes, options: PdfToExcelOptions): string[] {
  const notes: string[] = [];
  if (layout.sideBySideStackedPages > 0) {
    notes.push("左右に並んでいた同じ構成の表を、縦に1つの表へつなげました。");
  } else if (layout.sideBySideDetected && !options.stackSideBySide) {
    notes.push("左右に並んだ表を見つけました。右の「左右に並んだ表を縦につなげる」をオンにすると1つの表になります。");
  }
  if (layout.verticalLabels > 0) {
    notes.push(`縦書きの区分名など ${layout.verticalLabels} か所を、縦に結合した1つのセルにしました。`);
  }
  if (layout.headerRowsCollapsed > 0) {
    notes.push("複数行に割れていた見出しを1行にまとめました（太字で、スクロールしても固定表示されます）。");
  }
  if (layout.furnitureLinesRemoved > 0) {
    notes.push(`ページ番号・毎ページ繰り返されるヘッダー/フッター ${layout.furnitureLinesRemoved} 行を除きました。`);
  }
  return notes;
}

/** 変換後の表のプレビュー。数値が「223,…」のように省略されないよう、横にスクロールして全文を見せる */
function ScrollPreviewTable({ rows, maxRows }: { rows: string[][]; maxRows: number }) {
  const shown = rows.slice(0, maxRows);
  const colCount = Math.max(...shown.map((r) => r.length));
  return (
    <div className="flex flex-col gap-1">
      <div className="max-h-96 overflow-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full border-collapse text-xs">
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {Array.from({ length: colCount }).map((_, j) => (
                  <td
                    key={j}
                    className="whitespace-nowrap border border-neutral-200 px-2 py-1 text-neutral-700 dark:border-neutral-800 dark:text-neutral-200"
                  >
                    {row[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > maxRows && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">プレビューは先頭{maxRows}行のみ表示しています。</p>
      )}
    </div>
  );
}

function OptionCheckbox({
  checked,
  onChange,
  label,
  hint,
  testId,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
  testId: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
      <input
        type="checkbox"
        data-testid={testId}
        className="mt-1"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex flex-col">
        <span>{label}</span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>
      </span>
    </label>
  );
}

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
  const [options, setOptions] = useState<PdfToExcelOptions>(DEFAULT_PDF_TO_EXCEL_OPTIONS);

  // OCR用のWorker(WASM)はセッション中使い回すため、画面を離れるときに解放する
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  // ファイルを選んだ時点(と整形オプションを変えたとき)に、Excelになる表の先頭をプレビューする(変換と同じ表の推定・整形)
  const [preview, setPreview] = useState<TablePreview | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    previewPdfToExcelRows(file, options)
      .then((o) => {
        if (!cancelled) setPreview({ file, hasTextLayer: o.hasTextLayer, rows: o.rows, layout: o.layout });
      })
      .catch((e) => {
        if (!cancelled) setPreview({ file, error: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      });
    return () => {
      cancelled = true;
    };
  }, [file, options]);
  const currentPreview = file && preview && preview.file === file ? preview : null;

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function updateOption<K extends keyof PdfToExcelOptions>(key: K, value: PdfToExcelOptions[K]) {
    setOptions((prev) => ({ ...prev, [key]: value }));
    // オプションを変えたら、前の変換結果は古くなるので消す(もう一度変換してもらう)
    setResult(null);
    setStatus("idle");
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
        options,
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
      <p className="text-xs text-neutral-500 dark:text-neutral-400">文字の位置から表を推定します。複雑なレイアウトでは、正しく変換できない場合があります。</p>

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
                <>
                  <ScrollPreviewTable rows={currentPreview.rows} maxRows={14} />
                  {currentPreview.layout && describeLayout(currentPreview.layout, options).length > 0 && (
                    <ul
                      data-testid="layout-notes"
                      className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-emerald-700 dark:text-emerald-400"
                    >
                      {describeLayout(currentPreview.layout, options).map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </>
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
        <section
          aria-label="変換の設定"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変換の設定</p>
          {currentPreview && !("error" in currentPreview) && currentPreview.layout?.sideBySideDetected && (
            <OptionCheckbox
              testId="option-stack-side-by-side"
              checked={options.stackSideBySide}
              onChange={(v) => updateOption("stackSideBySide", v)}
              label="左右に並んだ表を縦につなげる"
              hint="同じ列構成の表が左右に並んでいる場合に、上から順に縦に1つの表へつなげます（並べ替え・集計がしやすくなります）。"
            />
          )}
          <OptionCheckbox
            testId="option-collapse-header"
            checked={options.collapseHeader}
            onChange={(v) => updateOption("collapseHeader", v)}
            label="複数行に割れた見出しを1行にまとめる"
            hint="見出しが何行にも分かれている表を、列ごとに1行の見出し（太字・固定表示）にします。"
          />
          <OptionCheckbox
            testId="option-remove-furniture"
            checked={options.removePageFurniture}
            onChange={(v) => updateOption("removePageFurniture", v)}
            label="ページ番号・毎ページのヘッダー/フッターを除く"
            hint="ページの上下の余白にある「38」「[令和8年勧告]」のような行を、表のデータに混ぜません。"
          />
          <OptionCheckbox
            testId="option-sheet-per-page"
            checked={options.sheetPerPage}
            onChange={(v) => updateOption("sheetPerPage", v)}
            label="ページごとに別のシートに分ける"
            hint="オフの場合は、全ページを1つのシートに続けて並べます。"
          />
        </section>
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
        <ResultPopup>
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>検出ページ数: {result.pageCount}</span>
            <span>検出行数: {result.totalRowCount}</span>
            <span>ファイルサイズ: {(result.sizeBytes / 1024).toFixed(1)} KB</span>
          </div>

          {describeLayout(result.layout, options).length > 0 && (
            <ul
              data-testid="result-layout-notes"
              className="flex list-disc flex-col gap-0.5 pl-5 text-xs text-emerald-700 dark:text-emerald-400"
            >
              {describeLayout(result.layout, options).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

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
        </ResultPopup>
      )}
    </div>
  );
}
