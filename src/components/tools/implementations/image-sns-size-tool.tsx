"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImageCropProcessor,
  computeCenterCropForAspect,
} from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

interface SizePreset {
  id: string;
  label: string;
  hint: string;
  width: number;
  height: number;
}

const PRESETS: SizePreset[] = [
  { id: "square", label: "正方形 1:1", hint: "Instagram投稿など", width: 1080, height: 1080 },
  { id: "portrait", label: "縦長 4:5", hint: "Instagram縦型投稿", width: 1080, height: 1350 },
  { id: "landscape", label: "横長 16:9", hint: "YouTubeサムネイルなど", width: 1920, height: 1080 },
  { id: "story", label: "ストーリー 9:16", hint: "ストーリーズ・リール", width: 1080, height: 1920 },
];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function ImageSnsSizeTool() {
  const [file, setFile] = useState<File | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [presetId, setPresetId] = useState<string>("square");
  const [customWidth, setCustomWidth] = useState(1080);
  const [customHeight, setCustomHeight] = useState(1080);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNaturalSize(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = url;
    setResult(null);
    setError(null);
    setStatus("idle");
    // Phase 7: revokeをonloadの中だけで行うと、画像のdecodeに失敗した場合
    // （onerror）や、ファイルが素早く変更されてこのeffectが再実行された場合に
    // Object URLが解放されないまま残ってしまう。cleanup関数側で必ず解放する
    // ようにし、どちらのケースでも確実に解放されるようにする。
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  const activePreset = PRESETS.find((p) => p.id === presetId);
  const targetWidth = presetId === "custom" ? customWidth : activePreset?.width ?? 1080;
  const targetHeight = presetId === "custom" ? customHeight : activePreset?.height ?? 1080;

  async function handleRun() {
    if (!file || !naturalSize) return;
    if (targetWidth <= 0 || targetHeight <= 0) {
      setError("幅と高さは1以上を指定してください");
      setStatus("error");
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const ratio = targetWidth / targetHeight;
      const crop = computeCenterCropForAspect(naturalSize.width, naturalSize.height, ratio);
      const output = await new ImageCropProcessor().process({
        file,
        crop,
        targetWidth,
        targetHeight,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? `${stripExtension(file.name)}-sns.${result ? EXT_BY_MIME[result.mimeType] ?? "jpg" : "jpg"}`
    : "sns-image.jpg";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            変換先のサイズ
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setPresetId(preset.id)}
                className={`flex flex-col items-center gap-0.5 rounded-lg border-2 px-2 py-2.5 text-center text-xs transition-colors ${
                  presetId === preset.id
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                    : "border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-300"
                }`}
              >
                <span className="font-semibold">{preset.label}</span>
                <span className="text-neutral-400">{preset.hint}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPresetId("custom")}
              className={`flex flex-col items-center gap-0.5 rounded-lg border-2 px-2 py-2.5 text-center text-xs transition-colors ${
                presetId === "custom"
                  ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                  : "border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-300"
              }`}
            >
              <span className="font-semibold">カスタム</span>
              <span className="text-neutral-400">幅・高さを指定</span>
            </button>
          </div>

          {presetId === "custom" && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-sm">
                幅 (px)
                <input
                  type="number"
                  min={1}
                  value={customWidth}
                  onChange={(e) => setCustomWidth(Number(e.target.value))}
                  className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                高さ (px)
                <input
                  type="number"
                  min={1}
                  value={customHeight}
                  onChange={(e) => setCustomHeight(Number(e.target.value))}
                  className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </div>
          )}

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            出力サイズ: {targetWidth} × {targetHeight}px（中央を基準に必要な範囲だけ切り抜き、引き伸ばしは行いません）
          </p>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.url}
            alt="変換結果のプレビュー"
            className="max-h-64 rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
