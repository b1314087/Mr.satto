"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { FilledPdfToExcelProcessor, type FilledPdfToExcelOutput } from "@/lib/processors/browser/filled-pdf-to-excel";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import { terminateOcrWorker, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { useFilledPdfToExcelUsage, UsageGatePanel, describeConsumeFailure } from "./filled-pdf-to-excel/usage-gate";
import { FilledPdfToExcelTemplatePanel } from "./filled-pdf-to-excel-template-panel";

const LANGUAGE_OPTIONS: { value: OcrLanguageOption; label: string }[] = [
  { value: "ja+en", label: "日本語＋英語" },
  { value: "ja", label: "日本語のみ" },
  { value: "en", label: "英語のみ" },
];

type ToolModeSelect = "auto" | "template";

/**
 * 記入済みPDF→Excel（Phase 11 ツール①、Phase 18でテンプレートモードを追加）。
 *
 * 既存の自動抽出モード（PDF全体をテキストレイヤー/OCR+座標ベースの表推定で
 * Excel化する）はそのまま維持し、モード選択で切り替える形で「テンプレート
 * モード」（あらかじめ登録した入力枠の位置に基づき、人ごと・項目ごとに
 * 正確な値を取り出す）を追加した（開発指示書1章：新しいツールの追加では
 * なく、既存ツールへのモード追加として実装）。
 *
 * 利用制限（Free/Standard/Premium）はどちらのモードも同じ専用の仕組み
 * （usage-gate.tsx経由でこのツール専用のServer Actionsを呼び出す）を使う。
 * ファイル・OCR結果・生成したExcelは、いずれもMr.Sattoのサーバーへ
 * アップロード・保存されません。処理はすべてブラウザ内で完結します。
 */
export function FilledPdfToExcelTool() {
  const [mode, setMode] = useState<ToolModeSelect>("auto");

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">記入されたPDF → Excel</legend>
        <div className="flex flex-col gap-2 sm:flex-row">
          <ModeOption
            active={mode === "auto"}
            title="自動抽出"
            description="PDFの内容を自動解析してExcel化"
            onClick={() => setMode("auto")}
          />
          <ModeOption
            active={mode === "template"}
            title="テンプレート"
            description="空の帳票テンプレートを指定し、決めた入力枠から情報を取得してExcel化"
            onClick={() => setMode("template")}
          />
        </div>
      </fieldset>

      {mode === "auto" ? <AutoExtractSection /> : <FilledPdfToExcelTemplatePanel />}
    </div>
  );
}

function ModeOption({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-lg border px-4 py-3 text-left transition-colors ${
        active
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
          : "border-neutral-300 hover:border-blue-400 dark:border-neutral-700"
      }`}
    >
      <p className={`text-sm font-semibold ${active ? "text-blue-700 dark:text-blue-300" : "text-neutral-700 dark:text-neutral-200"}`}>
        {title}
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
    </button>
  );
}

function AutoExtractSection() {
  const [files, setFiles] = useState<File[]>([]);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pageCountError, setPageCountError] = useState<string | null>(null);
  const [language, setLanguage] = useState<OcrLanguageOption>("ja+en");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FilledPdfToExcelOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");

  const { usage, usageLoading, adPhase, isAdBusy, needsAdBeforeRun, handleWatchAd, refreshUsage, consumeUsage } =
    useFilledPdfToExcelUsage();

  // OCR用Workerはページを離れる際に終了する（Phase 7の既存OCRツールと同じ後始末）。
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  function handleSelect(selected: File[]) {
    setFiles(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setTotalPages(null);
    setPageCountError(null);

    if (selected.length === 0) return;

    (async () => {
      let sum = 0;
      try {
        for (const file of selected) {
          const pdf = await loadPdfDocument(file);
          sum += pdf.numPages;
        }
        setTotalPages(sum);
      } catch (e) {
        setPageCountError(e instanceof Error ? e.message : "PDFのページ数を確認できませんでした");
      }
    })();
  }

  function handleRemove(index: number) {
    const next = files.filter((_, i) => i !== index);
    handleSelect(next);
  }

  const overPageLimit = totalPages !== null && usage?.maxPagesPerUse != null && totalPages > usage.maxPagesPerUse;

  async function handleRun() {
    if (files.length === 0 || totalPages === null) return;
    setError(null);

    // 利用量チェック（consumeUsage、サーバーアクション呼び出し）もtry/catchの
    // 対象に含める。ここが従来tryの外にあったため、一時的なネットワーク障害等で
    // 例外が発生すると、エラー表示も処理状態のリセットも行われないまま
    // 何も起きなかったように見えてしまっていた（テンプレートモード側の
    // handleRunExtractionと同じ形に揃える）。
    try {
      const consumeResult = await consumeUsage(totalPages);
      if (!consumeResult.allowed) {
        setError(describeConsumeFailure(consumeResult));
        return;
      }

      setStatus("processing");
      setResult(null);
      setProgressLabel("解析中...");

      const output = await new FilledPdfToExcelProcessor().process({
        files,
        language,
        maxTotalPages: consumeResult.maxPages ?? undefined,
        onPageProgress: (info) => {
          const label =
            info.fileCount > 1
              ? `${info.fileName}（${info.fileIndex + 1}/${info.fileCount}ファイル目） ${info.currentPage} / ${info.totalPagesInFile}ページ`
              : `ページを解析中 ${info.currentPage} / ${info.totalPagesInFile}`;
          setProgressLabel(info.method === "ocr" ? `OCR処理中: ${label}` : label);
        },
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    } finally {
      setProgressLabel("");
      await refreshUsage();
    }
  }

  function handleDownload() {
    if (!result || files.length === 0) return;
    const baseName = files.length === 1 ? stripExtension(files[0].name) : "記入済みPDF一括Excel化";
    downloadBlob(result.blob, `${baseName}.xlsx`);
  }

  const canRun = files.length > 0 && totalPages !== null && !pageCountError && !overPageLimit && !needsAdBeforeRun;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          記入済みの申請書・帳票のPDF（コピー&ペーストできるPDF、スキャンした画像のPDFのどちらにも対応）を、
          項目ごとに整理してExcelファイルに変換します。処理はすべてブラウザ内で行われ、
          アップロードしたPDFやOCRの読み取り結果、生成したExcelファイルがMr.Sattoのサーバーへ保存されることはありません。
        </p>
        <p>
          座標をもとにした決定的な処理で表・項目を再構成しており、AIによる曖昧な判断は行っていません。
          複雑なレイアウトや手書き文字の状態によっては、正しく項目化できない場合があります。
          複数人分の情報が1ページに入っている帳票を、決まった位置から正確に取り出したい場合は、上の「テンプレート」モードもお試しください。
        </p>
      </div>

      <FileDropzone
        accept="application/pdf,.pdf"
        multiple
        maxSizeMB={50}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択（複数ファイル可、上限50MB/ファイル）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {files.length > 0 && <FileList files={files} onRemove={handleRemove} />}
      {pageCountError && <ErrorMessage message={pageCountError} />}

      <UsageGatePanel usage={usage} usageLoading={usageLoading} totalPages={totalPages} adPhase={adPhase} isAdBusy={isAdBusy} onWatchAd={() => void handleWatchAd()} />

      {files.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">言語（OCR実行時のみ使用）</legend>
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
                  name="filled-pdf-to-excel-language"
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

      {files.length > 0 && (
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={!canRun || status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          Excelに変換する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel={progressLabel || "処理中..."} successLabel="Excelファイルの生成が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>合計ページ数: {result.pageCount}</span>
            <span>検出行数: {result.totalRowCount}</span>
            <span>ファイルサイズ: {(result.sizeBytes / 1024).toFixed(1)} KB</span>
            {result.usedOcr && <span>OCRを使用しました</span>}
          </div>

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            処理が完了しました。アップロードしたPDF・読み取り結果・生成したExcelファイルは、Mr.Sattoのサーバーへ保存されません。
          </p>

          {result.pages.some((p) => p.rowCount === 0) && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <span>
                表として認識できなかったページがあります。文字がはっきり読み取れるスキャン画像かご確認ください。
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

          <button
            type="button"
            onClick={handleDownload}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Excelファイルをダウンロード
          </button>
        </div>
      )}
    </div>
  );
}
