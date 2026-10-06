"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { usePdfThumbnails } from "@/components/common/pdf-thumbnails";
import { usePdfPageGeometry } from "@/components/tools/implementations/shared/pdf-overlay-preview";
import { resizeContentRect, resizeTargetSize } from "@/lib/pdf/overlay-layout";
import {
  PdfResizePagesProcessor,
  type PdfPageSizePreset,
  type PdfPageOrientation,
  type PdfResizeContentMode,
} from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const SIZE_OPTIONS: { value: PdfPageSizePreset; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "a3", label: "A3" },
  { value: "letter", label: "Letter" },
];

const PT_TO_MM = 25.4 / 72;
const SIZE_LABELS: Record<PdfPageSizePreset, string> = { a4: "A4", a3: "A3", letter: "Letter", original: "元のサイズ" };
/** プレビューで一番大きい辺を何pxで表示するか(変更前・変更後で同じ縮尺にする) */
const PREVIEW_LONGEST_SIDE_PX = 170;

/**
 * 変更前と変更後の1ページ目を、同じ縮尺で並べて見せる。
 * 変更後は用紙の縦横比の枠で、内容の位置・大きさは出力と同じ計算(overlay-layout)で配置する。
 */
function ResizePreview({
  file,
  pageSize,
  orientation,
  contentMode,
}: {
  file: File;
  pageSize: PdfPageSizePreset;
  orientation: PdfPageOrientation;
  contentMode: PdfResizeContentMode;
}) {
  const geo = usePdfPageGeometry(file, 1);
  const thumbs = usePdfThumbnails(file, 1, 360);
  const g = geo?.pages[1];
  const imageUrl = thumbs.urls[1];
  const target = resizeTargetSize(pageSize, orientation);

  let body: ReactNode;
  if (thumbs.error) {
    body = <p className="text-sm text-red-600 dark:text-red-400">{thumbs.error}</p>;
  } else if (!g || !target || !imageUrl) {
    body = <p className="text-xs text-neutral-400">読み込み中…</p>;
  } else {
    const oldW = g.media.width;
    const oldH = g.media.height;
    const rect = resizeContentRect(oldW, oldH, target.width, target.height, contentMode);
    const px = PREVIEW_LONGEST_SIDE_PX / Math.max(oldW, oldH, target.width, target.height);
    const mm = (pt: number) => Math.round(pt * PT_TO_MM);
    const clipped = contentMode === "keep" && (oldW > target.width + 0.5 || oldH > target.height + 0.5);
    body = (
      <>
        <div className="flex flex-wrap items-end gap-6">
          <figure className="flex flex-col items-center gap-1">
            <div
              className="overflow-hidden border border-neutral-300 bg-white dark:border-neutral-600"
              style={{ width: oldW * px, height: oldH * px }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="変更前の1ページ目" className="block h-full w-full" />
            </div>
            <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
              変更前({mm(oldW)}×{mm(oldH)}mm)
            </figcaption>
          </figure>
          <figure className="flex flex-col items-center gap-1">
            <div
              data-testid="resize-after-frame"
              className="relative overflow-hidden border-2 border-blue-600 bg-neutral-100 dark:bg-neutral-800"
              style={{ width: target.width * px, height: target.height * px }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="変更後の1ページ目"
                className="absolute block bg-white"
                style={{
                  left: rect.x * px,
                  bottom: rect.y * px,
                  width: rect.width * px,
                  height: rect.height * px,
                  maxWidth: "none",
                }}
              />
            </div>
            <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
              変更後: {SIZE_LABELS[pageSize]}・{orientation === "landscape" ? "横" : "縦"}({mm(target.width)}×{mm(target.height)}mm)
            </figcaption>
          </figure>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {contentMode === "fit"
            ? `青い枠が新しい用紙です。内容は縦横比を保ったまま${rect.scale > 1 ? "拡大" : "縮小"}して中央に置かれます(約${Math.round(rect.scale * 100)}%)。余白(灰色の部分)は白紙になります。`
            : clipped
              ? "青い枠が新しい用紙です。内容の大きさはそのままで、用紙からはみ出す右上側は見切れます。"
              : "青い枠が新しい用紙です。内容の大きさ・位置(左下基準)はそのままで、余った右上側が余白になります。"}
        </p>
        {g.rotate !== 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            このPDFは回転が設定されたページを含みます。仕上がりの向きがプレビューと異なる場合があります。
          </p>
        )}
      </>
    );
  }

  return (
    <section
      aria-label="サイズ変更のプレビュー"
      data-testid="tool-preview"
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">サイズ変更のプレビュー(1ページ目)</p>
      {body}
    </section>
  );
}

/**
 * PDFページサイズ変更（Phase 8）。
 * 「内容も拡大縮小するか」「ページサイズだけ変えるか」を、UI上でも
 * はっきり分けて選ばせる（開発指示書■9：どちらの動作かを曖昧にしない）。
 */
export function PdfResizePagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageSize, setPageSize] = useState<PdfPageSizePreset>("a4");
  const [orientation, setOrientation] = useState<PdfPageOrientation>("portrait");
  const [contentMode, setContentMode] = useState<PdfResizeContentMode>("fit");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfProcessorOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfResizePagesProcessor().process({
        file,
        pageSize,
        orientation,
        contentMode,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-resized.pdf` : "resized.pdf";

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
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変更後のサイズ</p>
            <div className="flex gap-2">
              {SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPageSize(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    pageSize === opt.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">向き</p>
            <div className="flex gap-2">
              {(
                [
                  { value: "portrait", label: "縦向き" },
                  { value: "landscape", label: "横向き" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setOrientation(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    orientation === opt.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">内容の扱い</p>
            <label className="flex items-start gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input
                type="radio"
                name="content-mode"
                checked={contentMode === "fit"}
                onChange={() => setContentMode("fit")}
                className="mt-0.5"
              />
              <span>
                内容も新しいサイズに合わせて拡大縮小する
                <span className="block text-xs text-neutral-400">
                  縦横比を保ったまま中央に配置します（推奨）
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input
                type="radio"
                name="content-mode"
                checked={contentMode === "keep"}
                onChange={() => setContentMode("keep")}
                className="mt-0.5"
              />
              <span>
                内容の大きさは変えず、ページサイズだけ変更する
                <span className="block text-xs text-neutral-400">
                  拡大時は余白が増え、縮小時は右上側の内容が見切れる場合があります
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {file && (
        <ResizePreview file={file} pageSize={pageSize} orientation={orientation} contentMode={contentMode} />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          変更する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="ページサイズの変更が完了しました" />
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
