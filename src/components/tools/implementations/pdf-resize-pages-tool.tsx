"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useState, type ReactNode } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { usePdfThumbnails } from "@/components/common/pdf-thumbnails";
import { usePdfPageGeometry } from "@/components/tools/implementations/shared/pdf-overlay-preview";
import { CUSTOM_SIZE_MAX_MM, CUSTOM_SIZE_MIN_MM, PAGE_SIZE_GROUPS, customSizeError, pageSizeLabel, resizeContentRect, resizeTargetSize } from "@/lib/pdf/overlay-layout";
import { usePdfPageCount } from "@/components/tools/implementations/shared/use-pdf-page-count";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import {
  PdfResizePagesProcessor,
  type PdfPageSizePreset,
  type PdfPageOrientation,
  type PdfResizeContentMode,
} from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";

const PT_TO_MM = 25.4 / 72;
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
  custom,
  page,
  pageCount,
  onPage,
}: {
  file: File;
  pageSize: PdfPageSizePreset;
  orientation: PdfPageOrientation;
  contentMode: PdfResizeContentMode;
  custom: { widthMm: number; heightMm: number };
  page: number;
  pageCount: number | null;
  onPage: (p: number) => void;
}) {
  const geo = usePdfPageGeometry(file, page);
  const thumbs = usePdfThumbnails(file, Math.max(page, 1), 360);
  const g = geo?.pages[page];
  const imageUrl = thumbs.urls[page];
  const target = resizeTargetSize(pageSize, orientation, custom);

  let body: ReactNode;
  if (thumbs.error) {
    body = <p className="text-sm text-red-600 dark:text-red-400">{thumbs.error}</p>;
  } else if (!target) {
    body = <p className="text-xs text-red-600 dark:text-red-400">{pageSize === "custom" ? customSizeError(custom) : "用紙を選んでください。"}</p>;
  } else if (!g || !imageUrl) {
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
              <img src={imageUrl} alt={`変更前の${page}ページ目`} className="block h-full w-full" />
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
                alt={`変更後の${page}ページ目`}
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
              変更後: {pageSizeLabel(pageSize)}・{orientation === "landscape" ? "横" : "縦"}({mm(target.width)}×{mm(target.height)}mm)
            </figcaption>
          </figure>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {contentMode === "fit"
            ? `約${Math.round(rect.scale * 100)}%に${rect.scale > 1 ? "拡大" : "縮小"}して中央に置きます。`
            : clipped
              ? "はみ出す部分は見切れます。"
              : "余った部分は余白になります。"}
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（{page}ページ目{pageCount ? ` / ${pageCount}ページ` : ""}）</p>
        {pageCount !== null && pageCount > 1 && (
          <div className="flex items-center gap-1" data-testid="resize-preview-pager">
            <button type="button" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1} aria-label="前のページ" className="rounded border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-neutral-700">←</button>
            <button type="button" onClick={() => onPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount} aria-label="次のページ" className="rounded border border-neutral-300 px-2 py-0.5 text-xs disabled:opacity-30 dark:border-neutral-700">→</button>
          </div>
        )}
      </div>
      {body}
      {pageCount !== null && pageCount > 1 && <p className="text-xs text-neutral-500 dark:text-neutral-400">すべてのページ（{pageCount}ページ）を同じ用紙に変更します。ページごとに大きさが違うPDFも、それぞれ同じ計算で配置します。</p>}
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
  const [custom, setCustom] = useState<{ widthMm: number; heightMm: number }>({ widthMm: 210, heightMm: 297 });
  const [previewPage, setPreviewPage] = useState(1);
  const { pageCount } = usePdfPageCount(file);
  const customProblem = pageSize === "custom" ? customSizeError(custom) : null;

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
        custom: pageSize === "custom" ? custom : undefined,
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
    <PreviewSplitLayout
      previewWidth="md"
      preview={
        file ? (
        <ResizePreview
          file={file}
          pageSize={pageSize}
          orientation={orientation}
          contentMode={contentMode}
          custom={custom}
          page={Math.min(previewPage, pageCount ?? 1)}
          pageCount={pageCount}
          onPage={setPreviewPage}
        />
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            PDFを選ぶと、ここにプレビューが表示されます
          </div>
        )
      }
    >
      <FileDropzone
        compact={!!file}
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => {
          setFile(files[0]);
          setPreviewPage(1);
          setResult(null);
          setError(null);
          setStatus("idle");
        }}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <SettingsStack testId="resize-settings">
          <SettingsSection n={1} title="変更後の用紙" summary={pageSize === "custom" ? `カスタム ${custom.widthMm}×${custom.heightMm}mm` : pageSizeLabel(pageSize)}>
            {PAGE_SIZE_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-1">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{g.label}</p>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={g.label}>
                  {g.options.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={pageSize === opt.value}
                      title={opt.note}
                      onClick={() => setPageSize(opt.value)}
                      data-testid={`resize-size-${opt.value}`}
                      className={`rounded-lg border px-2.5 py-1.5 text-sm ${pageSize === opt.value ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-300 text-neutral-700 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-200"}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {pageSize === "custom" && (
              <div className="flex flex-wrap items-end gap-3" data-testid="resize-custom">
                {(["widthMm", "heightMm"] as const).map((k) => (
                  <label key={k} className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                    {k === "widthMm" ? "幅（mm）" : "高さ（mm）"}
                    <input
                      type="number"
                      min={CUSTOM_SIZE_MIN_MM}
                      max={CUSTOM_SIZE_MAX_MM}
                      step={0.1}
                      value={Number.isFinite(custom[k]) ? custom[k] : ""}
                      onChange={(e) => setCustom((c) => ({ ...c, [k]: e.target.value === "" ? NaN : Number(e.target.value) }))}
                      data-testid={`resize-custom-${k === "widthMm" ? "width" : "height"}`}
                      className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </label>
                ))}
                <p className="w-full text-xs text-neutral-500 dark:text-neutral-400">
                  {CUSTOM_SIZE_MIN_MM}〜{CUSTOM_SIZE_MAX_MM}mmで指定します。下の「向き」で横向きを選ぶと、幅と高さが入れ替わります。
                </p>
                {customProblem && <p className="w-full text-xs text-red-600 dark:text-red-400" data-testid="resize-custom-error">{customProblem}</p>}
              </div>
            )}
          </SettingsSection>
          <SettingsSection n={2} title="向きと内容の扱い" summary={`${orientation === "landscape" ? "横向き" : "縦向き"}・${contentMode === "fit" ? "内容も拡大縮小" : "ページサイズだけ"}`}>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">向き</p>
            <div className="ms-seg">
              {(
                [
                  { value: "portrait", label: "縦向き" },
                  { value: "landscape", label: "横向き" },
                ] as const
              ).map((opt) => (
                <button aria-pressed={orientation === opt.value}
                  key={opt.value}
                  type="button"
                  onClick={() => setOrientation(opt.value)}
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
                  縮小時は内容が見切れる場合があります
                </span>
              </span>
            </label>
          </div>
          </SettingsSection>
        </SettingsStack>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || customProblem !== null} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            変更する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel="ページサイズの変更が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
