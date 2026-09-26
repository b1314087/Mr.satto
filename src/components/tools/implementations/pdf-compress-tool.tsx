"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfCompressProcessor } from "@/lib/processors/browser/pdf";
import type { PdfCompressOutput } from "@/lib/processors/browser/pdf";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * PDF圧縮。
 * pdf-libで可能な範囲（内部構造の最適化）のみを行い、埋め込み画像の
 * 再圧縮などは行わない。結果は常に実測した元サイズ・圧縮後サイズを
 * そのまま表示し、削減できなかった場合もその事実をそのまま伝える
 * （開発指示書■9・■24: 圧縮できたふりをする実装は禁止）。
 */
export function PdfCompressTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfCompressOutput | null>(null);

  // Phase 7: 生成結果のObject URL(result.url)は画面上で使っていないが、
  // 解放しないとページを離れるまでメモリに残り続けるため、明示的に解放する。
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

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
      const output = await new PdfCompressProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const reductionPercent = result
    ? ((result.originalSizeBytes - result.compressedSizeBytes) / result.originalSizeBytes) * 100
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={100}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        このツールはPDFの内部構造を最適化します。画像の再圧縮は行わないため、写真など画像が中心のPDFでは削減効果がほとんど出ない場合があります。
      </p>

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          圧縮する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
            <p>
              元のサイズ: {formatBytes(result.originalSizeBytes)} → 圧縮後:{" "}
              {formatBytes(result.compressedSizeBytes)}
            </p>
            {result.compressedSizeBytes < result.originalSizeBytes ? (
              <p className="font-medium text-green-700 dark:text-green-400">
                {reductionPercent.toFixed(1)}% 削減されました
              </p>
            ) : result.compressedSizeBytes === result.originalSizeBytes ? (
              <p className="text-neutral-500 dark:text-neutral-400">
                このPDFは圧縮してもサイズがほとんど変わりませんでした
              </p>
            ) : (
              <p className="text-neutral-500 dark:text-neutral-400">
                このPDFは圧縮してもサイズを削減できず、わずかに増加しました（PDFの構造上、これ以上の削減効果が出ない場合があります）
              </p>
            )}
          </div>
          <RewardedDownloadGate
            onDownload={() =>
              downloadBlob(result.blob, `${stripExtension(file?.name ?? "file")}-compressed.pdf`)
            }
          />
        </div>
      )}
    </div>
  );
}
