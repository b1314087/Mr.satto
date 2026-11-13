"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfOverlayPreview, usePdfFont } from "@/components/tools/implementations/shared/pdf-overlay-preview";
import { PAGE_NUMBER_COLOR, pageNumberLabel, pageNumberLayout } from "@/lib/pdf/overlay-layout";
import { getHelveticaFont } from "@/lib/pdf/overlay-fonts";
import {
  PdfAddPageNumbersProcessor,
  type PageNumberPosition,
} from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { SliderField } from "@/components/common/slider-field";
import type { SharedPdfFileProps } from "@/components/tools/implementations/shared/pdf-file-props";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun, countFiles } from "@/components/common/use-batch-run";

const POSITIONS: { value: PageNumberPosition; label: string }[] = [
  { value: "bottom-left", label: "左下" },
  { value: "bottom-center", label: "中央下" },
  { value: "bottom-right", label: "右下" },
];

export function PdfAddPageNumbersTool({ initialFile = null, onFileChange }: SharedPdfFileProps = {}) {
  // 選んだPDF。2つ以上のとき（プレミアムの一括処理）は、同じ設定で1つずつ順番にページ番号を入れる
  // PDF修正の一括処理の上限（1回20ファイル）を使う。ほかの操作に切り替えたときは、1つ目のPDFを引き継ぐ
  const [files, setFiles] = useState<File[]>(initialFile ? [initialFile] : []);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("pdf-fix");
  const batchRun = useBatchRun();
  const [startNumber, setStartNumber] = useState(1);
  const [position, setPosition] = useState<PageNumberPosition>("bottom-center");
  const [fontSize, setFontSize] = useState(10);
  // プレビュー用: 実際の出力と同じフォント(Helvetica)で文字幅を測る
  const { font: previewFont } = usePdfFont(getHelveticaFont, file !== null);

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

  function handleFile(selected: File[]) {
    const next = batch.pick(files, selected, "append");
    setFiles(next);
    onFileChange?.(next[0] ?? null);
    batchRun.reset();
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  function removeFile(index: number) {
    const next = files.filter((_, i) => i !== index);
    setFiles(next);
    onFileChange?.(next[0] ?? null);
    batchRun.reset();
    setResult(null);
    setStatus("idle");
  }

  // 設定を変えたら、前の設定でまとめて処理した結果は捨てる（違う設定の結果を保存させない）
  const resetBatch = batchRun.reset;
  useEffect(() => {
    resetBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startNumber, position, fontSize]);

  /** 一括処理：選んだ全部のPDFに、同じ設定で1つずつ入れる */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    const items = await batchRun.run(files, async (target) => {
      const output = await new PdfAddPageNumbersProcessor().process({ file: target, startNumber, position, fontSize });
      URL.revokeObjectURL(output.url);
      return { blob: output.blob, outputName: `${stripExtension(target.name)}-numbered.pdf`, detail: `${output.pageCount}ページ` };
    });
    const summary = summarizeBatch(items, "すべてのPDFでページ番号の追加に失敗しました");
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
      const output = await new PdfAddPageNumbersProcessor().process({
        file,
        startNumber,
        position,
        fontSize,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-numbered.pdf` : "numbered.pdf";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        multiple
        onFilesSelected={handleFile}
        onError={setError}
      />
      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}
      {isBatch && (
        <p data-testid="batch-note" className="text-xs text-ms-muted">
          プレビューは1つ目のPDFです。ほかのPDFにも同じ設定で入れます。
        </p>
      )}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex flex-col gap-1 text-sm">
            開始番号
            <input
              type="number"
              value={startNumber}
              onChange={(e) => setStartNumber(Number(e.target.value))}
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          <div className="flex flex-col gap-1.5 text-sm">
            位置
            <div className="ms-seg">
              {POSITIONS.map((p) => (
                <button aria-pressed={position === p.value}
                  key={p.value}
                  type="button"
                  onClick={() => setPosition(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <SliderField label="フォントサイズ" value={fontSize} min={6} max={24} unit="pt" onChange={setFontSize} />
        </div>
      )}

      {file && (
        <PdfOverlayPreview
          file={file}
          pages={[1, 2, 3]}
          width={160}
          title="ページ番号のプレビュー"
          caption={
            Number.isInteger(startNumber)
              ? "設定を変えると、表示がすぐに変わります。出力されるPDFの位置・書式と同じ計算で表示しています。"
              : "開始番号は整数で入力してください。"
          }
        >
          {({ page, geometry, sy }) => {
            if (!previewFont || !Number.isInteger(startNumber)) return null;
            const label = pageNumberLabel(startNumber, page - 1);
            const textWidth = previewFont.widthOfTextAtSize(label, fontSize);
            // 出力と同じ計算。ページに /Rotate があっても、表示上は読める向き・指定の位置になる
            // (プレビューの枠もページと同じ角度で回して重ねるため、文字の角度も出力と同じ値を使う)
            const { x, y, angle } = pageNumberLayout(
              geometry.media.width,
              geometry.media.height,
              geometry.rotate,
              textWidth,
              position
            );
            const baseline = sy(y);
            return (
              <text
                x={x}
                y={baseline}
                transform={`rotate(${-angle} ${x} ${baseline})`}
                fontSize={fontSize}
                fontFamily="Helvetica, Arial, sans-serif"
                fill={`rgb(${PAGE_NUMBER_COLOR.r * 255}, ${PAGE_NUMBER_COLOR.g * 255}, ${PAGE_NUMBER_COLOR.b * 255})`}
                style={{ whiteSpace: "pre" }}
              >
                {label}
              </text>
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
            {isBatch ? `${countFiles(files.length)}のPDFにまとめてページ番号を追加する` : "ページ番号を追加する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={isBatch ? batchRun.progressLabel("ページ番号を追加しています") : undefined}
        successLabel="追加が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "pdf") || "pdf"}-numbered.zip`} />

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
