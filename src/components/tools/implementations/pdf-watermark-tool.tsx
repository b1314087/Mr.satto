"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfWatermarkProcessor, type WatermarkPosition } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: "center", label: "中央" },
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

export function PdfWatermarkTool() {
  const [file, setFile] = useState<File | null>(null);
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

  function handleFile(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function handleRun() {
    if (!file || text.trim() === "") return;
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
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

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
            <div className="flex flex-wrap gap-2">
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

          <label className="flex flex-col gap-1 text-sm">
            不透明度: {opacityPercent}%
            <input
              type="range"
              min={5}
              max={100}
              value={opacityPercent}
              onChange={(e) => setOpacityPercent(Number(e.target.value))}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            フォントサイズ: {fontSize}pt
            <input
              type="range"
              min={12}
              max={120}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            回転角度: {rotation}°
            <input
              type="range"
              min={-90}
              max={90}
              value={rotation}
              onChange={(e) => setRotation(Number(e.target.value))}
            />
          </label>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || text.trim() === ""}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          透かしを追加する
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
