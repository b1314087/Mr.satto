"use client";

import { useEffect, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { ImageConvertProcessor } from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { useObjectUrl } from "@/components/tools/implementations/shared/image-live-preview";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import {
  CONVERT_FORMATS,
  detectConvertFormat,
  formatLabel,
  outputFileNames,
  sizeChangePercent,
  splitByFormat,
  transparencyNote,
  type ConvertFormat,
} from "@/lib/image-format-convert";

/**
 * 画像形式変換の共通画面（JPG変換・PNG変換・WebP変換・画像一括変換の4ページで共用）。
 * ページごとに、出力形式の初期選択（initialFormat）だけが違う。変換はすべてブラウザの中で行い、画像は送信しない。
 * 変換そのものは既存の ImageConvertProcessor を使う（プレビューと書き出しで同じ処理）。
 */

type FileResult =
  | { file: File; status: "ok"; output: ImageProcessorOutput }
  | { file: File; status: "error"; message: string }
  | { file: File; status: "skipped" };

/** 変換した結果が、選んだ形式で書き出せているか（ブラウザが非対応の形式だと、別の形式になることがある） */
function ensureFormat(output: ImageProcessorOutput, target: ConvertFormat): ImageProcessorOutput {
  if (output.mimeType !== target) {
    URL.revokeObjectURL(output.url);
    throw new Error(`お使いのブラウザは${formatLabel(target)}形式の書き出しに対応していません。別の形式を選ぶか、別のブラウザでお試しください。`);
  }
  return output;
}

export function ImageFormatConvertTool({ initialFormat = "image/jpeg" }: { initialFormat?: ConvertFormat }) {
  const [files, setFiles] = useState<File[]>([]);
  const [targetFormat, setTargetFormat] = useState<ConvertFormat>(initialFormat);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultLabel, setResultLabel] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("images.zip");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const target = formatLabel(targetFormat);
  const { convertible, sameFormat } = splitByFormat(files, targetFormat);
  const allSameFormat = files.length > 0 && convertible.length === 0;

  // --- プレビュー: 選んだ画像を、選んだ形式へ実際に変換した結果（書き出しと同じ ImageConvertProcessor） ---
  const previewFile = files[Math.min(selectedIndex, Math.max(files.length - 1, 0))] ?? null;
  const previewIsSame = previewFile ? detectConvertFormat(previewFile) === targetFormat : false;
  const originalUrl = useObjectUrl(previewFile);
  const [converted, setConverted] = useState<
    { file: File; format: ConvertFormat; output: ImageProcessorOutput } | { file: File; format: ConvertFormat; error: string } | null
  >(null);
  useEffect(() => {
    if (!previewFile || previewIsSame) return;
    let cancelled = false;
    const holder: { output: ImageProcessorOutput | null } = { output: null };
    new ImageConvertProcessor()
      .process({ file: previewFile, mimeType: targetFormat })
      .then((output) => ensureFormat(output, targetFormat))
      .then(
        (output) => {
          if (cancelled) {
            URL.revokeObjectURL(output.url);
            return;
          }
          holder.output = output;
          setConverted({ file: previewFile, format: targetFormat, output });
        },
        (e) => {
          if (!cancelled) {
            setConverted({ file: previewFile, format: targetFormat, error: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
          }
        }
      );
    return () => {
      cancelled = true;
      if (holder.output) URL.revokeObjectURL(holder.output.url);
    };
  }, [previewFile, previewIsSame, targetFormat]);
  const current = previewFile && converted && converted.file === previewFile && converted.format === targetFormat ? converted : null;
  const convertedOutput = current && "output" in current ? current.output : null;
  const convertedError = current && "error" in current ? current.error : null;
  const previewPercent = previewFile && convertedOutput ? sizeChangePercent(previewFile.size, convertedOutput.sizeBytes) : null;
  const previewSource = previewFile ? detectConvertFormat(previewFile) : null;

  function clearResults() {
    setResults(null);
    setResultBlob(null);
    setResultLabel(null);
    setStatus("idle");
    setError(null);
  }

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    clearResults();
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex((i) => (index < i ? i - 1 : i));
    clearResults();
  }

  function chooseFormat(format: ConvertFormat) {
    setTargetFormat(format);
    // 形式を変えたら、前の形式で作った結果は使えない
    clearResults();
  }

  async function handleRun() {
    if (convertible.length === 0) return;
    setStatus("processing");
    setError(null);
    setResultBlob(null);
    try {
      const names = outputFileNames(
        convertible.map((f) => f.name),
        targetFormat
      );
      const done: FileResult[] = [];
      const entries: { name: string; blob: Blob }[] = [];
      const byFile = new Map<File, FileResult>();
      for (let i = 0; i < convertible.length; i++) {
        const file = convertible[i];
        try {
          const output = ensureFormat(await new ImageConvertProcessor().process({ file, mimeType: targetFormat }), targetFormat);
          // 結果の一覧には容量だけを使う（画像のURLは持たない）。メモリを抱え続けないよう、すぐ解放する
          URL.revokeObjectURL(output.url);
          byFile.set(file, { file, status: "ok", output });
          entries.push({ name: names[i], blob: output.blob });
        } catch (e) {
          byFile.set(file, { file, status: "error", message: e instanceof Error ? e.message : "変換に失敗しました" });
        }
      }
      for (const f of files) done.push(byFile.get(f) ?? { file: f, status: "skipped" });
      setResults(done);

      if (entries.length === 0) {
        setError("変換できた画像がありませんでした。各画像の理由を確認してください。");
        setStatus("error");
        return;
      }
      const failed = done.filter((r) => r.status === "error").length;
      const failedNote = failed > 0 ? `（${failed}件は変換できませんでした）` : "";
      if (entries.length === 1) {
        setResultBlob(entries[0].blob);
        setDownloadName(entries[0].name);
        setResultLabel(`1件を${target}形式に変換しました${failedNote}`);
      } else {
        setResultBlob(await createZip(entries));
        setDownloadName(`${stripExtension(convertible[0].name) || "images"}-batch.zip`);
        setResultLabel(`${entries.length}件を${target}形式に変換し、ZIPにまとめました${failedNote}`);
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        previewFile ? (
          <div data-testid="tool-preview" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー</p>
            {files.length > 1 && (
              <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                プレビューする画像（{files.length}枚から選択）
                <select
                  data-testid="convert-preview-select"
                  value={Math.min(selectedIndex, files.length - 1)}
                  onChange={(e) => setSelectedIndex(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {files.map((f, i) => (
                    <option key={`${f.name}-${i}`} value={i}>
                      {i + 1}. {f.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {previewIsSame && (
              <p data-testid="convert-same-format" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                この画像はすでに{target}形式のため、変換しません。別の形式を選んでください。
              </p>
            )}
            {convertedError && <ErrorMessage message={convertedError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <figure className="flex min-w-0 flex-col gap-1">
                <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                  元の画像 ・ {previewSource ? formatLabel(previewSource) : previewFile.type.replace("image/", "").toUpperCase() || "不明"} ・ {formatBytes(previewFile.size)}
                </figcaption>
                {originalUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={originalUrl}
                    alt="変換前の画像"
                    className="max-h-64 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                  />
                )}
              </figure>
              <figure className="flex min-w-0 flex-col gap-1">
                <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                  {target}に変換後{convertedOutput ? ` ・ ${formatBytes(convertedOutput.sizeBytes)}` : ""}
                </figcaption>
                {previewIsSame ? (
                  <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                    変換しません
                  </div>
                ) : convertedOutput ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={convertedOutput.url}
                    alt="変換後の画像"
                    className="max-h-64 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                  />
                ) : (
                  !convertedError && (
                    <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                      変換しています...
                    </div>
                  )
                )}
              </figure>
            </div>
            {convertedOutput && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {convertedOutput.width} × {convertedOutput.height}px ・ {formatBytes(previewFile.size)} → {formatBytes(convertedOutput.sizeBytes)}
                {previewPercent !== null && previewPercent !== 0 ? `（${previewPercent > 0 ? "+" : ""}${previewPercent}%）` : ""}
                {transparencyNote(previewSource, targetFormat) ? " ・ 透過部分は白になります" : ""}
              </p>
            )}
            {files.length > 1 && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">ほかの{files.length - 1}枚も同じ形式で変換されます。</p>
            )}
          </div>
        ) : null
      }
    >
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={50}
        label="画像をドラッグ&ドロップ（複数可）"
        hint="またはタップして選択（JPG・PNG・WebPなど。1ファイル50MBまで）"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}

      {files.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変換先の形式</p>
          <div role="group" aria-label="変換先の形式" className="flex flex-wrap gap-2">
            {CONVERT_FORMATS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={targetFormat === opt.value}
                data-testid={`convert-format-${opt.ext}`}
                onClick={() => chooseFormat(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  targetFormat === opt.value ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {sameFormat.length > 0 && !allSameFormat && (
            <p data-testid="convert-skip-note" className="text-xs text-amber-800 dark:text-amber-300">
              すでに{target}形式の{sameFormat.length}枚は、変換せずに除きます（変換するのは{convertible.length}枚です）。
            </p>
          )}
          {allSameFormat && (
            <p data-testid="convert-all-same" className="text-xs text-amber-800 dark:text-amber-300">
              選んだ画像はすべてすでに{target}形式です。別の形式を選んでください。
            </p>
          )}
        </div>
      )}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || convertible.length === 0}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {convertible.length}件を{target}に変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {results && (
        <ul data-testid="convert-results" className="flex flex-col gap-1.5 rounded-xl border border-neutral-200 p-3 text-xs dark:border-neutral-800">
          {results.map((r, i) => {
            const percent = r.status === "ok" ? sizeChangePercent(r.file.size, r.output.sizeBytes) : null;
            return (
              <li key={`${r.file.name}-${i}`} data-testid="convert-result" data-status={r.status} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 break-all font-medium text-neutral-800 dark:text-neutral-100">{r.file.name}</span>
                {r.status === "ok" && (
                  <span className="text-neutral-600 dark:text-neutral-300">
                    {formatBytes(r.file.size)} → {formatBytes(r.output.sizeBytes)}
                    {percent !== null && percent !== 0 ? `（${percent > 0 ? "+" : ""}${percent}%）` : ""}
                  </span>
                )}
                {r.status === "error" && <span className="text-red-700 dark:text-red-300">変換できませんでした：{r.message}</span>}
                {r.status === "skipped" && <span className="text-amber-800 dark:text-amber-300">すでに{target}形式のため、変換していません</span>}
                <button
                  type="button"
                  onClick={() => setSelectedIndex(i)}
                  className="rounded border border-neutral-300 px-2 py-0.5 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  前後を見る
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {resultBlob && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {resultLabel} ・ {formatBytes(resultBlob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(resultBlob, downloadName)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
