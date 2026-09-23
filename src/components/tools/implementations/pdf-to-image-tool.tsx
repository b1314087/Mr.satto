"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfToImageProcessor, type PdfToImageOutputItem } from "@/lib/processors/browser/pdf-render";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

type OutputFormat = "image/png" | "image/jpeg";

const THUMBNAIL_LIMIT = 12;

export function PdfToImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<OutputFormat>("image/png");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<PdfToImageOutputItem[] | null>(null);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);
  const [thumbUrls, setThumbUrls] = useState<string[]>([]);

  useEffect(() => {
    return () => {
      thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // アンマウント時のみ解放すればよい（更新のたびの解放は下のhandleRunで行う）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setOutputs(null);
    setZipBlob(null);
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    setThumbUrls([]);
    try {
      const result = await new PdfToImageProcessor().process({ file, mimeType: format });
      setOutputs(result);
      setThumbUrls(
        result.slice(0, THUMBNAIL_LIMIT).map((item) => URL.createObjectURL(item.blob))
      );
      if (result.length > 1) {
        const zip = await createZip(result.map((r) => ({ name: r.suggestedName, blob: r.blob })));
        setZipBlob(zip);
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!outputs || !file) return;
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].suggestedName);
    } else if (zipBlob) {
      downloadBlob(zipBlob, `${stripExtension(file.name)}-images.zip`);
    }
  }

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
            出力する画像形式
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFormat("image/png")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                format === "image/png"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() => setFormat("image/jpeg")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                format === "image/jpeg"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              JPG
            </button>
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
          画像化する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="画像化が完了しました" />
      {error && <ErrorMessage message={error} />}

      {outputs && outputs.length > 0 && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {thumbUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt={`${i + 1}ページ目のプレビュー`}
                className="aspect-[3/4] w-full rounded-md border border-neutral-200 object-cover dark:border-neutral-700"
              />
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {outputs.length}ページを画像化しました
            {outputs.length > THUMBNAIL_LIMIT && `（プレビューは先頭${THUMBNAIL_LIMIT}件のみ表示）`}
          </p>
          <RewardedDownloadGate
            onDownload={handleDownload}
            disabled={outputs.length > 1 && !zipBlob}
            label={outputs.length === 1 ? "ダウンロード" : "ZIPでダウンロード"}
          />
        </div>
      )}
    </div>
  );
}
