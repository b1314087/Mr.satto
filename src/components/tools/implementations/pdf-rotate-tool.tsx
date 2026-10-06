"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { usePdfPageAspects } from "@/components/tools/implementations/shared/use-pdf-page-aspects";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfRotateProcessor } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const PREVIEW_MAX_PAGES = 40;

export function PdfRotateTool() {
  const [file, setFile] = useState<File | null>(null);
  const [rotateBy, setRotateBy] = useState<90 | 180 | 270>(90);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfProcessorOutput | null>(null);

  // Phase 7: 生成結果のObject URL(result.url)は画面上で使っていないが、
  // 解放しないとページを離れるまでメモリに残り続けるため、明示的に解放する。
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // 縦長ページを90°/270°回転すると枠の幅をはみ出すため、縦横比から縮小率を求めて枠に収める
  const aspects = usePdfPageAspects(file, PREVIEW_MAX_PAGES);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      // ページ指定は省略し、すべてのページを回転する
      // （実装の複雑さを避けるため、全ページ回転を優先する仕様）
      const output = await new PdfRotateProcessor().process({ file, rotateBy });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-rotated.pdf` : "rotated.pdf";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

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
    </div>
  );
}
