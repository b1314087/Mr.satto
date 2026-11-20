"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ResultPopup } from "@/components/common/result-popup";
import { FilledPdfAiPanel, formAiEnabled } from "./filled-pdf-to-excel/ai-panel";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import {
  FilledPdfCancelledError,
  FilledPdfToExcelProcessor,
  LOW_CONFIDENCE_THRESHOLD,
  parsePageSelection,
  type FilledPdfToExcelOutput,
} from "@/lib/processors/browser/filled-pdf-to-excel";
import { withPdfDocument } from "@/lib/pdf/pdfjs-client";
import { terminateOcrWorker, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { useFilledPdfToExcelUsage, UsageGatePanel, describeConsumeFailure } from "./filled-pdf-to-excel/usage-gate";
import { FilledPdfToExcelTemplatePanel } from "./filled-pdf-to-excel-template-panel";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { RunBar } from "@/components/ui/run-bar";
import { PlanLimitHint, PlanLimitNotice, usePlanLimit } from "@/components/common/plan-limit";

const LANGUAGE_OPTIONS: { value: OcrLanguageOption; label: string }[] = [
  { value: "ja+en", label: "日本語＋英語" },
  { value: "ja", label: "日本語のみ" },
  { value: "en", label: "英語のみ" },
];


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
  // 2026-11-20：モードの切り替えをやめた。記入済みのPDFを入れると、その上で取り出す場所を囲める（囲まなければ、おまかせで整理）。
  // 空のひな形PDFを使う従来のやり方は、下のボタンから使える（上級者向け）
  const [blankTemplate, setBlankTemplate] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      {blankTemplate ? <FilledPdfToExcelTemplatePanel /> : <AutoExtractSection />}
      <button
        type="button"
        onClick={() => setBlankTemplate((v) => !v)}
        aria-pressed={blankTemplate}
        data-testid="filled-pdf-blank-template-toggle"
        className="w-fit text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        {blankTemplate ? "← 記入済みのPDFで指定する（ふつうのやり方）に戻る" : "空のひな形（テンプレート）PDFを使って場所を指定する（上級者向け）"}
      </button>
    </div>
  );
}

function AutoExtractSection() {
  const [files, setFiles] = useState<File[]>([]);
  const fileLimit = usePlanLimit("filled-pdf-to-excel");
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pageCountError, setPageCountError] = useState<string | null>(null);
  const [language, setLanguage] = useState<OcrLanguageOption>("ja+en");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FilledPdfToExcelOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  // 読み取るページ（ファイルが1つのとき。空欄ならすべて）
  const [pageText, setPageText] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [canceling, setCanceling] = useState(false);
  // 1つ目のPDFの上で囲んだ四角の数（0なら、おまかせで整理する）
  const [regionCount, setRegionCount] = useState(0);

  const { usage, usageLoading, adPhase, isAdBusy, needsAdBeforeRun, handleWatchAd, refreshUsage, consumeUsage } =
    useFilledPdfToExcelUsage();

  // OCR用Workerはページを離れる際に終了する（Phase 7の既存OCRツールと同じ後始末）。
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  function handleSelect(picked: File[]) {
    // 料金プランの上限（読み取るPDFの数）に収まる分だけを読み込む
    const selected = fileLimit.clamp(picked);
    setFiles(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setTotalPages(null);
    setPageCountError(null);
    setPageText("");
    setCancelled(false);

    if (selected.length === 0) return;

    (async () => {
      let sum = 0;
      try {
        for (const file of selected) {
          // ページ数を数えたら、すぐ閉じる（作業用スレッドを残さない。ロードマップC 工程2）
          sum += await withPdfDocument(file, async (pdf) => pdf.numPages);
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

  // 読み取るページの指定（ファイルが1つのときだけ）。指定が正しくないときは null
  const selectedPages = files.length === 1 && totalPages !== null && pageText.trim() ? parsePageSelection(pageText, totalPages) : null;
  const pageTextInvalid = files.length === 1 && pageText.trim() !== "" && selectedPages === null;
  const pagesToRead = selectedPages ? selectedPages.length : totalPages;
  const overPageLimit = pagesToRead !== null && usage?.maxPagesPerUse != null && pagesToRead > usage.maxPagesPerUse;

  async function handleRun() {
    if (files.length === 0 || totalPages === null || pagesToRead === null || pageTextInvalid) return;
    // 読み取るPDFのファイル数の上限は、処理の直前にサーバーでも今のプランを確かめる（ページ数の利用量は、下のサーバーの確認で数える）
    if (!(await fileLimit.confirmCount(files.length))) return;
    setError(null);

    // 利用量チェック（consumeUsage、サーバーアクション呼び出し）もtry/catchの
    // 対象に含める。ここが従来tryの外にあったため、一時的なネットワーク障害等で
    // 例外が発生すると、エラー表示も処理状態のリセットも行われないまま
    // 何も起きなかったように見えてしまっていた（テンプレートモード側の
    // handleRunExtractionと同じ形に揃える）。
    try {
      const consumeResult = await consumeUsage(pagesToRead);
      if (!consumeResult.allowed) {
        setError(describeConsumeFailure(consumeResult));
        return;
      }

      setStatus("processing");
      setResult(null);
      setCancelled(false);
      setProgressLabel("解析中...");
      const controller = new AbortController();
      abortRef.current = controller;

      const output = await new FilledPdfToExcelProcessor().process({
        files,
        language,
        maxTotalPages: consumeResult.maxPages ?? undefined,
        pageNumbers: selectedPages ?? undefined,
        signal: controller.signal,
        onPageProgress: (info) => {
          const label =
            info.fileCount > 1
              ? `${info.fileName}（${info.fileIndex + 1}/${info.fileCount}ファイル目） ${info.currentPage} / ${info.totalPagesInFile}ページ`
              : `ページを解析中 ${info.currentPage} / ${info.totalPagesInFile}`;
          const percent = info.method === "text-layer" ? "" : `（${Math.round(info.pageProgress * 100)}%）`;
          setProgressLabel(info.method === "ocr" ? `スキャンの文字を読み取り中: ${label}${percent}` : info.method === "mixed" ? `画像の部分の文字を読み取り中: ${label}${percent}` : label);
        },
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (e instanceof FilledPdfCancelledError) {
        setCancelled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      abortRef.current = null;
      setCanceling(false);
      setProgressLabel("");
      await refreshUsage();
    }
  }

  function handleDownload() {
    if (!result || files.length === 0) return;
    const baseName = files.length === 1 ? stripExtension(files[0].name) : "記入済みPDF一括Excel化";
    downloadBlob(result.blob, `${baseName}.xlsx`);
  }

  const canRun = files.length > 0 && totalPages !== null && !pageCountError && !overPageLimit && !needsAdBeforeRun && !pageTextInvalid;
  const lowSet = new Set(result?.previewLowCells ?? []);
  const METHOD_LABEL = { "text-layer": "PDFの文字情報", ocr: "スキャン（文字認識）", mixed: "文字情報＋画像の文字認識" } as const;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          {formAiEnabled()
            ? "通常の変換は、AIを使わず、この端末の中だけで処理します。"
            : "このツールでは、AIによる読み取り補助や外部のAIサービスは使いません。"}
          複雑なレイアウトや手書き文字は、正しく項目化できない場合があります。
          PDFを入れると1枚目が表示されるので、取り出したい記入欄を囲むと、全部のページの同じ場所を1件1行の一覧にします（1ページに何人分もある帳票は「人物を追加」で）。何も囲まなければ、おまかせで整理します。
        </p>
      </div>

      <FileDropzone
        compact={files.length > 0}
        compactAction="replace"
        accept="application/pdf,.pdf"
        multiple
        maxSizeMB={50}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択（複数ファイル可、上限50MB/ファイル）"
        onFilesSelected={handleSelect}
        onError={setError}
      />
      <PlanLimitHint state={fileLimit} />
      <PlanLimitNotice state={fileLimit} />

      {files.length > 0 && <FileList files={files} onRemove={handleRemove} />}
      {pageCountError && <ErrorMessage message={pageCountError} />}

      {files.length > 0 && !pageCountError && (
        <PreviewFullscreenFrame>
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              取り出す場所を囲む（任意）{files.length > 1 ? `・1つ目のPDF（1/${files.length}ファイル目）を表示しています` : ""}
            </p>
            <FilledPdfToExcelTemplatePanel source={{ files, language }} onFieldCountChange={setRegionCount} />
          </div>
        </PreviewFullscreenFrame>
      )}

      <UsageGatePanel usage={usage} usageLoading={usageLoading} totalPages={pagesToRead} adPhase={adPhase} isAdBusy={isAdBusy} onWatchAd={() => void handleWatchAd()} />

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

      {files.length === 1 && totalPages !== null && totalPages > 1 && (
        <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
          <span className="font-medium">読み取るページ（全{totalPages}ページ）</span>
          <input
            type="text"
            value={pageText}
            onChange={(e) => setPageText(e.target.value)}
            placeholder="空欄ならすべて（例：1-3, 5）"
            className="ms-input w-56"
            data-testid="filled-pdf-page-selection"
            aria-invalid={pageTextInvalid || undefined}
          />
          {pageTextInvalid ? (
            <span className="text-xs text-red-600">ページの指定が正しくありません（1〜{totalPages}の番号を「1-3, 5」のように入力してください）。</span>
          ) : (
            <span className="text-xs text-neutral-500">ページの多いスキャンは、必要なページだけを指定すると早く終わります。</span>
          )}
        </label>
      )}

      {files.length > 0 && regionCount > 0 && (
        <p data-testid="filled-pdf-region-note" className="text-sm text-neutral-600 dark:text-neutral-300">
          囲んだ場所で一覧にするときは、上の「指定した場所で一覧にする」を押してください。スキャンや手書きの書類は「指定した場所をAIで読み取る」を使うと、囲んだ場所だけをAIが読み取ります。囲んだ四角をすべて消すと、おまかせで整理できます。
        </p>
      )}
      {files.length > 0 && regionCount === 0 && (
        <RunBar>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={!canRun || status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            おまかせでExcelに変換する
          </button>
        </RunBar>
      )}
      {cancelled && (
        <p className="text-sm text-neutral-600 dark:text-neutral-300" data-testid="filled-pdf-cancelled">
          読み取りを中断しました。もう一度「おまかせでExcelに変換する」を押すと、最初から読み取ります。
        </p>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progressLabel || "処理中..."}
        successLabel="Excelファイルの生成が完了しました"
        // 処理中の画面に「中断する」を出す（ページ数の多いスキャンの読み取りを、途中で止められるように）
        onCancel={() => {
          setCanceling(true);
          abortRef.current?.abort();
        }}
        cancelLabel="中断する"
        canceling={canceling}
        cancelTestId="filled-pdf-cancel"
      />
      {error && <ErrorMessage message={error} />}

      {/* 場所を囲んだときは、ページ全体をAIに送るパネルは出さない（囲んだ場所だけを読む「指定した場所をAIで読み取る」を使う） */}
      {files.length > 0 && regionCount === 0 && formAiEnabled() && <FilledPdfAiPanel files={files} totalPages={totalPages} />}

      {result && (
        <ResultPopup size="lg">


          <ul className="flex flex-col gap-0.5 text-xs text-neutral-600 dark:text-neutral-300" data-testid="filled-pdf-page-methods">
            {result.pages.map((p) => (
              <li key={`${p.fileName}-${p.pageNumber}`} data-method={p.method}>
                {result.pages.some((q) => q.fileName !== p.fileName) ? `${p.fileName} ` : ""}
                {p.pageNumber}ページ目：{METHOD_LABEL[p.method]}
                {p.confidence !== null ? `・読み取りの信頼度 ${Math.round(p.confidence)}` : ""}
                {p.deskewDegrees ? `・傾き${Math.abs(p.deskewDegrees)}度を補正` : ""}
                ・{p.rowCount}行×{p.columnCount}列
              </li>
            ))}
          </ul>

          {result.lowConfidenceCells.length > 0 && (
            <div
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              data-testid="filled-pdf-low-confidence"
            >
              読み取りに自信のないセルが{result.lowConfidenceCells.length}か所あります（信頼度{LOW_CONFIDENCE_THRESHOLD}未満）。
              Excelでは<span className="rounded bg-[#FFF2A8] px-1 text-neutral-900">薄い黄色</span>で表示し、「読み取りの確認」シートに、ページ・セルの位置・読み取った文字をまとめています。元のPDFと見比べてご確認ください。
            </div>
          )}

          {result.pages.some((p) => p.rowCount === 0) && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <span>表として認識できないページがあります。文字がはっきり読み取れるスキャンかご確認ください。</span>
            </div>
          )}

          {result.previewRows.length > 0 && (
            <div className="w-full overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
              <table className="min-w-full text-left text-xs text-neutral-700 dark:text-neutral-200">
                <tbody>
                  {result.previewRows.map((row, i) => (
                    <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className={`whitespace-nowrap px-3 py-1.5 ${lowSet.has(`${i},${j}`) ? "bg-[#FFF2A8] text-neutral-900" : ""}`}
                          data-low={lowSet.has(`${i},${j}`) || undefined}
                          title={lowSet.has(`${i},${j}`) ? "読み取りに自信がありません。元のPDFでご確認ください" : undefined}
                        >
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
        </ResultPopup>
      )}
    </div>
  );
}
