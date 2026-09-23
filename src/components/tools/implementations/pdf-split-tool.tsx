"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfSplitProcessor, getPdfPageCount } from "@/lib/processors/browser/pdf";
import type { NamedFileOutput } from "@/lib/processors/types";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

type SplitMode = "each-page" | "range";

/** "1-3,5,8-10" のような文字列を {start,end}[] に変換する */
function parseRanges(text: string, totalPages: number): { start: number; end: number }[] {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("ページ範囲を入力してください（例: 1-3,5,8-10）");
  }
  return parts.map((part) => {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`ページ範囲の指定が正しくありません（"${part}"）`);
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start || end > totalPages) {
      throw new Error(
        `ページ範囲の指定が正しくありません（1〜${totalPages}の範囲で指定してください）`
      );
    }
    return { start, end };
  });
}

export function PdfSplitTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [mode, setMode] = useState<SplitMode>("each-page");
  const [rangeText, setRangeText] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<NamedFileOutput[] | null>(null);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);

  useEffect(() => {
    if (!file) {
      // ファイル選択が解除された際に関連stateをリセットする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPageCount(null);
      return;
    }
    let cancelled = false;
    setPageCount(null);
    setResult(null);
    setError(null);
    setStatus("idle");
    getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCount(count);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  function setResult(next: NamedFileOutput[] | null) {
    setOutputs(next);
    setZipBlob(null);
  }

  async function handleRun() {
    if (!file || !pageCount) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const result =
        mode === "each-page"
          ? await new PdfSplitProcessor().process({ file, mode: "each-page" })
          : await new PdfSplitProcessor().process({
              file,
              mode: "range",
              ranges: parseRanges(rangeText, pageCount),
            });
      setOutputs(result);
      if (result.length > 1) {
        const zip = await createZip(result.map((r) => ({ name: r.suggestedName, blob: r.blob })));
        setZipBlob(zip);
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!outputs) return;
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].suggestedName);
    } else if (zipBlob && file) {
      downloadBlob(zipBlob, `${stripExtension(file.name)}-split.zip`);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && pageCount !== null && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            このPDFは{pageCount}ページです
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("each-page")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                mode === "each-page"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              1ページごとに分割
            </button>
            <button
              type="button"
              onClick={() => setMode("range")}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                mode === "range"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              ページ範囲を指定
            </button>
          </div>
          {mode === "range" && (
            <label className="flex flex-col gap-1 text-sm">
              ページ範囲（カンマ区切りで複数指定可）
              <input
                type="text"
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                placeholder="例: 1-3,5,8-10"
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          )}
        </div>
      )}

      {file && pageCount !== null && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          分割する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="分割が完了しました" />
      {error && <ErrorMessage message={error} />}

      {outputs && outputs.length > 0 && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="w-full text-xs text-neutral-600 dark:text-neutral-300">
            {outputs.slice(0, 20).map((o) => (
              <li key={o.suggestedName} className="flex justify-between gap-2 border-b border-neutral-200 py-1 last:border-none dark:border-neutral-800">
                <span className="truncate">{o.suggestedName}</span>
                <span className="shrink-0 text-neutral-400">{formatBytes(o.sizeBytes)}</span>
              </li>
            ))}
            {outputs.length > 20 && (
              <li className="py-1 text-neutral-400">他{outputs.length - 20}件…</li>
            )}
          </ul>
          <RewardedDownloadGate
            onDownload={handleDownload}
            disabled={outputs.length > 1 && !zipBlob}
            label={outputs.length === 1 ? "ダウンロード" : "ZIPでダウンロード"}
          />
        </div>
      )}
    </div>
  );
}
