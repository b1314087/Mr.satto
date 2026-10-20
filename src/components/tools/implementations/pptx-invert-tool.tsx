"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PptxInvertProcessor, type PptxInvertOutput } from "@/lib/processors/browser/pptx-invert";
import type { ImageOutcome, ImageReport } from "@/lib/pptx/invert-pptx";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

const ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

const OUTCOME_LABEL: Record<ImageOutcome, string> = {
  inverted: "白黒と判定 → 反転",
  "inverted-gray": "白黒が中心 → 白黒部分だけ反転",
  "kept-color": "カラーと判定 → そのまま",
  "kept-transparent": "透明な画像 → そのまま",
  unsupported: "この形式は反転できない → そのまま",
  "too-large": "大きすぎる → そのまま",
  failed: "読み込めない → そのまま",
  "skipped-option": "画像は反転しない設定 → そのまま",
};

function useBlobUrl(bytes: Uint8Array | undefined, mime: string | undefined): string | null {
  // 画像の表示用のURL。画面から外れたら解放する
  const url = useMemo(() => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime ?? "image/png" })) : null), [bytes, mime]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

function Thumb({ bytes, mime, label, dark }: { bytes?: Uint8Array; mime?: string; label: string; dark?: boolean }) {
  const url = useBlobUrl(bytes, mime);
  if (!bytes) return <div className="h-16 w-24 rounded border border-dashed border-neutral-300 dark:border-neutral-700" aria-hidden />;
  return (
    <figure className="flex flex-col items-center gap-1">
      {/* 透明な部分が分かるよう、背景に市松ではなく単色（元の色）を敷く */}
      <div className={`flex h-16 w-24 items-center justify-center overflow-hidden rounded border border-neutral-300 dark:border-neutral-700 ${dark ? "bg-neutral-500" : "bg-neutral-200"}`}>
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="max-h-full max-w-full object-contain" />
        )}
      </div>
      <figcaption className="text-[11px] text-neutral-500 dark:text-neutral-400">{label}</figcaption>
    </figure>
  );
}

function ImageRow({ image }: { image: ImageReport }) {
  const name = image.path.split("/").pop() ?? image.path;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800" data-testid="pptx-image-row" data-outcome={image.outcome}>
      <Thumb bytes={image.before} mime={image.mime} label="変換前" />
      {image.after ? <Thumb bytes={image.after} mime={image.mime} label="変換後" dark /> : null}
      <div className="min-w-0 text-xs">
        <p className="break-all font-medium text-neutral-800 dark:text-neutral-100">{name}</p>
        <p className="text-neutral-600 dark:text-neutral-300">{OUTCOME_LABEL[image.outcome]}</p>
        {image.coloredRatio !== undefined && (
          <p className="text-neutral-500 dark:text-neutral-400">
            {image.width}×{image.height}px ／ 色のついた部分 {(image.coloredRatio * 100).toFixed(1)}%
          </p>
        )}
      </div>
    </li>
  );
}

export function PptxInvertTool() {
  const [file, setFile] = useState<File | null>(null);
  const [invertImages, setInvertImages] = useState(true);
  const [brightenDarkText, setBrightenDarkText] = useState(false);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PptxInvertOutput | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setProgress("");
    setError(null);
    setResult(null);
    try {
      const output = await new PptxInvertProcessor().process({ file, options: { invertImages, brightenDarkText }, onProgress: setProgress });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result) return;
    downloadBlob(result.blob, result.suggestedName);
  }

  const imageSummary = useMemo(() => {
    if (!result) return null;
    const imgs = result.report.images;
    const inverted = imgs.filter((i) => i.outcome === "inverted" || i.outcome === "inverted-gray").length;
    return { total: imgs.length, inverted, kept: imgs.length - inverted };
  }, [result]);

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={150}
        label="PowerPointファイル（.pptx）をドラッグ&ドロップ"
        hint="またはタップして選択（元のファイルは変更されません）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => { setFile(null); setResult(null); setStatus("idle"); }} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={invertImages} onChange={(e) => setInvertImages(e.target.checked)} data-testid="pptx-option-images" />
            <span>
              白黒と判定できる画像も反転する
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">資料の図・スクリーンショット・白黒写真など。カラーの写真やイラストは、そのままです。</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={brightenDarkText} onChange={(e) => setBrightenDarkText(e.target.checked)} data-testid="pptx-option-brighten" />
            <span>
              濃い色の文字を明るくして、黒背景で読みやすくする
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">紺・濃い赤などの文字が、黒い背景に沈んで見えにくいときに使います（色味は残します）。</span>
            </span>
          </label>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          白黒を反転する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel={progress || "変換しています..."} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && imageSummary && (
        <div data-testid="tool-preview" className="flex flex-col items-start gap-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <dl className="grid w-full grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">スライド数</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100" data-testid="pptx-slide-count">{result.report.slideCount}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">反転した色</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.report.colors.inverted}か所</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">そのままの色</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.report.colors.kept}か所</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">画像（反転／全体）</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{imageSummary.inverted}／{imageSummary.total}</dd>
            </div>
          </dl>

          {result.report.images.length > 0 && (
            <div className="w-full">
              <h3 className="mb-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">画像の判定</h3>
              <ul className="flex flex-col gap-2">
                {result.report.images.map((img) => (
                  <ImageRow key={img.path} image={img} />
                ))}
              </ul>
            </div>
          )}

          {result.report.notes.length > 0 && (
            <div className="w-full" data-testid="pptx-notes">
              <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">確認してください</h3>
              <ul className="list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-300">
                {result.report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            変換後のファイル: {result.suggestedName}（{formatBytes(result.sizeBytes)}）。文字・図形・表・グラフは、PowerPointでそのまま編集できます。
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="PowerPointファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
