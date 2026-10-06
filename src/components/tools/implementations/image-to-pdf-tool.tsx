"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImagesToPdfProcessor } from "@/lib/processors/browser/pdf";
import { computeImagePageLayout, type ImageToPdfPageSize } from "@/lib/processors/browser/image-to-pdf-layout";
import { useObjectUrl } from "@/components/tools/implementations/shared/image-live-preview";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

type PageSize = ImageToPdfPageSize;

/** プレビューに並べるページ数の上限(多数の画像を同時に表示して重くならないように) */
const MAX_PREVIEW_PAGES = 30;
/** プレビュー1ページを収める枠(px) */
const THUMB_BOX = { width: 132, height: 176 };

/**
 * 1ページ分のプレビュー。ページの形・画像の置かれ方は、PDF書き出しと同じ
 * computeImagePageLayout で計算する(A4なら余白つきで中央、画像サイズのままなら画像と同じ形のページ)。
 */
function PdfPageThumb({ file, index, pageSize }: { file: File; index: number; pageSize: PageSize }) {
  const url = useObjectUrl(file);
  const [loaded, setLoaded] = useState<{ file: File; width: number; height: number; failed: boolean } | null>(null);
  const size = loaded && loaded.file === file ? loaded : null;

  let frame: { width: number; height: number } | null = null;
  let imageBox: { left: number; top: number; width: number; height: number } | null = null;
  if (size && !size.failed) {
    const layout = computeImagePageLayout(size.width, size.height, pageSize);
    const scale = Math.min(THUMB_BOX.width / layout.pageWidth, THUMB_BOX.height / layout.pageHeight);
    frame = { width: layout.pageWidth * scale, height: layout.pageHeight * scale };
    imageBox = {
      left: layout.x * scale,
      // PDF座標は下端が原点なので、画面の座標(上端が原点)に直す
      top: (layout.pageHeight - layout.y - layout.height) * scale,
      width: layout.width * scale,
      height: layout.height * scale,
    };
  }

  return (
    <li className="flex flex-col items-center gap-1">
      <div
        className="relative flex items-center justify-center"
        style={{ width: THUMB_BOX.width, height: THUMB_BOX.height }}
      >
        {frame && imageBox && url ? (
          <div
            className="relative overflow-hidden border border-neutral-300 bg-white shadow-sm dark:border-neutral-600"
            style={{ width: frame.width, height: frame.height }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`${index + 1}ページ目: ${file.name}`}
              draggable={false}
              className="absolute"
              style={{ left: imageBox.left, top: imageBox.top, width: imageBox.width, height: imageBox.height }}
            />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded border border-dashed border-neutral-300 text-xs text-neutral-400 dark:border-neutral-700">
            {size?.failed ? "読み込めません" : "読み込み中..."}
          </div>
        )}
        {/* ページサイズを知るため、画像の実寸だけ読み取る(表示はしない) */}
        {url && !size && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            className="hidden"
            onLoad={(e) =>
              setLoaded({ file, width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight, failed: false })
            }
            onError={() => setLoaded({ file, width: 0, height: 0, failed: true })}
          />
        )}
      </div>
      <span className="max-w-[132px] truncate text-xs text-neutral-500 dark:text-neutral-400">
        {index + 1}ページ目
      </span>
    </li>
  );
}

export function ImageToPdfTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [pageSize, setPageSize] = useState<PageSize>("fit");

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

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
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
    try {
      const output = await new ImagesToPdfProcessor().process({ files, pageSize });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = files[0] ? `${stripExtension(files[0].name)}-pdf.pdf` : "images.pdf";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={50}
        label="画像をドラッグ&ドロップ（複数可）"
        hint="またはタップして選択。PDFに追加する順序で選択してください"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            ページサイズ
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPageSize("fit")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                pageSize === "fit"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              画像サイズのまま
            </button>
            <button
              type="button"
              onClick={() => setPageSize("a4")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                pageSize === "a4"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              A4に収める
            </button>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div
          data-testid="tool-preview"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            プレビュー（{files.length}ページ・{pageSize === "a4" ? "A4に収める" : "画像サイズのまま"}）
          </p>
          <ul className="flex flex-wrap gap-3">
            {files.slice(0, MAX_PREVIEW_PAGES).map((file, index) => (
              <PdfPageThumb key={`${file.name}-${file.size}-${file.lastModified}-${index}`} file={file} index={index} pageSize={pageSize} />
            ))}
          </ul>
          {files.length > MAX_PREVIEW_PAGES && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              先頭の{MAX_PREVIEW_PAGES}ページだけ表示しています（PDFには{files.length}ページすべてが入ります）。
            </p>
          )}
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            {pageSize === "a4"
              ? "A4（縦）の用紙に、画像が中央に配置されます。大きい画像は用紙に収まるよう縮小され、小さい画像は拡大されません。"
              : "各ページは、それぞれの画像と同じ大きさ・同じ形になります。"}
            並び順は上の一覧で変更できます。
          </p>
        </div>
      )}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件の画像をPDF化する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="PDFの作成が完了しました" />
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
