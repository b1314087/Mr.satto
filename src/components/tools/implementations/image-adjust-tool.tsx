"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { SliderField } from "@/components/common/slider-field";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageAdjustProcessor, applyBrightnessContrast, loadImage } from "@/lib/processors/browser/image";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** プレビュー用に縮小する最長辺(px)。スライダー操作のたびに全ピクセルを再計算しても軽いサイズにする */
const PREVIEW_MAX_SIDE = 640;

/**
 * 画像の明るさ・コントラスト調整。
 *
 * - スライダーを動かすと、縮小したプレビュー画像に即座に反映される(元画像と並べて比較できる)。
 *   プレビューは縮小画像に同じ計算(applyBrightnessContrast)を適用しているだけで、
 *   書き出し時は元の解像度の画像へ同じ設定を適用する。
 * - 複数枚を選ぶと、同じ設定をまとめて適用し、ZIPで書き出せる。
 *   プレビューする画像は一覧から選べる。
 */
export function ImageAdjustTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; name: string; label: string } | null>(null);

  const selectedFile = files[Math.min(selectedIndex, files.length - 1)] ?? null;

  // --- プレビュー ---
  const baseDataRef = useRef<ImageData | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  // 「どのファイルのプレビュー用データが準備できたか」を持つ(ファイルが変われば自動的に未準備に戻る)
  const [readyFor, setReadyFor] = useState<File | null>(null);
  const [errorFor, setErrorFor] = useState<{ file: File; message: string } | null>(null);
  const previewReady = selectedFile !== null && readyFor === selectedFile;
  const previewError = errorFor && errorFor.file === selectedFile ? errorFor.message : null;
  const originalUrl = useMemo(() => (selectedFile ? URL.createObjectURL(selectedFile) : null), [selectedFile]);
  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);

  // 選択画像が変わったら、縮小した元データを作り直す
  useEffect(() => {
    let cancelled = false;
    baseDataRef.current = null;
    if (!selectedFile) return;
    (async () => {
      try {
        const img = await loadImage(selectedFile);
        if (cancelled) return;
        const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        ctx.drawImage(img, 0, 0, w, h);
        baseDataRef.current = ctx.getImageData(0, 0, w, h);
        setReadyFor(selectedFile);
      } catch (e) {
        if (!cancelled) setErrorFor({ file: selectedFile, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  // スライダー変更のたびにプレビューを描き直す(連続操作は次の描画フレームへまとめる)
  useEffect(() => {
    const base = baseDataRef.current;
    const canvas = previewCanvasRef.current;
    if (!previewReady || !base || !canvas) return;
    const frame = requestAnimationFrame(() => {
      const adjusted = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
      applyBrightnessContrast(adjusted.data, brightness, contrast);
      canvas.width = base.width;
      canvas.height = base.height;
      canvas.getContext("2d")?.putImageData(adjusted, 0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [previewReady, brightness, contrast]);

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex((cur) => (cur > index ? cur - 1 : cur));
    setResult(null);
  }

  async function handleRun() {
    if (files.length === 0) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const usedNames = new Map<string, number>();
      const outputs: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgressLabel(files.length > 1 ? `処理中 ${i + 1} / ${files.length}` : "処理中...");
        const file = files[i];
        const output = await new ImageAdjustProcessor().process({ file, brightness, contrast });
        const ext = EXT_BY_MIME[output.mimeType] ?? "png";
        const base = `${stripExtension(file.name)}-adjusted`;
        const count = usedNames.get(base) ?? 0;
        usedNames.set(base, count + 1);
        outputs.push({ name: count === 0 ? `${base}.${ext}` : `${base}-${count + 1}.${ext}`, blob: output.blob });
      }
      if (outputs.length === 1) {
        setResult({ blob: outputs[0].blob, name: outputs[0].name, label: "1枚を調整しました" });
      } else {
        const zip = await createZip(outputs);
        setResult({
          blob: zip,
          name: `${stripExtension(files[0].name) || "images"}-adjusted.zip`,
          label: `${outputs.length}枚を同じ設定で調整し、ZIPにまとめました`,
        });
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    } finally {
      setProgressLabel("");
    }
  }

  const changed = brightness !== 0 || contrast !== 0;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={50}
        label="画像をドラッグ&ドロップ（複数可）"
        hint="またはタップして選択（JPG・PNG・WebPなど）。複数枚は同じ設定でまとめて調整できます"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}

      {files.length > 1 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビューする画像</p>
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <button
                key={`${f.name}-${i}`}
                type="button"
                onClick={() => setSelectedIndex(i)}
                aria-pressed={i === Math.min(selectedIndex, files.length - 1)}
                className={`max-w-[12rem] truncate rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  i === Math.min(selectedIndex, files.length - 1)
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                {i + 1}. {f.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedFile && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー(スライダーに合わせて変わります)</p>
          {previewError && <ErrorMessage message={previewError} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">元の画像</figcaption>
              {originalUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={originalUrl}
                  alt="元の画像"
                  className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                />
              )}
            </figure>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                調整後{changed ? "" : "(変更なし)"}
              </figcaption>
              <canvas
                ref={previewCanvasRef}
                aria-label="調整後のプレビュー"
                data-testid="adjust-preview"
                className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
              />
            </figure>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <SliderField
            label="明るさ"
            value={brightness}
            min={-100}
            max={100}
            onChange={setBrightness}
            onReset={brightness !== 0 ? () => setBrightness(0) : undefined}
          />
          <SliderField
            label="コントラスト"
            value={contrast}
            min={-100}
            max={100}
            onChange={setContrast}
            onReset={contrast !== 0 ? () => setContrast(0) : undefined}
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            書き出し時は、元の解像度の画像に同じ設定が適用されます。ファイルは外部へ送信されません。
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
          {files.length > 1 ? `${files.length}枚をまとめて調整する` : "適用する"}
        </button>
      )}

      <ProcessingStatus state={status} processingLabel={progressLabel || "処理中..."} successLabel="調整が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.label} ・ {formatBytes(result.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, result.name)} />
        </div>
      )}
    </div>
  );
}
