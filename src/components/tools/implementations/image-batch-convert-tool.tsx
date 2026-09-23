"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageConvertProcessor } from "@/lib/processors/browser/image";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

type TargetFormat = "image/jpeg" | "image/png" | "image/webp";

const FORMAT_OPTIONS: { value: TargetFormat; label: string; ext: string }[] = [
  { value: "image/jpeg", label: "JPG", ext: "jpg" },
  { value: "image/png", label: "PNG", ext: "png" },
  { value: "image/webp", label: "WebP", ext: "webp" },
];

export function ImageBatchConvertTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [targetFormat, setTargetFormat] = useState<TargetFormat>("image/jpeg");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultLabel, setResultLabel] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("images.zip");

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResultBlob(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRun() {
    if (files.length === 0) return;
    setStatus("processing");
    setError(null);
    setResultBlob(null);
    try {
      const ext = FORMAT_OPTIONS.find((f) => f.value === targetFormat)?.ext ?? "jpg";
      const usedNames = new Map<string, number>();
      const converted: { name: string; blob: Blob }[] = [];

      for (const file of files) {
        const output = await new ImageConvertProcessor().process({
          file,
          mimeType: targetFormat,
        });
        const base = stripExtension(file.name);
        const count = usedNames.get(base) ?? 0;
        usedNames.set(base, count + 1);
        const name = count === 0 ? `${base}.${ext}` : `${base}-${count + 1}.${ext}`;
        converted.push({ name, blob: output.blob });
      }

      if (converted.length === 1) {
        setResultBlob(converted[0].blob);
        setDownloadName(converted[0].name);
        setResultLabel(`1件を${FORMAT_OPTIONS.find((f) => f.value === targetFormat)?.label}形式に変換しました`);
      } else {
        const zipBlob = await createZip(converted);
        setResultBlob(zipBlob);
        setDownloadName(`${stripExtension(files[0].name) || "images"}-batch.zip`);
        setResultLabel(
          `${converted.length}件を${FORMAT_OPTIONS.find((f) => f.value === targetFormat)?.label}形式に変換し、ZIPにまとめました`
        );
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={50}
        label="画像をドラッグ&ドロップ（複数可）"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}

      {files.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            変換先の形式
          </p>
          <div className="flex gap-2">
            {FORMAT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTargetFormat(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  targetFormat === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件を変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {resultBlob && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {resultLabel} ・ {formatBytes(resultBlob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(resultBlob, downloadName)} />
        </div>
      )}
    </div>
  );
}
