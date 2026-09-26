"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfCropPagesProcessor, type PdfCropMargins } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const PRESETS: { label: string; mm: number }[] = [
  { label: "0mm", mm: 0 },
  { label: "10mm", mm: 10 },
  { label: "15mm", mm: 15 },
  { label: "20mm", mm: 20 },
];

/**
 * PDF余白・ページ範囲調整（クロップ）（Phase 8）。
 * 上下左右の余白(mm)を指定して、pdf-libのCropBoxだけを変更する
 * （ページ内容自体は再描画しない。開発指示書■10）。
 */
export function PdfCropPagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [margins, setMargins] = useState<PdfCropMargins>({
    topMm: 10,
    bottomMm: 10,
    leftMm: 10,
    rightMm: 10,
  });

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfProcessorOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function updateMargin(key: keyof PdfCropMargins, value: number) {
    setMargins((prev) => ({ ...prev, [key]: value }));
  }

  function applyPresetToAll(mm: number) {
    setMargins({ topMm: mm, bottomMm: mm, leftMm: mm, rightMm: mm });
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfCropPagesProcessor().process({ file, margins });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-cropped.pdf` : "cropped.pdf";
  const marginFields: { key: keyof PdfCropMargins; label: string }[] = [
    { key: "topMm", label: "上" },
    { key: "bottomMm", label: "下" },
    { key: "leftMm", label: "左" },
    { key: "rightMm", label: "右" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => {
          setFile(files[0]);
          setResult(null);
          setError(null);
          setStatus("idle");
        }}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            余白のプリセット（すべての辺に適用）
          </p>
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPresetToAll(p.mm)}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {marginFields.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 text-sm">
                {f.label}の余白 (mm)
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={margins[f.key]}
                  onChange={(e) => updateMargin(f.key, Number(e.target.value))}
                  className="w-full rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            指定した分だけ表示・印刷される範囲を狭めます（内容自体は削除・再描画されません）。
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
          余白を調整する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="余白の調整が完了しました" />
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
