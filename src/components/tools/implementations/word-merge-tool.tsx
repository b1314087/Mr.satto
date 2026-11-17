"use client";

import { useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { fileKey as fileIdentity, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { MAX_DOCX_MERGE_FILES, MAX_DOCX_MERGE_MB, mergeDocx } from "@/lib/office-merge/docx-merge";

/**
 * Word結合（2026-11-17）。
 * 複数の Word（.docx）を、選んだ順に1つの Word にまとめる。
 * 文字を取り出して作り直すのではなく、ファイルの中身（本文・表・画像・ヘッダー/フッター・セクション）をそのままつなげる。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const fileKeys = new WeakMap<File, number>();
let nextFileKey = 1;
function fileKey(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = nextFileKey++;
    fileKeys.set(file, key);
  }
  return key;
}

interface MergeOutput {
  blob: Blob;
  notices: string[];
}

export function WordMergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);
  const [pageNumbers, setPageNumbers] = useState<"continue" | "restart">("continue");

  const settingKey = files.length > 0 ? `${files.map((f) => `${fileKey(f)}:${fileIdentity(f)}`).join("|")}#${pageNumbers}` : "";
  const run = useKeyedRun<MergeOutput>(settingKey);
  const result = run.value;
  const error = run.error ?? inputError;
  const status = run.status;

  function addFiles(picked: File[]) {
    const ok: File[] = [];
    const rejected: string[] = [];
    for (const f of picked) {
      if (/\.docx$/i.test(f.name)) ok.push(f);
      else rejected.push(f.name);
    }
    const room = Math.max(0, MAX_DOCX_MERGE_FILES - files.length);
    if (rejected.length > 0) {
      setInputError(`Word（.docx）以外のファイルは結合できません：${rejected.join("、")}（古い形式の .doc は、先に「Word旧形式→新形式」で .docx に変換してください）`);
    } else if (ok.length > room) {
      setInputError(`一度に結合できるのは${MAX_DOCX_MERGE_FILES}ファイルまでです。`);
    } else {
      setInputError(null);
    }
    if (ok.length === 0 || room === 0) return;
    setFiles((prev) => [...prev, ...ok.slice(0, room)]);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleRun() {
    if (files.length < 2) return;
    const targets = files;
    const restart = pageNumbers === "restart";
    void run.run(async () => {
      const inputs = await Promise.all(targets.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const out = await mergeDocx(inputs, { restartPageNumbers: restart });
      return { blob: new Blob([out.bytes as BlobPart], { type: DOCX_MIME }), notices: out.notices };
    });
  }

  const downloadName = files[0] ? `${stripExtension(files[0].name)}_結合.docx` : "結合.docx";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        files.length > 0 ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">結合する順番（上から順に結合）</p>
            <ol className="flex flex-col gap-2">
              {files.map((file, index) => (
                <li
                  key={fileKey(file)}
                  className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white/70 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900/50"
                >
                  <span className="inline-block shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">{index + 1}</span>
                  <span className="min-w-0 truncate" title={file.name}>
                    {file.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-neutral-500">{formatBytes(file.size)}</span>
                </li>
              ))}
            </ol>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">各ファイルは、新しいページから始まります（用紙・余白・ヘッダー/フッターはファイルごとに保ちます）。</p>
          </div>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            Wordのファイルを選ぶと、ここに結合する順番が表示されます
          </div>
        )
      }
    >
      <FileDropzone
        compact={files.length > 0}
        compactAction="add"
        accept={`${DOCX_MIME},.docx`}
        multiple
        maxSizeMB={MAX_DOCX_MERGE_MB}
        label="Word（.docx）をドラッグ&ドロップ（複数可）"
        hint={`またはタップして選択（上限${MAX_DOCX_MERGE_MB}MB）`}
        onFilesSelected={addFiles}
        onError={setInputError}
      />

      {files.length > 0 && <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />}

      {files.length > 0 && files.length < 2 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">結合するには、もう1つ以上Wordのファイルを追加してください。</p>
      )}

      {files.length >= 2 && (
        <Segmented
          value={pageNumbers}
          onChange={setPageNumbers}
          label="ページ番号"
          size="sm"
          testId="word-merge-page-numbers"
          options={[
            { value: "continue", label: "続けて振る" },
            { value: "restart", label: "ファイルごとに1から" },
          ]}
        />
      )}

      {files.length >= 2 && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid="word-merge-run"
          >
            {files.length}件のWordを結合する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel="結合が完了しました" />
      {error && <ErrorMessage message={error} testId="word-merge-error" />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {files.length}ファイルを結合 ・ {formatBytes(result.blob.size)}
          </p>
          {result.notices.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-600 dark:text-neutral-300" data-testid="word-merge-notices">
              {result.notices.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
