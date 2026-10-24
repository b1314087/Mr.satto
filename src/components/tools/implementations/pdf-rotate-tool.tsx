"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { usePdfPageAspects } from "@/components/tools/implementations/shared/use-pdf-page-aspects";
import { ProcessingStatus } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import type { SharedPdfFileProps } from "@/components/tools/implementations/shared/pdf-file-props";
import { fileKey, revokeOutputUrl, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { PdfRotateProcessor, pdfOutputName } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

const PREVIEW_MAX_PAGES = 40;

export function PdfRotateTool({ initialFile = null, onFileChange }: SharedPdfFileProps = {}) {
  const [file, setFile] = useState<File | null>(initialFile);
  const [rotateBy, setRotateBy] = useState<90 | 180 | 270>(90);
  const [inputError, setInputError] = useState<string | null>(null);

  // 結果は「どのファイル・どの角度の結果か」と一緒に持つ。いまの設定と違う古い結果は、表示もダウンロードもしない
  const settingKey = file ? `${fileKey(file)}|${rotateBy}` : "";
  const run = useKeyedRun<PdfProcessorOutput>(settingKey, { dispose: revokeOutputUrl });
  const result = run.value;
  const error = run.error ?? inputError;
  const status = run.status;

  function selectFile(next: File | null) {
    setFile(next);
    onFileChange?.(next);
    setInputError(null);
    run.reset();
  }

  // 縦長ページを90°/270°回転すると枠の幅をはみ出すため、縦横比から縮小率を求めて枠に収める
  const aspects = usePdfPageAspects(file, PREVIEW_MAX_PAGES);

  function handleRun() {
    if (!file) return;
    // ページ指定は省略し、すべてのページを回転する
    // （実装の複雑さを避けるため、全ページ回転を優先する仕様）
    void run.run(() => new PdfRotateProcessor().process({ file, rotateBy }));
  }

  const downloadName = file ? pdfOutputName(file.name, "rotated") : "rotated.pdf";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file ? (
        <div data-testid="tool-preview" className="flex flex-col gap-2">
          <PdfThumbnails
            file={file}
            maxPages={PREVIEW_MAX_PAGES}
            width={96}
            title={`${rotateBy}°回転後のプレビュー`}
            pageStyle={(page) => {
              const ratio = aspects[page];
              const sideways = rotateBy !== 180;
              const scale = sideways && ratio && ratio > 1 ? 1 / ratio : 1;
              return { transform: `rotate(${rotateBy}deg) scale(${scale})` };
            }}
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            すべてのページが時計回りに{rotateBy}°回転します（元の向きに追加で回転）。
          </p>
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

      {file && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            すべてのページを回転します
          </p>
          <div className="flex gap-2">
            {[90, 180, 270].map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => setRotateBy(deg as 90 | 180 | 270)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  rotateBy === deg
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {deg}°
              </button>
            ))}
          </div>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          回転する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="回転が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </PreviewSplitLayout>
  );
}
