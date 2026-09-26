"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { AdSlot } from "@/components/ads/ad-slot";
import { FilledPdfToExcelProcessor, type FilledPdfToExcelOutput } from "@/lib/processors/browser/filled-pdf-to-excel";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import { terminateOcrWorker, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { getRewardedAdService, type RewardedAdState } from "@/lib/ads/reward-provider";
import { grantPageCredit } from "@/lib/tools/filled-pdf-to-excel/credit-actions";
import {
  getFilledPdfToExcelUsageStatus,
  consumeFilledPdfToExcelUsage,
  type FilledPdfToExcelUsageStatus,
} from "@/lib/tools/filled-pdf-to-excel/usage-status-actions";

const LANGUAGE_OPTIONS: { value: OcrLanguageOption; label: string }[] = [
  { value: "ja+en", label: "日本語＋英語" },
  { value: "ja", label: "日本語のみ" },
  { value: "en", label: "英語のみ" },
];

type AdPhase = "idle" | "loading" | "ready" | "showing" | "granting" | "unavailable" | "denied" | "error";

const AD_PHASE_LABEL: Partial<Record<AdPhase, string>> = {
  loading: "広告を準備しています...",
  ready: "広告を準備しています...",
  showing: "広告を表示しています...",
  granting: "視聴が完了しました。準備しています...",
};

/**
 * 記入済みPDF→Excel（Phase 11 ツール①）。
 *
 * 既存の「PDF→Excel」はテキストレイヤーのある(コピー&ペーストできる)PDFのみ
 * 対応するが、このツールはスキャンした記入済み申請書・帳票の画像PDFにも
 * OCR（tesseract.js、日本語データ組み込み済み）で対応する。
 *
 * 利用制限（Free/Standard/Premium）は既存の汎用<ToolAccessGate>（Standard対象
 * ツール全体・15分間の広告ゲート）とは条件が異なる専用の仕組みのため、
 * このツールのServer Actions（usage-status-actions.ts）を直接呼び出して
 * 判定する（src/app/tools/[tool]/page.tsxはこのツールIDのみゲートをバイパスする）。
 *
 * ファイル・OCR結果・生成したExcelは、いずれもMr.Sattoのサーバーへ
 * アップロード・保存されません。処理はすべてブラウザ内で完結します。
 */
export function FilledPdfToExcelTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [pageCountError, setPageCountError] = useState<string | null>(null);
  const [language, setLanguage] = useState<OcrLanguageOption>("ja+en");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FilledPdfToExcelOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");

  const [usage, setUsage] = useState<FilledPdfToExcelUsageStatus | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [adPhase, setAdPhase] = useState<AdPhase>("idle");
  const adRequestInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getFilledPdfToExcelUsageStatus()
      .then((s) => {
        if (!cancelled) setUsage(s);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // OCR用Workerはページを離れる際に終了する（Phase 7の既存OCRツールと同じ後始末）。
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
    };
  }, []);

  async function refreshUsage() {
    const s = await getFilledPdfToExcelUsageStatus();
    setUsage(s);
    return s;
  }

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

  async function handleWatchAd() {
    if (adRequestInFlight.current) return;
    adRequestInFlight.current = true;
    setAdPhase("loading");

    try {
      const result = await getRewardedAdService().watchAd({
        toolId: "filled-pdf-to-excel",
        onStateChange: (state: RewardedAdState) => {
          switch (state.status) {
            case "loading":
              setAdPhase("loading");
              break;
            case "ready":
              setAdPhase("ready");
              break;
            case "showing":
              setAdPhase("showing");
              break;
            case "rewarded":
              setAdPhase("granting");
              break;
            case "unavailable":
              setAdPhase("unavailable");
              break;
            case "error":
              setAdPhase("error");
              break;
            case "closed":
              break;
          }
        },
      });

      if (result === "granted") {
        setAdPhase("granting");
        try {
          // 正式なreward event受信後にのみ、サーバー側でこのツール専用の
          // 署名付きpage creditトークンを発行してもらう（広告を見る前に
          // 処理を始めない、というPhase 11開発指示書6章の方針に対応）。
          await grantPageCredit();
        } catch {
          setAdPhase("error");
          return;
        }
        await refreshUsage();
        setAdPhase("idle");
        return;
      }

      setAdPhase(result === "unavailable" ? "unavailable" : "denied");
    } catch {
      setAdPhase("error");
    } finally {
      adRequestInFlight.current = false;
    }
  }

  const isAdBusy = adPhase === "loading" || adPhase === "ready" || adPhase === "showing" || adPhase === "granting";
  const needsAdBeforeRun = !usageLoading && usage !== null && usage.requiresAd;
  const overPageLimit =
    totalPages !== null && usage?.maxPagesPerUse != null && totalPages > usage.maxPagesPerUse;

  async function handleRun() {
    if (files.length === 0 || totalPages === null) return;
    setError(null);

    const consumeResult = await consumeFilledPdfToExcelUsage(totalPages);
    if (!consumeResult.allowed) {
      if (consumeResult.reason === "page-limit-exceeded") {
        setError(
          `現在の利用条件で処理できるページ数の上限は合計${consumeResult.maxPages}ページです（選択したファイルの合計は${totalPages}ページです）。`
        );
      } else {
        setError("広告の視聴が必要です。下の「広告を見て利用する」ボタンからお試しください。");
      }
      await refreshUsage();
      return;
    }

    setStatus("processing");
    setResult(null);
    setProgressLabel("解析中...");

    try {
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

      {files.length > 0 && totalPages !== null && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          合計ページ数: {totalPages}ページ
          {usage?.maxPagesPerUse != null && `（今回処理できる上限: ${usage.maxPagesPerUse}ページ）`}
        </p>
      )}

      {overPageLimit && (
        <ErrorMessage
          message={`現在の利用条件で処理できるページ数の上限は合計${usage?.maxPagesPerUse}ページです（選択したファイルの合計は${totalPages}ページです）。ファイルを減らすか、プランをご確認ください。`}
        />
      )}

      {!usageLoading && usage && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          {usage.plan === "premium" && <p>Premiumプランのため、ページ数・回数の制限なくご利用いただけます。</p>}
          {usage.plan === "standard" && usage.dailyUsed !== null && usage.dailyLimit !== null && (
            <p>
              Standardプラン: 本日は{usage.dailyLimit}回中 {usage.dailyUsed}回 利用済みです（1回あたり最大
              {usage.maxPagesPerUse}ページ）。
              {usage.dailyUsed >= usage.dailyLimit &&
                "本日の無償回数を使い切ったため、広告の視聴で引き続きご利用いただけます。"}
            </p>
          )}
          {usage.plan === "free" && <p>無料プランでは、広告を見ると1回・最大{usage.maxPagesPerUse}ページまで処理できます。</p>}
          {usage.creditActive && <p className="text-green-700 dark:text-green-400">広告視聴による利用権が有効です。</p>}
        </div>
      )}

      {needsAdBeforeRun && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <AdSlot placement="tool-page" />
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {usage?.plan === "standard"
              ? "本日の無償回数を使い切りました。広告を見ると、最大3ページまで引き続き処理できます。"
              : "無料で使うには広告をご覧ください。広告を見ると1回・最大3ページまで処理できます。"}
          </p>
          <button
            type="button"
            disabled={isAdBusy}
            onClick={() => void handleWatchAd()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isAdBusy ? (AD_PHASE_LABEL[adPhase] ?? "広告を見て利用する") : "広告を見て利用する"}
          </button>
          {adPhase === "unavailable" && (
            <p className="text-xs text-red-600 dark:text-red-400">
              現在、広告を表示できません。しばらくしてからもう一度お試しください。Standard・Premiumプランでは広告なしでご利用いただけます。
            </p>
          )}
          {adPhase === "denied" && (
            <p className="text-xs text-red-600 dark:text-red-400">
              広告の視聴が完了しなかったため、利用権は付与されませんでした。もう一度お試しください。
            </p>
          )}
          {adPhase === "error" && (
            <p className="text-xs text-red-600 dark:text-red-400">エラーが発生しました。しばらくしてからもう一度お試しください。</p>
          )}
          <Link
            href="/pricing"
            className="text-xs text-neutral-400 underline-offset-2 hover:text-blue-600 hover:underline dark:text-neutral-500 dark:hover:text-blue-400"
          >
            広告なしで使いたい場合はこちら（料金プラン）
          </Link>
        </div>
      )}

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
