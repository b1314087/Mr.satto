"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import {
  FileInspectorProcessor,
  type FileInspectorOutput,
} from "@/lib/processors/browser/file-inspector";
import { formatBytes } from "@/lib/utils/format";

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString("ja-JP");
  } catch {
    return "-";
  }
}

const HEAD_BYTES = 32;

/** 先頭バイトの16進ダンプ（ファイルの先頭 HEAD_BYTES バイトだけを読む） */
function formatHeadBytes(bytes: Uint8Array): { hex: string; ascii: string } {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const ascii = Array.from(bytes)
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");
  return { hex, ascii };
}

function ImageThumb({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- ブラウザ内で生成したObject URLのため next/image は不要
    <img src={url} alt={`${file.name} のサムネイル`} className="max-h-48 max-w-full rounded-lg border border-neutral-200 bg-white object-contain dark:border-neutral-700" />
  );
}

/**
 * ファイル情報確認（Phase 8）。
 * ファイルを選択するだけで、名前・種類・サイズ・更新日時に加え、
 * 画像なら幅×高さ、PDFならページ数、CSV/TXTなら行数（CSVは列数も）を表示する。
 */
export function FileInspectorTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FileInspectorOutput | null>(null);

  // 先頭バイトはファイルごとに紐づけて保持し、表示時に現在のファイルと照合する
  const [head, setHead] = useState<{ file: File; bytes: Uint8Array } | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    file
      .slice(0, HEAD_BYTES)
      .arrayBuffer()
      .then((buf) => {
        if (!cancelled) setHead({ file, bytes: new Uint8Array(buf) });
      })
      .catch(() => {
        // 読み込めなければ先頭バイトの表示だけ省略する
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const headDump = file && head && head.file === file ? formatHeadBytes(head.bytes) : null;
  const isImage = !!file && file.type.startsWith("image/");
  const isPdf = !!file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));

  async function handleSelect(files: File[]) {
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setError(null);
    setStatus("processing");
    try {
      const output = await new FileInspectorProcessor().process({ file: selected });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイル情報の取得に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        maxSizeMB={200}
        label="ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（形式は問いません）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => { setFile(null); setResult(null); setStatus("idle"); }} />}

      <ProcessingStatus state={status} processingLabel="情報を確認中..." successLabel="確認が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div data-testid="tool-preview" className="flex flex-col gap-4">
          {isImage && file && <ImageThumb file={file} />}
          {isPdf && file && <PdfThumbnails file={file} maxPages={1} pages={[1]} width={160} title="1ページ目のプレビュー" />}
          <dl className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm sm:grid-cols-2 dark:border-neutral-800 dark:bg-neutral-900">
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">ファイル名</dt>
              <dd className="break-all font-medium text-neutral-800 dark:text-neutral-100">{result.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">種類（MIME）</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.mimeType}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">拡張子</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.extension || "(なし)"}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">サイズ</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{formatBytes(result.sizeBytes)}</dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">最終更新日時</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                {formatDate(result.lastModifiedMs)}
              </dd>
            </div>

            {result.imageDimensions && (
              <div>
                <dt className="text-xs text-neutral-500 dark:text-neutral-400">画像サイズ</dt>
                <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                  {result.imageDimensions.width} × {result.imageDimensions.height}px
                </dd>
              </div>
            )}

            {result.pdfPageCount !== null && (
              <div>
                <dt className="text-xs text-neutral-500 dark:text-neutral-400">ページ数</dt>
                <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.pdfPageCount}ページ</dd>
              </div>
            )}

            {result.textInfo && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-neutral-500 dark:text-neutral-400">内容の集計</dt>
                <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                  {result.textInfo.skippedLargeFile
                    ? "ファイルサイズが大きいため、行数・列数の集計はスキップしました。"
                    : result.textInfo.columns !== null
                      ? `${result.textInfo.lines}行 ・ ${result.textInfo.columns}列`
                      : `${result.textInfo.lines}行`}
                </dd>
              </div>
            )}
          </dl>
          {headDump && (
            <div className="flex flex-col gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-xs dark:border-neutral-800 dark:bg-neutral-900">
              <p className="text-neutral-500 dark:text-neutral-400">先頭 {HEAD_BYTES} バイト</p>
              <code className="break-all font-mono text-neutral-700 dark:text-neutral-200">{headDump.hex}</code>
              <code className="break-all font-mono text-neutral-500 dark:text-neutral-400">{headDump.ascii}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
