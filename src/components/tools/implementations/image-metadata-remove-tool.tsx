"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageMetadataRemoveProcessor, resolveMetadataRemoveOutputType } from "@/lib/processors/browser/image";
import { inspectImageMetadata, hasAnyMetadata, type ImageMetadataReport } from "@/lib/utils/image-metadata";
import { useObjectUrl } from "@/components/tools/implementations/shared/image-live-preview";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, replaceExtension } from "@/lib/utils/format";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const FORMAT_LABEL: Record<string, string> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WebP",
};

/** 取り除かれる情報の一覧(検出結果から作る) */
function buildMetadataRows(report: ImageMetadataReport): { label: string; present: boolean; detail?: string }[] {
  return [
    { label: "撮影日時", present: report.dateTime !== null, detail: report.dateTime ?? undefined },
    { label: "位置情報（GPS）", present: report.gps },
    { label: "カメラ・機種", present: report.camera !== null, detail: report.camera ?? undefined },
    { label: "編集ソフト", present: report.software !== null, detail: report.software ?? undefined },
    { label: "その他のEXIF情報", present: report.exif },
    { label: "XMP・IPTC（著作権・キャプション等）", present: report.xmp || report.iptc || report.textChunks },
    { label: "カラープロファイル（ICC）", present: report.icc },
  ];
}

function MetadataRows({ report }: { report: ImageMetadataReport }) {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {buildMetadataRows(report).map((row) => (
        <li key={row.label} className="flex items-baseline justify-between gap-3">
          <span className="text-neutral-600 dark:text-neutral-300">{row.label}</span>
          <span
            className={
              row.present
                ? "text-right font-medium text-amber-700 dark:text-amber-400"
                : "text-right text-neutral-400 dark:text-neutral-500"
            }
          >
            {row.present ? (row.detail ? `あり（${row.detail}）` : "あり") : "なし"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 画像メタデータ削除（Phase 8）。
 * Canvasに描き直して再エンコードすることで、EXIF等の付随データを持ち越さない
 * 新しいBlobを生成する。「完全に全メタデータを除去した」とは言い切らず、
 * 再エンコードにより別のバイト列になること・出力形式がJPEG/PNG/WebPの
 * いずれかになることをUI上で明示する（開発指示書■11・■44）。
 */
export function ImageMetadataRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // --- プレビュー: 画像と、取り除かれる情報(撮影日時・GPS等)の有無 ---
  const previewUrl = useObjectUrl(file);
  const [inspected, setInspected] = useState<{ file: File; report: ImageMetadataReport } | null>(null);
  const [inspectedResult, setInspectedResult] = useState<{ blob: Blob; report: ImageMetadataReport } | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    inspectImageMetadata(file).then(
      (report) => {
        if (!cancelled) setInspected({ file, report });
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [file]);
  // 書き出した後は、出力ファイルにも同じ検査をかけて「残っていないこと」を確認する
  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    inspectImageMetadata(result.blob).then(
      (report) => {
        if (!cancelled) setInspectedResult({ blob: result.blob, report });
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [result]);
  const report = file && inspected?.file === file ? inspected.report : null;
  const resultReport = result && inspectedResult?.blob === result.blob ? inspectedResult.report : null;
  const outputLabel = file ? FORMAT_LABEL[resolveMetadataRemoveOutputType(file.type)] : null;

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImageMetadataRemoveProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? replaceExtension(file.name, result ? EXT_BY_MIME[result.mimeType] ?? "png" : "png")
    : "no-metadata.png";

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        画像をCanvasに描き直してから再度書き出すことで、撮影日時・位置情報（GPS）などのEXIF情報を含む元のファイルのバイト列を使わない新しい画像を作成します。
        出力はJPG・PNG・WebPのいずれかになり、元の形式によっては形式が変わる場合があります。処理後の画像は元のファイルとは別のバイト列になるため、画質が完全に同一（ビット単位で同一）ではありません。
      </div>

      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={(files) => {
          setFile(files[0]);
          setResult(null);
          setError(null);
          setStatus("idle");
        }}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div
          data-testid="tool-preview"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（取り除かれる情報）</p>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="選択した画像"
                className="max-h-56 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
              />
            )}
            <div className="flex flex-col gap-2">
              {report ? (
                <>
                  <MetadataRows report={report} />
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {hasAnyMetadata(report)
                      ? "「あり」の情報は、書き出した画像には含まれなくなります。"
                      : "この画像からは、取り除く対象の情報は検出されませんでした。"}
                    出力形式: {outputLabel}
                  </p>
                </>
              ) : (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">情報を調べています...</p>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">
            代表的な情報(JPG・PNG・WebPのEXIF・XMP・IPTC・ICC等)を調べた結果で、すべてのメタデータを網羅するものではありません。
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
          メタデータを削除する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.url}
            alt="処理結果のプレビュー"
            className="max-h-64 rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)} ・ {result.mimeType}
          </p>
          {resultReport && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {hasAnyMetadata(resultReport)
                ? "書き出した画像にも一部の付随情報が検出されました（上記の検査結果は代表的な項目のみです）。"
                : "書き出した画像を検査し、撮影日時・GPS・EXIF等が含まれていないことを確認しました。"}
            </p>
          )}
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
