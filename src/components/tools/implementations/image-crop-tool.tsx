"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageCropProcessor, type CropRegion } from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

interface Box {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

const DEFAULT_BOX: Box = { xPct: 10, yPct: 10, wPct: 80, hPct: 80 };
const MIN_SIZE_PCT = 5;

const RATIO_PRESETS: { label: string; ratio: number | null }[] = [
  { label: "自由", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "16:9", ratio: 16 / 9 },
];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

function clampBox(next: Box): Box {
  const wPct = Math.min(Math.max(next.wPct, MIN_SIZE_PCT), 100);
  const hPct = Math.min(Math.max(next.hPct, MIN_SIZE_PCT), 100);
  const xPct = Math.min(Math.max(next.xPct, 0), 100 - wPct);
  const yPct = Math.min(Math.max(next.yPct, 0), 100 - hPct);
  return { xPct, yPct, wPct, hPct };
}

export function ImageCropTool() {
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const [ratio, setRatio] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize";
    corner?: Corner;
    startClientX: number;
    startClientY: number;
    startBox: Box;
  } | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    if (!file) {
      // ファイル選択が解除された際に関連stateをリセットする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setImageUrl(null);
      setNaturalSize(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    const img = new Image();
    img.onload = () => {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      setBox(DEFAULT_BOX);
      setRatio(null);
    };
    img.src = url;
    setResult(null);
    setError(null);
    setStatus("idle");
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function applyRatio(b: Box, r: number | null): Box {
    if (!r || !naturalSize) return b;
    const hPct = (b.wPct * naturalSize.width) / (r * naturalSize.height);
    return clampBox({ ...b, hPct });
  }

  function handleBoxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "move",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startBox: box,
    };
  }

  function handleHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, corner: Corner) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "resize",
      corner,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startBox: box,
    };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dxPct = ((e.clientX - drag.startClientX) / rect.width) * 100;
    const dyPct = ((e.clientY - drag.startClientY) / rect.height) * 100;

    if (drag.mode === "move") {
      setBox(
        clampBox({
          ...drag.startBox,
          xPct: drag.startBox.xPct + dxPct,
          yPct: drag.startBox.yPct + dyPct,
        })
      );
      return;
    }

    let { xPct, yPct, wPct, hPct } = drag.startBox;
    const corner = drag.corner ?? "se";
    if (corner.includes("e")) wPct = drag.startBox.wPct + dxPct;
    if (corner.includes("s")) hPct = drag.startBox.hPct + dyPct;
    if (corner.includes("w")) {
      wPct = drag.startBox.wPct - dxPct;
      xPct = drag.startBox.xPct + dxPct;
    }
    if (corner.includes("n")) {
      hPct = drag.startBox.hPct - dyPct;
      yPct = drag.startBox.yPct + dyPct;
    }
    let next = clampBox({ xPct, yPct, wPct, hPct });
    if (ratio) next = applyRatio(next, ratio);
    setBox(next);
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function handleRatioSelect(r: number | null) {
    setRatio(r);
    if (r) setBox((b) => applyRatio(b, r));
  }

  async function handleRun() {
    if (!file || !naturalSize) return;
    setStatus("processing");
    setError(null);
    try {
      const crop: CropRegion = {
        x: Math.round((box.xPct / 100) * naturalSize.width),
        y: Math.round((box.yPct / 100) * naturalSize.height),
        width: Math.round((box.wPct / 100) * naturalSize.width),
        height: Math.round((box.hPct / 100) * naturalSize.height),
      };
      const output = await new ImageCropProcessor().process({ file, crop });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? `${stripExtension(file.name)}-crop.${result ? EXT_BY_MIME[result.mimeType] ?? "jpg" : "jpg"}`
    : "cropped.jpg";

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

      {file && imageUrl && naturalSize && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {RATIO_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => handleRatioSelect(preset.ratio)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  ratio === preset.ratio
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div
            ref={containerRef}
            className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="トリミング対象の画像" draggable={false} className="block w-full h-auto select-none" />
            <div
              onPointerDown={handleBoxPointerDown}
              className="absolute cursor-move border-2 border-blue-400 bg-blue-400/10"
              style={{
                left: `${box.xPct}%`,
                top: `${box.yPct}%`,
                width: `${box.wPct}%`,
                height: `${box.hPct}%`,
              }}
            >
              {CORNERS.map((corner) => (
                <div
                  key={corner}
                  onPointerDown={(e) => handleHandlePointerDown(e, corner)}
                  aria-label={`トリミング範囲の${corner}角をドラッグしてサイズ変更`}
                  className={`absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-blue-500 shadow ${
                    corner === "nw"
                      ? "left-0 top-0 cursor-nwse-resize"
                      : corner === "ne"
                        ? "left-full top-0 cursor-nesw-resize"
                        : corner === "sw"
                          ? "left-0 top-full cursor-nesw-resize"
                          : "left-full top-full cursor-nwse-resize"
                  }`}
                />
              ))}
            </div>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            枠をドラッグして移動、四隅のハンドルでサイズ変更できます。
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
          トリミングする
        </button>
      )}

      <ProcessingStatus state={status} successLabel="トリミングが完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.url}
            alt="トリミング結果のプレビュー"
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
