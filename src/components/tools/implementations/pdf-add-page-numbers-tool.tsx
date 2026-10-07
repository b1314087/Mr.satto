"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfOverlayPreview, usePdfFont } from "@/components/tools/implementations/shared/pdf-overlay-preview";
import { PAGE_NUMBER_COLOR, pageNumberLabel, pageNumberPlacement } from "@/lib/pdf/overlay-layout";
import { getHelveticaFont } from "@/lib/pdf/overlay-fonts";
import {
  PdfAddPageNumbersProcessor,
  type PageNumberPosition,
} from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { SliderField } from "@/components/common/slider-field";

const POSITIONS: { value: PageNumberPosition; label: string }[] = [
  { value: "bottom-left", label: "左下" },
  { value: "bottom-center", label: "中央下" },
  { value: "bottom-right", label: "右下" },
];

export function PdfAddPageNumbersTool() {
  const [file, setFile] = useState<File | null>(null);
  const [startNumber, setStartNumber] = useState(1);
  const [position, setPosition] = useState<PageNumberPosition>("bottom-center");
  const [fontSize, setFontSize] = useState(10);
  // プレビュー用: 実際の出力と同じフォント(Helvetica)で文字幅を測る
  const { font: previewFont } = usePdfFont(getHelveticaFont);

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

  function handleFile(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function handleRun() {
    if (!file) return;
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
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

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
            <div className="flex gap-2">
              {POSITIONS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPosition(p.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    position === p.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
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
            const { x, y } = pageNumberPlacement(geometry.media.width, textWidth, position);
            return (
              <text
                x={x}
                y={sy(y)}
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
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          ページ番号を追加する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="追加が完了しました" />
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
