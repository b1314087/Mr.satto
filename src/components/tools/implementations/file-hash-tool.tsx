"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { FileHashProcessor, type FileHashOutput } from "@/lib/processors/browser/file-hash";
import { formatBytes } from "@/lib/utils/format";

/**
 * ファイルハッシュ（SHA-256）（Phase 8）。
 * ファイル選択→計算→表示→コピー、というシンプルな流れのみのUI。
 * 処理はWeb Crypto APIのみで行われ、ファイルはどこにも送信されない。
 */
export function FileHashTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FileHashOutput | null>(null);
  const [copied, setCopied] = useState(false);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setError(null);
    setStatus("idle");
    setCopied(false);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setCopied(false);
    try {
      const output = await new FileHashProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.hashHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("クリップボードへのコピーに失敗しました。表示された文字列を選択してコピーしてください。");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        maxSizeMB={200}
        label="ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（形式は問いません）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          SHA-256を計算する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="計算が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.fileName} ・ {formatBytes(result.sizeBytes)} ・ {result.algorithm}
          </p>
          <code className="w-full break-all rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
            {result.hashHex}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
          >
            {copied ? "コピーしました" : "ハッシュ値をコピー"}
          </button>
        </div>
      )}
    </div>
  );
}
