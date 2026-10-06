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
  // 計算結果・状態はファイルごとに紐づけて保持し、表示時に現在のファイルと照合する
  const [computed, setComputed] = useState<{
    file: File;
    result: FileHashOutput | null;
    error: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const current = file && computed && computed.file === file ? computed : null;
  const result = current?.result ?? null;
  const status: ProcessingState = !file
    ? "idle"
    : !current
      ? "processing"
      : current.error
        ? "error"
        : "success";

  // 選択した時点で自動的に計算し、ライブで表示する
  async function compute(target: File) {
    setCopied(false);
    try {
      const output = await new FileHashProcessor().process({ file: target });
      setComputed({ file: target, result: output, error: null });
    } catch (e) {
      setComputed({
        file: target,
        result: null,
        error: e instanceof Error ? e.message : "処理に失敗しました",
      });
    }
  }

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setError(null);
    void compute(files[0]);
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

      {file && status === "error" && (
        <button
          type="button"
          onClick={() => void compute(file)}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          SHA-256を計算する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="ハッシュを計算中..." successLabel="計算が完了しました" />
      {(error || current?.error) && <ErrorMessage message={(error ?? current?.error) as string} />}

      {file && (
        <div
          data-testid="tool-preview"
          className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <dl className="grid w-full grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-neutral-500 dark:text-neutral-400">ファイル名</dt>
              <dd className="break-all font-medium text-neutral-800 dark:text-neutral-100">{file.name}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">サイズ</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{formatBytes(file.size)}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">種類（MIME）</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{file.type || "不明"}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">アルゴリズム</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">SHA-256</dd>
            </div>
          </dl>
          <code className="w-full break-all rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
            {result ? result.hashHex : current?.error ? "計算できませんでした" : "計算中..."}
          </code>
          {result && (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              {copied ? "コピーしました" : "ハッシュ値をコピー"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
