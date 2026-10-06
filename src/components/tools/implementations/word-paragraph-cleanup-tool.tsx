"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ParagraphCompare,
  ParagraphLegend,
  SpaceLegend,
  type ParagraphItem,
} from "@/components/tools/implementations/shared/paragraph-compare";
import { PreviewNotice, PreviewShell } from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { loadDocxPackage } from "@/lib/word/docx-text-ops";
import {
  WordParagraphCleanupProcessor,
  previewParagraphCleanup,
  type ParagraphCleanupOptions,
} from "@/lib/processors/browser/word-paragraph-cleanup";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const OPTION_ITEMS: { key: keyof ParagraphCleanupOptions; label: string }[] = [
  { key: "fullToHalfSpace", label: "全角スペースを半角に変換" },
  { key: "halfToFullSpace", label: "半角スペースを全角に変換" },
  { key: "collapseRepeatedSpaces", label: "連続するスペースを1つにまとめる" },
  { key: "collapseConsecutiveBlankLines", label: "連続する空白行を1行にまとめる" },
  { key: "removeBlankLines", label: "空白行をすべて削除する" },
];

const DEFAULT_OPTIONS: ParagraphCleanupOptions = {
  fullToHalfSpace: false,
  halfToFullSpace: false,
  collapseRepeatedSpaces: true,
  collapseConsecutiveBlankLines: true,
  removeBlankLines: false,
};

export function WordParagraphCleanupTool() {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<ParagraphCleanupOptions>(DEFAULT_OPTIONS);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    beforeText: string;
    afterText: string;
    removedParagraphCount: number;
  } | null>(null);

  // プレビュー: 出力と同じ整理処理(applyParagraphCleanup)を、読み込んだdocument.xmlに適用して段落を並べる
  const { data: pkg, error: previewError, loading } = useAsyncFileData(file, loadDocxPackage);
  const preview = useMemo(() => {
    if (!pkg) return null;
    try {
      const result = previewParagraphCleanup(pkg.documentXmlText, options);
      const before: ParagraphItem[] = result.paragraphs.map((p) => ({
        text: p.before,
        removed: p.after === null,
        changed: p.after !== null && p.after !== p.before,
      }));
      const after: ParagraphItem[] = result.paragraphs
        .filter((p) => p.after !== null)
        .map((p) => ({ text: p.after as string, changed: p.after !== p.before }));
      return { error: null as string | null, before, after, removed: result.removedParagraphCount };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "プレビューを作成できませんでした", before: [], after: [], removed: 0 };
    }
  }, [pkg, options]);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function toggleOption(key: keyof ParagraphCleanupOptions) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const hasAnyOption = Object.values(options).some(Boolean);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new WordParagraphCleanupProcessor().process({ file, options });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-cleaned.docx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={50}
        label="Wordファイル（.docx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">適用する整理内容を選択</p>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            {OPTION_ITEMS.map((item) => (
              <label key={item.key} className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={options[item.key]}
                  onChange={() => toggleOption(item.key)}
                />
                {item.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {file && (preview || previewError || loading) && (
        <PreviewShell
          title="整理後の文章プレビュー(選択に合わせて更新されます)"
          loading={loading}
          summary={preview && !preview.error && <span>削除される空白行: {preview.removed}行</span>}
          notes={["本文直下の段落のテキストを表示しています(表の中の文字は整形のみ反映され、ここには表示されません)。"]}
        >
          {previewError && <PreviewNotice message={previewError} />}
          {preview?.error && <PreviewNotice message={preview.error} />}
          {preview && !preview.error && (
            <>
              <ParagraphCompare before={preview.before} after={preview.after} beforeLabel="整理前" afterLabel="整理後" />
              <ParagraphLegend items={[{ kind: "changed", label: "文字が変わる段落" }, { kind: "removed", label: "削除される空白行" }]} />
              <SpaceLegend />
            </>
          )}
        </PreviewShell>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || !hasAnyOption}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          整理を実行する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="整理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除した空白行: {result.removedParagraphCount}行
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">変更前</p>
              <textarea
                value={result.beforeText}
                readOnly
                rows={10}
                className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">変更後</p>
              <textarea
                value={result.afterText}
                readOnly
                rows={10}
                className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
          </div>
          <div>
            <RewardedDownloadGate onDownload={handleDownload} label="Wordファイルをダウンロード" />
          </div>
        </div>
      )}
    </div>
  );
}
