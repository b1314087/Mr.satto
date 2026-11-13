"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { SliderField } from "@/components/common/slider-field";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfOverlayPreview } from "@/components/tools/implementations/shared/pdf-overlay-preview";
import { croppedBox } from "@/lib/pdf/overlay-layout";
import { PdfCropPagesProcessor, type PdfCropMargins } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun, countFiles } from "@/components/common/use-batch-run";

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
  // 選んだPDF。2つ以上のとき（プレミアムの一括処理）は、同じ余白で1つずつ順番に調整する
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("pdf-crop-pages");
  const batchRun = useBatchRun();
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

  function handleSelect(selected: File[]) {
    setFiles(batch.pick(files, selected, "append"));
    batchRun.reset();
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    batchRun.reset();
    setResult(null);
    setStatus("idle");
  }

  // 設定を変えたら、前の設定でまとめて処理した結果は捨てる（違う設定の結果を保存させない）
  const resetBatch = batchRun.reset;
  useEffect(() => {
    resetBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [margins]);

  /** 一括処理：選んだ全部のファイルを、同じ設定で1つずつ順番に処理する */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    const usedMargins = margins;
    setStatus("processing");
    setError(null);
    setResult(null);
    const items = await batchRun.run(files, async (target) => {
      const output = await new PdfCropPagesProcessor().process({ file: target, margins: usedMargins });
      URL.revokeObjectURL(output.url);
      return { blob: output.blob, outputName: `${stripExtension(target.name)}-cropped.pdf`, detail: `${output.pageCount}ページ` };
    });
    const summary = summarizeBatch(items, "すべてのPDFで余白の調整に失敗しました");
    setStatus(summary.status);
    setError(summary.error);
  }

  async function handleRun() {
    if (!file) return;
    if (isBatch) {
      await handleRunBatch();
      return;
    }
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
  const marginsValid = Object.values(margins).every((v) => Number.isFinite(v) && v >= 0);
  const marginFields: { key: keyof PdfCropMargins; label: string }[] = [
    { key: "topMm", label: "上" },
    { key: "bottomMm", label: "下" },
    { key: "leftMm", label: "左" },
    { key: "rightMm", label: "右" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        multiple
        onFilesSelected={handleSelect}
        onError={setError}
      />

      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}
      {isBatch && (
        <p data-testid="batch-note" className="text-xs text-ms-muted">
          プレビューは1つ目のPDFです。ほかのPDFも同じ余白で調整します。
        </p>
      )}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">余白のプリセット</p>
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

          {/* 2026-11：余白はバー（スライダー）と数値入力の両方で調整できる。バーは0〜100mm、数値入力は500mmまで */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="pdf-crop-sliders">
            {marginFields.map((f) => (
              <SliderField
                key={f.key}
                label={`${f.label}の余白`}
                value={margins[f.key]}
                min={0}
                max={100}
                inputMax={500}
                step={1}
                unit="mm"
                onChange={(v) => updateMargin(f.key, v)}
              />
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">表示・印刷の範囲を狭めます（内容は削除されません）。</p>
        </div>
      )}

      {file && (
        <PdfOverlayPreview
          file={file}
          width={260}
          title="トリミングのプレビュー(1ページ目)"
          caption={
            marginsValid
              ? "点線の内側が残る範囲、暗い部分が切り取られる余白です(赤くなる場合は余白が大きすぎます)。設定を変えるとすぐに変わります。"
              : "余白は0以上の数値で入力してください。"
          }
        >
          {({ geometry, sy }) => {
            if (!marginsValid) return null;
            const box = croppedBox(geometry.crop, margins);
            if (!box) {
              return (
                <rect
                  x={geometry.crop.x}
                  y={sy(geometry.crop.y + geometry.crop.height)}
                  width={geometry.crop.width}
                  height={geometry.crop.height}
                  fill="rgb(220, 38, 38)"
                  fillOpacity={0.35}
                />
              );
            }
            const outer = geometry.crop;
            const d =
              `M${outer.x} ${sy(outer.y + outer.height)}h${outer.width}v${outer.height}h${-outer.width}z` +
              `M${box.x} ${sy(box.y + box.height)}h${box.width}v${box.height}h${-box.width}z`;
            return (
              <>
                <path d={d} fillRule="evenodd" fill="rgb(0, 0, 0)" fillOpacity={0.4} />
                <rect
                  x={box.x}
                  y={sy(box.y + box.height)}
                  width={box.width}
                  height={box.height}
                  fill="none"
                  stroke="rgb(37, 99, 235)"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            );
          }}
        </PdfOverlayPreview>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${countFiles(files.length)}のPDFの余白をまとめて調整する` : "余白を調整する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel={isBatch ? batchRun.progressLabel("余白を調整しています") : undefined} successLabel="余白の調整が完了しました" />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "pdf") || "pdf"}-cropped.zip`} />

      {result && !isBatch && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </div>
  );
}
