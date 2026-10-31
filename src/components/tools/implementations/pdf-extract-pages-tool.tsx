"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import type { SharedPdfFileProps } from "@/components/tools/implementations/shared/pdf-file-props";
import { fileKey, revokeOutputUrl, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { usePdfPageCount } from "@/components/tools/implementations/shared/use-pdf-page-count";
import { PdfExtractPagesProcessor, pdfOutputName } from "@/lib/processors/browser/pdf";
import { parsePageSelection } from "@/lib/pdf/page-selection";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

const PREVIEW_MAX_PAGES = 40;

export function PdfExtractPagesTool({ initialFile = null, onFileChange }: SharedPdfFileProps = {}) {
  const [file, setFile] = useState<File | null>(initialFile);
  const [pageSelection, setPageSelection] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const { pageCount, loadError } = usePdfPageCount(file);

  // 結果は「どのファイル・どのページ指定の結果か」と一緒に持つ。いまの指定と違う古い結果は、表示もダウンロードもしない
  const settingKey = file ? `${fileKey(file)}|${pageSelection}` : "";
  const run = useKeyedRun<PdfProcessorOutput>(settingKey, { dispose: revokeOutputUrl });
  const result = run.value;
  const error = loadError ?? run.error ?? inputError;
  const status: ProcessingState = loadError ? "error" : run.status;

  function selectFile(next: File | null) {
    setFile(next);
    onFileChange?.(next);
    setInputError(null);
    run.reset();
  }

  // 実行時と同じ解釈(parsePageSelection)で、抽出されるページ(指定順)を求める
  const plan = useMemo(() => {
    if (pageCount === null || pageSelection.trim() === "") return { pages: [] as number[], error: null as string | null };
    try {
      return { pages: parsePageSelection(pageSelection, pageCount), error: null };
    } catch (e) {
      return { pages: [] as number[], error: e instanceof Error ? e.message : "ページ指定を解釈できません" };
    }
  }, [pageSelection, pageCount]);
  const outputPosition = useMemo(() => new Map(plan.pages.map((p, i) => [p, i + 1])), [plan.pages]);

  function handleRun() {
    if (!file) return;
    void run.run(() => new PdfExtractPagesProcessor().process({ file, pageSelection }));
  }

  const downloadName = file ? pdfOutputName(file.name, "extracted") : "extracted.pdf";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file && pageCount !== null ? (
        <div data-testid="tool-preview" className="flex flex-col gap-2">
          <PdfThumbnails
            file={file}
            maxPages={PREVIEW_MAX_PAGES}
            width={96}
            title="抽出のプレビュー"
            pageStyle={(page) => (plan.pages.length > 0 && !outputPosition.has(page) ? { opacity: 0.25 } : undefined)}
            overlay={(page) => {
              const position = outputPosition.get(page);
              if (position !== undefined) {
                return (
                  <>
                    <span aria-hidden className="absolute inset-0 border-2 border-blue-600" />
                    <span className="absolute left-1 top-1 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {position}番目
                    </span>
                  </>
                );
              }
              return plan.pages.length > 0 ? (
                <span className="absolute inset-0 flex items-center justify-center bg-white/50 text-[10px] font-medium text-neutral-500 dark:bg-neutral-900/50 dark:text-neutral-400">
                  抽出しない
                </span>
              ) : null;
            }}
          />
          {plan.error ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{plan.error}</p>
          ) : plan.pages.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              抽出するページを入力すると、抽出されるページが強調され、それ以外は薄く表示されます。
            </p>
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {plan.pages.length}ページを抽出します（出力順: {plan.pages.slice(0, 30).join(", ")}
              {plan.pages.length > 30 ? " …" : ""}）。
            </p>
          )}
        </div>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            PDFを選ぶと、ここにプレビューが表示されます
          </div>
        )
      }
    >
      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => selectFile(files[0])}
        onError={setInputError}
      />

      {file && <FileList files={[file]} onRemove={() => selectFile(null)} />}

      {file && pageCount !== null && (
        <label className="flex flex-col gap-1.5 text-sm">
          抽出するページ（全{pageCount}ページ）
          <input
            type="text"
            value={pageSelection}
            onChange={(e) => setPageSelection(e.target.value)}
            placeholder="例: 1,3,5-7"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">例: 1,3,5-7（指定した順番で出力されます）</span>
        </label>
      )}

      {file && pageCount !== null && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || pageSelection.trim() === ""} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          ページを抽出する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="抽出が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
