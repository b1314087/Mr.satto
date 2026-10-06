"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { usePdfThumbnails } from "@/components/common/pdf-thumbnails";
import { PdfCompressProcessor } from "@/lib/processors/browser/pdf";
import type { PdfCompressOutput } from "@/lib/processors/browser/pdf";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/** 1つのPDFの先頭ページの縮小表示(圧縮前・圧縮後で同じ形式) */
function FirstPageThumb({ file, label, sizeBytes }: { file: File; label: string; sizeBytes: number }) {
  const { urls, loading, error } = usePdfThumbnails(file, 1, 200);
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <div className="flex min-h-40 w-[200px] max-w-full items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-700">
        {urls[1] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={urls[1]} alt={`${label}の先頭ページ`} data-testid="pdf-thumb" className="h-auto w-full" />
        ) : error ? (
          <span className="px-2 text-center text-xs text-red-600 dark:text-red-400">{error}</span>
        ) : (
          <span className="text-xs text-neutral-400">{loading ? "読み込み中…" : "…"}</span>
        )}
      </div>
      <figcaption className="text-xs text-neutral-600 dark:text-neutral-300">
        {label}: {formatBytes(sizeBytes)}
      </figcaption>
    </figure>
  );
}

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

  // 圧縮後のPDFの先頭ページを表示するため、結果のBlobをFileにする
  const compressedFile = useMemo(
    () => (result ? new File([result.blob], "compressed.pdf", { type: "application/pdf" }) : null),
    [result]
  );

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
        <section
          aria-label="圧縮前後のプレビュー"
          data-testid="tool-preview"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">圧縮前後の比較(先頭ページ)</p>
          <div className="flex flex-wrap items-start gap-6">
            <FirstPageThumb file={file} label="圧縮前" sizeBytes={file.size} />
            {result && compressedFile ? (
              <FirstPageThumb file={compressedFile} label="圧縮後" sizeBytes={result.compressedSizeBytes} />
            ) : (
              <div className="flex min-h-40 w-[200px] max-w-full items-center justify-center rounded-md border border-dashed border-neutral-300 px-3 text-center text-xs text-neutral-400 dark:border-neutral-700">
                「圧縮する」を押すと、圧縮後の先頭ページとサイズがここに表示されます
              </div>
            )}
          </div>
          {result && (
            <div className="flex flex-col gap-1" aria-label="サイズの比較">
              <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className="h-2 rounded-full bg-neutral-400 dark:bg-neutral-500"
                  style={{ width: "100%" }}
                />
              </div>
              <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className={`h-2 rounded-full ${
                    result.compressedSizeBytes <= result.originalSizeBytes ? "bg-green-600" : "bg-amber-500"
                  }`}
                  style={{
                    width: `${Math.min(100, (result.compressedSizeBytes / Math.max(1, result.originalSizeBytes)) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                上が圧縮前、下が圧縮後のサイズです。圧縮しても、ページの見た目は変わりません。
              </p>
            </div>
          )}
        </section>
      )}

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
