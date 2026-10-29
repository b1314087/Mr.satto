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
import { OpenInPdfFixButton } from "@/components/tools/implementations/shared/open-in-pdf-fix-button";
import type { SharedPdfFileProps } from "@/components/tools/implementations/shared/pdf-file-props";
import { fileKey, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { usePdfPageCount } from "@/components/tools/implementations/shared/use-pdf-page-count";
import { PdfSplitProcessor, pdfOutputName } from "@/lib/processors/browser/pdf";
import { parsePageRanges, type PageRange } from "@/lib/pdf/page-selection";
import type { NamedFileOutput } from "@/lib/processors/types";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

type SplitMode = "each-page" | "range";

/** 分割の結果。複数ファイルのときは、ダウンロード用のZIPも実行時に作っておく */
interface SplitResult {
  outputs: NamedFileOutput[];
  zip: Blob | null;
}

const PREVIEW_MAX_PAGES = 40;

/** 実行時と同じ解釈(parsePageRanges)で、分割後の各ファイルのページ範囲を求める。入力途中の不正な値はエラー文にする */
function planSplit(
  mode: SplitMode,
  rangeText: string,
  totalPages: number
): { ranges: PageRange[]; error: string | null } {
  if (mode === "each-page") {
    return { ranges: Array.from({ length: totalPages }, (_, i) => ({ start: i + 1, end: i + 1 })), error: null };
  }
  if (rangeText.trim() === "") return { ranges: [], error: null };
  try {
    return { ranges: parsePageRanges(rangeText, totalPages), error: null };
  } catch (e) {
    return { ranges: [], error: e instanceof Error ? e.message : "ページ範囲を解釈できません" };
  }
}

function formatRange(r: PageRange): string {
  return r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`;
}

export function PdfSplitTool({ initialFile = null, onFileChange }: SharedPdfFileProps = {}) {
  const [file, setFile] = useState<File | null>(initialFile);
  const [mode, setMode] = useState<SplitMode>("each-page");
  const [rangeText, setRangeText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const { pageCount, loadError } = usePdfPageCount(file);

  // 結果は「どのファイル・どの分割方法の結果か」と一緒に持つ。いまの設定と違う古い結果は、表示もダウンロードもしない
  const settingKey = file ? `${fileKey(file)}|${mode}|${mode === "range" ? rangeText : ""}` : "";
  const run = useKeyedRun<SplitResult>(settingKey);
  const outputs = run.value?.outputs ?? null;
  const zipBlob = run.value?.zip ?? null;
  const error = loadError ?? run.error ?? inputError;
  const status: ProcessingState = loadError ? "error" : run.status;

  function selectFile(next: File | null) {
    setFile(next);
    onFileChange?.(next);
    setInputError(null);
    run.reset();
  }

  const plan = useMemo(
    () => (pageCount === null ? null : planSplit(mode, rangeText, pageCount)),
    [mode, rangeText, pageCount]
  );

  function handleRun() {
    if (!file || !pageCount) return;
    void run.run(async () => {
      const result =
        mode === "each-page"
          ? await new PdfSplitProcessor().process({ file, mode: "each-page" })
          : await new PdfSplitProcessor().process({
              file,
              mode: "range",
              ranges: parsePageRanges(rangeText, pageCount),
            });
      const zip = result.length > 1 ? await createZip(result.map((r) => ({ name: r.suggestedName, blob: r.blob }))) : null;
      return { outputs: result, zip };
    });
  }

  function handleDownload() {
    if (!outputs) return;
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].suggestedName);
    } else if (zipBlob && file) {
      downloadBlob(zipBlob, pdfOutputName(file.name, "split", "zip"));
    }
  }

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file && pageCount !== null && plan ? (
        <div data-testid="tool-preview" className="flex flex-col gap-2">
          <PdfThumbnails
            file={file}
            maxPages={PREVIEW_MAX_PAGES}
            width={96}
            title="分割位置のプレビュー"
            overlay={(page) => {
              const owners = plan.ranges.flatMap((r, i) => (page >= r.start && page <= r.end ? [i + 1] : []));
              const isCut = plan.ranges.some((r) => r.end === page);
              if (plan.ranges.length > 0 && owners.length === 0) {
                return (
                  <span className="absolute inset-0 flex items-center justify-center bg-white/75 text-[10px] font-medium text-neutral-500 dark:bg-neutral-900/75 dark:text-neutral-400">
                    出力されない
                  </span>
                );
              }
              if (owners.length === 0) return null;
              return (
                <>
                  <span className="absolute left-1 top-1 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {owners.length > 3 ? `${owners.slice(0, 3).join(",")}…` : owners.join(",")}
                  </span>
                  {isCut && <span aria-hidden className="absolute inset-y-0 right-0 border-r-2 border-dashed border-red-500" />}
                </>
              );
            }}
          />
          {plan.error ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{plan.error}</p>
          ) : mode === "range" && plan.ranges.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              ページ範囲を入力してください。
            </p>
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {plan.ranges.length}個のPDFに分割されます
              {mode === "range" && `（${plan.ranges.slice(0, 10).map(formatRange).join(" / ")}${plan.ranges.length > 10 ? " …" : ""}）`}
              。
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
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            このPDFは{pageCount}ページです
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("each-page")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                mode === "each-page"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              1ページごとに分割
            </button>
            <button
              type="button"
              onClick={() => setMode("range")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                mode === "range"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              ページ範囲を指定
            </button>
          </div>
          {mode === "range" && (
            <label className="flex flex-col gap-1 text-sm">
              ページ範囲（カンマ区切りで複数指定可）
              <input
                type="text"
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                placeholder="例: 1-3,5,8-10"
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}
        </div>
      )}

      {file && pageCount !== null && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          分割する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="分割が完了しました" />
      {error && <ErrorMessage message={error} />}

      {outputs && outputs.length > 0 && (
        <ResultPopup size="lg">
          <ul className="w-full text-xs text-neutral-600 dark:text-neutral-300">
            {outputs.slice(0, 20).map((o) => (
              <li key={o.suggestedName} className="flex justify-between gap-2 border-b border-neutral-200 py-1 last:border-none dark:border-neutral-800">
                <span className="truncate">{o.suggestedName}</span>
                <span className="shrink-0 text-neutral-400">{formatBytes(o.sizeBytes)}</span>
              </li>
            ))}
            {outputs.length > 20 && (
              <li className="py-1 text-neutral-400">他{outputs.length - 20}件…</li>
            )}
          </ul>
          <RewardedDownloadGate
            onDownload={handleDownload}
            disabled={outputs.length > 1 && !zipBlob}
            label={outputs.length === 1 ? "ダウンロード" : "ZIPでダウンロード"}
          />
          {/* 1つのPDFだけが出力された場合のみ、PDF修正へ引き継げる（複数ファイルの結果は引き継がない） */}
          {outputs.length === 1 && <OpenInPdfFixButton blob={outputs[0].blob} fileName={outputs[0].suggestedName} />}
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
