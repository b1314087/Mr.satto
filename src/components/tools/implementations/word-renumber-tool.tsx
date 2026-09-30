"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { WordRenumberProcessor, type NumberingFormat } from "@/lib/processors/browser/word-renumber";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const FORMAT_OPTIONS: { value: NumberingFormat; label: string; example: string }[] = [
  { value: "arabic-dot", label: "1. 2. 3.", example: "1. 2. 3." },
  { value: "paren", label: "(1)(2)(3)", example: "(1) (2) (3)" },
  { value: "circled", label: "①②③", example: "① ② ③" },
  { value: "katakana", label: "ア イ ウ", example: "ア イ ウ" },
];

function FormatPicker({
  value,
  onChange,
}: {
  value: NumberingFormat;
  onChange: (v: NumberingFormat) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {FORMAT_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            value === opt.value
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function WordRenumberTool() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceFormat, setSourceFormat] = useState<NumberingFormat>("arabic-dot");
  const [targetFormat, setTargetFormat] = useState<NumberingFormat>("circled");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; convertedCount: number; skippedCount: number } | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new WordRenumberProcessor().process({ file, sourceFormat, targetFormat });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-renumbered.docx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={50}
        label="Wordファイル（.docx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-col gap-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">変換前の番号形式</p>
            <FormatPicker value={sourceFormat} onChange={setSourceFormat} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">変換後の番号形式</p>
            <FormatPicker value={targetFormat} onChange={setTargetFormat} />
          </div>
          <p className="text-xs text-neutral-400">
            段落の先頭がこの形式の番号になっている行だけを対象に変換します。本文そのものは変更しません。Wordの自動採番（アウトライン）機能には対応していません。
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
          番号を振り直す
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            変換した行: {result.convertedCount} ・ 対象外だった行: {result.skippedCount}
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="Wordファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
