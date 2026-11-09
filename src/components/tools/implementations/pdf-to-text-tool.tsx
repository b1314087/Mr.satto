"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfToTextProcessor } from "@/lib/processors/browser/pdf-render";
import { OcrProcessor, OCR_METHOD_LABELS, type OcrOutput, type OcrPageMethod } from "@/lib/processors/browser/ocr";
import { terminateOcrWorker, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { usePremiumFeature } from "@/lib/plans/use-premium-feature";

/** 画面のプレビューで抽出するページ数・表示する文字数(重くならないよう先頭だけ) */
const PREVIEW_PAGES = 2;
const PREVIEW_CHARS = 600;

const LANGUAGE_OPTIONS: { value: OcrLanguageOption; label: string }[] = [
  { value: "ja+en", label: "日本語＋英語" },
  { value: "ja", label: "日本語のみ" },
  { value: "en", label: "英語のみ" },
];

function isPdfFile(f: File): boolean {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

type TextPreview =
  | { file: File; kind: "pdf"; text: string; hasText: boolean; pageCount: number }
  | { file: File; kind: "image"; url: string }
  | { file: File; error: string };

const METHOD_BADGE: Record<OcrPageMethod, string> = {
  "text-layer": "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200",
  ocr: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
  mixed: "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300",
  "needs-ocr": "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
};

/**
 * PDF→テキスト（OCR対応）。工程4で、PDF→テキスト（pdf-to-text）と OCR（ocr）を1つにまとめた画面。
 *
 * - PDFの文字情報のあるページは、OCRを使わずに取り出す（改行・段落を残す。だれでも使える）。
 * - 文字情報のないページ（スキャンした画像など）と、画像ファイルは、OCR（端末の中で動く Tesseract）で読み取る。
 * - 文字情報と画像が混在するページは、文字情報を取り出したうえで、画像の部分だけをOCRで読み取る。
 * - ページごとに、どの方法で読み取ったかを表示し、ダウンロードするテキストにもページの区切りを入れる。
 * - OCRはプレミアムプランの機能（旧OCRツールと同じ）。それ以外のプランでは、OCRが必要なページを
 *   「未読み取り」として示す（src/lib/plans/premium-feature.ts。課金がオフの間はだれでも使える）。
 * ファイルは常にブラウザ内で処理され、外部のサーバーには送信されない（OCRの言語データも、このサイトのものを使う）。
 */
export function PdfToTextTool() {
  // OCRは、もとはプレミアム限定のツール（旧OCR）の機能。元のツールと同じ条件で使える
  const premium = usePremiumFeature("premium-tool");
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<OcrLanguageOption>("ja+en");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OcrOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");
  const [copied, setCopied] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);
  const imageUrlRef = useRef<string | null>(null);

  // OCRの作業用スレッド（言語データを積んだもの）は、画面を離れるときに終了させる
  useEffect(() => {
    return () => {
      void terminateOcrWorker();
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  // ファイルを選んだ時点で、PDFは先頭ページだけ文字情報を取り出して見せる。画像は画像を見せる
  const [preview, setPreview] = useState<TextPreview | null>(null);
  useEffect(() => {
    if (!file) return;
    if (!isPdfFile(file)) {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      const url = URL.createObjectURL(file);
      imageUrlRef.current = url;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview({ file, kind: "image", url });
      return;
    }
    let cancelled = false;
    new PdfToTextProcessor()
      .process({ file, maxPages: PREVIEW_PAGES })
      .then((o) => {
        if (!cancelled) setPreview({ file, kind: "pdf", text: o.combinedText, hasText: o.hasExtractableText, pageCount: o.pageCount });
      })
      .catch((e) => {
        if (!cancelled) setPreview({ file, error: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);
  const currentPreview = file && preview && preview.file === file ? preview : null;
  const isImage = !!file && !isPdfFile(file);
  /** 画像ファイルはOCRでしか読めない。OCRを使えないプランでは、処理を始めない */
  const imageNeedsPremium = isImage && !premium.allowed;

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
      // OCR（プレミアムの機能）を使えるかは、処理の直前にサーバーでも確かめる
      const ocrAllowed = premium.allowed ? await premium.confirm() : false;
      if (isImage && !ocrAllowed) {
        throw new Error("画像からの文字の読み取り（OCR）は、プレミアムプランの機能です。");
      }
      const output = await new OcrProcessor().process({
        file,
        language,
        ocrAllowed,
        isCancelled: () => cancelRef.current,
        onPageProgress: (info) => {
          const percent = Math.round(info.pageProgress * 100);
          if (info.totalPages <= 1 && info.method !== "text-layer") {
            setProgressLabel(`OCRで読み取り中... ${percent}%`);
          } else if (info.method === "ocr" || info.method === "mixed") {
            setProgressLabel(`OCRで読み取り中 ${info.currentPage} / ${info.totalPages}ページ（このページ ${percent}%）`);
          } else {
            setProgressLabel(`文字情報を取り出し中 ${info.currentPage} / ${info.totalPages}ページ`);
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
    const blob = new Blob(["﻿" + result.combinedText], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${stripExtension(file.name)}.txt`);
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

  const counts = result
    ? (Object.keys(OCR_METHOD_LABELS) as OcrPageMethod[])
        .map((m) => ({ method: m, count: result.pages.filter((p) => p.method === m).length }))
        .filter((c) => c.count > 0)
    : [];
  const usedOcr = !!result && result.pages.some((p) => p.method === "ocr" || p.method === "mixed");
  const hasAnyText = !!result && result.pages.some((p) => p.text.trim().length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400" data-testid="pdf-text-ocr-guide">
        <p>
          文字情報のあるPDFのページは、そのまま文字を取り出します（OCRは使わないので高速で、文字も正確です）。
          スキャンした画像のページや画像ファイルは、OCRで文字を読み取ります。
        </p>
        {!premium.allowed && (
          <p className="text-amber-700 dark:text-amber-400" data-testid="pdf-text-ocr-premium-note">
            画像のページ・画像ファイルの文字の読み取り（OCR）は、プレミアムプランの機能です。文字情報のあるPDFのページは、このまま取り出せます。
            {" "}
            <Link href="/pricing" className="underline">料金プランを見る</Link>
          </p>
        )}
      </div>

      <FileDropzone
        accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        maxSizeMB={100}
        label="PDFまたは画像をドラッグ&ドロップ"
        hint="またはタップして選択（PDF / JPG / PNG / WebP）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && !result && (
        <PreviewFullscreenFrame>
          <section
            aria-label="読み取るファイルのプレビュー"
            data-testid="tool-preview"
            className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{isImage ? "読み取る画像" : "テキストのプレビュー"}</p>
            {!currentPreview ? (
              <p className="text-xs text-neutral-400">読み込み中…</p>
            ) : "error" in currentPreview ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{currentPreview.error}</p>
            ) : currentPreview.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentPreview.url}
                alt="読み取る画像"
                className="max-h-72 w-auto max-w-full self-start rounded-md border border-neutral-200 object-contain dark:border-neutral-700"
              />
            ) : currentPreview.hasText ? (
              <pre className="max-h-48 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
                {currentPreview.text.slice(0, PREVIEW_CHARS)}
                {currentPreview.text.length > PREVIEW_CHARS ? "\n…(続きは「テキストを抽出する」で全文を取得できます)" : ""}
              </pre>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="pdf-text-preview-no-text">
                先頭ページから取り出せる文字情報が見つかりませんでした。スキャンした画像のPDFの可能性があります
                {premium.allowed ? "（「テキストを抽出する」で、OCRで読み取ります）。" : "（OCRでの読み取りはプレミアムプランの機能です）。"}
              </p>
            )}
          </section>
        </PreviewFullscreenFrame>
      )}

      {file && premium.allowed && (
        <fieldset className="flex flex-col gap-2" data-testid="pdf-text-ocr-language">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">OCRの言語（画像のページを読み取るとき）</legend>
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
            disabled={status === "processing" || imageNeedsPremium}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            テキストを抽出する
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
            <span className="text-xs text-neutral-500 dark:text-neutral-400">現在のページの処理が終わり次第、中断します...</span>
          )}
          {imageNeedsPremium && (
            <span className="text-xs text-amber-700 dark:text-amber-400" data-testid="pdf-text-image-premium">
              画像ファイルはOCRでしか読み取れないため、プレミアムプランでご利用いただけます。
            </span>
          )}
        </div>
      )}

      <ProcessingStatus state={status} processingLabel={progressLabel || "処理中..."} successLabel="テキスト抽出が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup testId="tool-preview" size="lg">
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="pdf-text-summary">
            {counts.map((c) => (
              <span key={c.method} className={`rounded-full px-2 py-0.5 ${METHOD_BADGE[c.method]}`} data-testid={`pdf-text-count-${c.method}`}>
                {OCR_METHOD_LABELS[c.method]}：{result.isSingleImage ? "画像" : `${c.count}ページ`}
              </span>
            ))}
            {result.cancelled && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                中断されました（途中のページまでの結果です）
              </span>
            )}
          </div>

          {usedOcr && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="pdf-text-ocr-accuracy">
              OCRで読み取った部分は、画像の状態（解像度・傾き・かすれ・手書き）によって、読み間違いや読み落としが起こります。
              大切な書類は、元の書類と照らし合わせて確認してください（信頼度は目安です）。
            </p>
          )}
          {result.hasUnreadPages && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="pdf-text-unread-note">
              文字情報のないページ（スキャンした画像など）は、読み取っていません。OCRでの読み取りはプレミアムプランの機能です。
            </p>
          )}
          {!hasAnyText && !result.hasUnreadPages && (
            <p className="text-xs text-amber-700 dark:text-amber-400">文字は見つかりませんでした。</p>
          )}

          {result.pages.length > 1 && (
            <details className="w-full text-xs text-neutral-500 dark:text-neutral-400" data-testid="pdf-text-pages">
              <summary className="cursor-pointer select-none">ページごとの結果を見る</summary>
              <ul className="mt-2 flex flex-col gap-2">
                {result.pages.map((page) => (
                  <li
                    key={page.pageNumber}
                    data-testid={`pdf-text-page-${page.pageNumber}`}
                    data-method={page.method}
                    className="rounded-lg border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="font-medium text-neutral-600 dark:text-neutral-300">{page.pageNumber}ページ</span>
                      <span className={`rounded-full px-2 py-0.5 ${METHOD_BADGE[page.method]}`}>{OCR_METHOD_LABELS[page.method]}</span>
                      {page.confidence !== null && <span>OCRの信頼度の目安 {Math.round(page.confidence)}%</span>}
                    </div>
                    <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-200">
                      {page.text || (page.method === "needs-ocr" ? "（OCRが必要なページです）" : "（文字は見つかりませんでした）")}
                    </pre>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <pre
            data-testid="pdf-text-result"
            className="max-h-64 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
          >
            {result.combinedText || "（抽出されたテキストはありません）"}
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

          <RewardedDownloadGate onDownload={handleDownload} label="テキストをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
