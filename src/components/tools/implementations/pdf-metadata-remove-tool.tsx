"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  PdfMetadataRemoveProcessor,
  readPdfMetadata,
  type PdfMetadataInfo,
  type PdfMetadataRemoveOutput,
} from "@/lib/processors/browser/pdf";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const FIELD_LABELS: { key: keyof PdfMetadataInfo; label: string }[] = [
  { key: "title", label: "タイトル" },
  { key: "author", label: "作成者" },
  { key: "subject", label: "件名" },
  { key: "keywords", label: "キーワード" },
  { key: "creator", label: "アプリケーション" },
  { key: "producer", label: "PDF変換ツール" },
];

/**
 * PDFメタデータ削除（Phase 8）。
 * 削除前に現在のメタデータを表示し、削除後は実際に保存済みPDFを再読み込み
 * した結果（remainingMetadata）を表示する。「削除できたことにする」のではなく、
 * 実測値をそのまま見せる（開発指示書■8）。
 */
export function PdfMetadataRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [before, setBefore] = useState<PdfMetadataInfo | null>(null);
  const [beforeError, setBeforeError] = useState<string | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfMetadataRemoveOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBefore(null);
      setBeforeError(null);
      return;
    }
    let cancelled = false;
    setBefore(null);
    setBeforeError(null);
    setResult(null);
    setError(null);
    setStatus("idle");
    readPdfMetadata(file)
      .then((info) => {
        if (!cancelled) setBefore(info);
      })
      .catch((e) => {
        if (!cancelled) setBeforeError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfMetadataRemoveProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-no-metadata.pdf` : "no-metadata.pdf";
  const hasAnyBeforeValue = before ? FIELD_LABELS.some((f) => before[f.key]) : false;
  const hasAnyRemainingValue = result ? FIELD_LABELS.some((f) => result.remainingMetadata[f.key]) : false;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        このツールはPDFの標準的な文書情報（タイトル・作成者・件名・キーワード・アプリケーション・PDF変換ツール）を削除します。
        一部のPDF編集ソフトが別途埋め込むことがあるメタデータ（XMPメタデータ等）については、削除できるとは限りません。「完全に匿名化される」ことを保証するものではないため、機密性の高いファイルは内容自体も併せてご確認ください。
      </div>

      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {beforeError && <ErrorMessage message={beforeError} />}

      {before && (
        <div className="rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <p className="mb-2 font-medium text-neutral-700 dark:text-neutral-200">現在のメタデータ</p>
          {hasAnyBeforeValue ? (
            <ul className="flex flex-col gap-1 text-neutral-600 dark:text-neutral-300">
              {FIELD_LABELS.filter((f) => before[f.key]).map((f) => (
                <li key={f.key} className="flex gap-2">
                  <span className="w-32 shrink-0 text-neutral-400">{f.label}</span>
                  <span className="break-all">{before[f.key]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-400">標準的なメタデータは設定されていません。</p>
          )}
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

      <ProcessingStatus state={status} successLabel="メタデータの削除が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">削除後の確認結果</p>
          {hasAnyRemainingValue ? (
            <ul className="flex flex-col gap-1 text-sm text-red-600 dark:text-red-400">
              {FIELD_LABELS.filter((f) => result.remainingMetadata[f.key]).map((f) => (
                <li key={f.key}>
                  {f.label}: {result.remainingMetadata[f.key]}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-green-700 dark:text-green-400">
              標準的なメタデータがすべて削除されたことを確認しました。
            </p>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{formatBytes(result.sizeBytes)}</p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
