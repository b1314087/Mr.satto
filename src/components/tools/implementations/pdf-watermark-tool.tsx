"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { SliderField } from "@/components/common/slider-field";
import {
  PdfOverlayPreview,
  usePdfFont,
} from "@/components/tools/implementations/shared/pdf-overlay-preview";
import { WATERMARK_COLOR, watermarkLayout } from "@/lib/pdf/overlay-layout";
import { WATERMARK_PREVIEW_FONT_FAMILY, getWatermarkFont } from "@/lib/pdf/overlay-fonts";
import { PdfWatermarkProcessor, type WatermarkPosition } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import type { SharedPdfFileProps } from "@/components/tools/implementations/shared/pdf-file-props";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun, countFiles } from "@/components/common/use-batch-run";

const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: "center", label: "中央" },
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

/**
 * 透かしのプレビュー。実際の出力と同じ日本語フォント(Noto Sans JP)で文字の大きさを測り、
 * 位置の計算も出力と共通(overlay-layout)。フォント(約5MB)はファイルを選んだ後に初めて読み込む。
 */
function WatermarkPreview({
  file,
  text,
  opacityPercent,
  fontSize,
  position,
  rotation,
}: {
  file: File;
  text: string;
  opacityPercent: number;
  fontSize: number;
  position: WatermarkPosition;
  rotation: number;
}) {
  const { font: previewFont, failed: fontFailed } = usePdfFont(getWatermarkFont);
  return (
    <PdfOverlayPreview
      file={file}
      width={260}
      title="透かしのプレビュー"
      caption={
        fontFailed
          ? "プレビュー用の日本語フォントを読み込めませんでした(出力には影響しません)。"
          : previewFont
            ? "設定を変えると、表示がすぐに変わります。全ページに同じ位置で入ります。"
            : "プレビュー用の日本語フォントを読み込み中…(初回のみ少し時間がかかります)"
      }
    >
      {({ geometry, sy }) => {
        if (!previewFont || text.trim() === "") return null;
        let textWidth: number;
        try {
          textWidth = previewFont.widthOfTextAtSize(text, fontSize);
        } catch {
          return null;
        }
        const textHeight = previewFont.heightAtSize(fontSize);
        // 出力と同じ計算(位置・向き・大きさ)。ページの /Rotate への対応と、小さいページでの収まり調整を含む
        const layout = watermarkLayout({
          pageWidth: geometry.media.width,
          pageHeight: geometry.media.height,
          pageRotation: geometry.rotate,
          position,
          fontSize,
          rotation,
          textWidth,
          textHeight,
          textDescent: textHeight - previewFont.heightAtSize(fontSize, { descender: false }),
        });
        // 小さすぎて収まらないページは、出力でもエラーになる(描かない)
        if (!layout.fits) return null;
        const { x, y } = layout;
        const baseline = sy(y);
        return (
          <text
            x={x}
            y={baseline}
            transform={`rotate(${-layout.angle} ${x} ${baseline})`}
            fontSize={layout.fontSize}
            fontFamily={`${WATERMARK_PREVIEW_FONT_FAMILY}, sans-serif`}
            fill={`rgb(${WATERMARK_COLOR.r * 255}, ${WATERMARK_COLOR.g * 255}, ${WATERMARK_COLOR.b * 255})`}
            fillOpacity={opacityPercent / 100}
            style={{ whiteSpace: "pre" }}
          >
            {text}
          </text>
        );
      }}
    </PdfOverlayPreview>
  );
}

export function PdfWatermarkTool({ initialFile = null, onFileChange }: SharedPdfFileProps = {}) {
  // 選んだPDF。2つ以上のとき（プレミアムの一括処理）は、同じ透かしを1つずつ順番に入れる
  // PDF修正の一括処理の上限（1回20ファイル）を使う。ほかの操作に切り替えたときは、1つ目のPDFを引き継ぐ
  const [files, setFiles] = useState<File[]>(initialFile ? [initialFile] : []);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("pdf-fix");
  const batchRun = useBatchRun();
  const [text, setText] = useState("CONFIDENTIAL");
  const [opacityPercent, setOpacityPercent] = useState(30);
  const [fontSize, setFontSize] = useState(48);
  const [position, setPosition] = useState<WatermarkPosition>("center");
  const [rotation, setRotation] = useState(-45);

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
  }, [text, opacityPercent, fontSize, position, rotation]);

  /** 一括処理：選んだ全部のPDFに、同じ設定で1つずつ入れる */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    const items = await batchRun.run(files, async (target) => {
      const output = await new PdfWatermarkProcessor().process({
        file: target,
        text,
        opacity: opacityPercent / 100,
        fontSize,
        position,
        rotation,
      });
      URL.revokeObjectURL(output.url);
      return { blob: output.blob, outputName: `${stripExtension(target.name)}-watermarked.pdf`, detail: `${output.pageCount}ページ` };
    });
    const summary = summarizeBatch(items, "すべてのPDFで透かしの追加に失敗しました");
    setStatus(summary.status);
    setError(summary.error);
  }

  async function handleRun() {
    if (!file || text.trim() === "") return;
    if (isBatch) {
      await handleRunBatch();
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfWatermarkProcessor().process({
        file,
        text,
        opacity: opacityPercent / 100,
        fontSize,
        position,
        rotation,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-watermarked.pdf` : "watermarked.pdf";

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
          <label className="flex flex-col gap-1.5 text-sm">
            透かしの文字
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="例: CONFIDENTIAL / DRAFT / 社外秘"
              className="w-full rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
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

          <SliderField
            label="不透明度"
            value={opacityPercent}
            min={5}
            max={100}
            unit="%"
            onChange={setOpacityPercent}
          />

          <SliderField
            label="フォントサイズ"
            value={fontSize}
            min={12}
            max={120}
            inputMax={200}
            unit="pt"
            onChange={setFontSize}
          />

          <SliderField
            label="回転角度"
            value={rotation}
            min={-90}
            max={90}
            unit="°"
            onChange={setRotation}
            onReset={() => setRotation(-45)}
          />
        </div>
      )}

      {file && (
        <WatermarkPreview
          file={file}
          text={text}
          opacityPercent={opacityPercent}
          fontSize={fontSize}
          position={position}
          rotation={rotation}
        />
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || text.trim() === ""} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${countFiles(files.length)}のPDFにまとめて透かしを追加する` : "透かしを追加する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={isBatch ? batchRun.progressLabel("透かしを追加しています") : undefined}
        successLabel="追加が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "pdf") || "pdf"}-watermarked.zip`} />

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
