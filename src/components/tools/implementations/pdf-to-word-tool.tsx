"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { PdfToWordProcessor, previewPdfToWordBlocks, type PdfToWordOutput } from "@/lib/processors/browser/pdf-to-word";
import type { DocumentBlock, RunInfo } from "@/lib/pdf/paragraph-reconstruction";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

/** プレビューに出す先頭ページのブロック数の上限(重くならないよう先頭だけ) */
const PREVIEW_MAX_BLOCKS = 30;

type WordPreview =
  | { file: File; hasTextLayer: boolean; blocks: DocumentBlock[] }
  | { file: File; error: string };

/** 書式つきの文字列（太字・斜体・色・リンク）をプレビュー用に表示する */
function PreviewRuns({ runs, text }: { runs?: RunInfo[]; text: string }) {
  if (!runs || runs.length === 0) return <>{text}</>;
  return (
    <>
      {runs.map((r, i) => (
        <span
          key={i}
          style={{
            fontWeight: r.bold ? 700 : undefined,
            fontStyle: r.italic ? "italic" : undefined,
            color: r.link ? "#0563C1" : r.color ? `#${r.color}` : undefined,
            textDecoration: r.link ? "underline" : undefined,
          }}
        >
          {r.text}
        </span>
      ))}
    </>
  );
}

const ALIGN_CLASS = { left: "text-left", center: "text-center", right: "text-right" } as const;

/** 変換後のWord文書の先頭ページのイメージ(見出し・段落・リスト・表を、変換と同じ構造推定で表示) */
function WordPagePreview({ blocks }: { blocks: DocumentBlock[] }) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-md border border-neutral-200 bg-white p-4 text-neutral-800 shadow-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100">
      {blocks.slice(0, PREVIEW_MAX_BLOCKS).map((b, i) => {
        if (b.type === "heading1" || b.type === "heading2") {
          const cls = `${ALIGN_CLASS[b.align ?? "left"]} ${b.type === "heading1" ? "text-lg" : "text-base"} mb-2 font-bold`;
          return b.type === "heading1" ? (
            <h3 key={i} className={cls}>{b.text}</h3>
          ) : (
            <h4 key={i} className={cls}>{b.text}</h4>
          );
        }
        if (b.type === "table") {
          return (
            <div key={i} className="mb-2 overflow-x-auto">
              <table className="border-collapse text-xs">
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c} className="border border-neutral-300 px-2 py-1 dark:border-neutral-600">{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.type === "list") {
          return (
            <p
              key={i}
              className="mb-1 flex gap-2 text-sm"
              style={{ paddingLeft: `${b.level * 1.25}rem` }}
            >
              <span aria-hidden="true">{b.ordered ? b.marker : "•"}</span>
              <span className="min-w-0 break-words">
                <PreviewRuns runs={b.runs} text={b.text} />
              </span>
            </p>
          );
        }
        if (b.type === "image") {
          return (
            <p key={i} className="mb-2 text-xs text-neutral-400">
              [画像]
            </p>
          );
        }
        if (b.type !== "paragraph") return null;
        return (
          <p
            key={i}
            className={`mb-2 min-h-[1em] whitespace-pre-wrap break-words text-sm ${ALIGN_CLASS[b.align ?? "left"]}`}
            style={b.indent ? { paddingLeft: `${Math.min(b.indent, 120) / 12}rem` } : undefined}
          >
            <PreviewRuns runs={b.runs} text={b.text} />
          </p>
        );
      })}
      {blocks.length > PREVIEW_MAX_BLOCKS && <p className="text-xs text-neutral-400">…(以降は省略)</p>}
    </div>
  );
}

/**
 * PDF→Word（Phase 2-D）。
 *
 * 「PDFの見た目を100%再現すること」ではなく「編集しやすいWord文書に
 * 変換すること」を目的にしている（開発指示書の優先順位に明記）。
 * 2段組・特殊フォント・画像などを含む複雑なレイアウトは、そのままの
 * 見た目では再現されない場合がある旨をUIで明示する。
 */
export function PdfToWordTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfToWordOutput | null>(null);
  const [progressLabel, setProgressLabel] = useState("");

  // ファイルを選んだ時点で、先頭ページの文字から作られるWord文書の見た目をプレビューする
  const [preview, setPreview] = useState<WordPreview | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    previewPdfToWordBlocks(file)
      .then((o) => {
        if (!cancelled) setPreview({ file, hasTextLayer: o.hasTextLayer, blocks: o.blocks });
      })
      .catch((e) => {
        if (!cancelled) setPreview({ file, error: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);
  const currentPreview = file && preview && preview.file === file ? preview : null;

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgressLabel("解析中...");

    try {
      const output = await new PdfToWordProcessor().process({
        file,
        onPageProgress: (info) => {
          if (info.method === "ocr") {
            setProgressLabel(
              `ページを画像認識(OCR)中 ${info.currentPage} / ${info.totalPages}（${Math.round((info.ocrProgress ?? 0) * 100)}%）`
            );
          } else {
            setProgressLabel(`ページを解析中 ${info.currentPage} / ${info.totalPages}`);
          }
        },
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    } finally {
      setProgressLabel("");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.docx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">2段組・図形・特殊なフォントなど、複雑なレイアウトは再現されない場合があります。</p>

      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={50}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択（上限50MB）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div data-testid="tool-preview" className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <PdfThumbnails file={file} pages={[1]} maxPages={1} width={160} title="先頭ページ(元のPDF)" className="sm:shrink-0" />
          <section
            aria-label="変換後の文章のプレビュー"
            className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">Word文書のプレビュー</p>
            {!currentPreview ? (
              <p className="text-xs text-neutral-400">読み込み中…</p>
            ) : "error" in currentPreview ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{currentPreview.error}</p>
            ) : currentPreview.hasTextLayer ? (
              <WordPagePreview blocks={currentPreview.blocks} />
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                先頭ページに文字情報がないため(スキャン画像のPDFなど)、プレビューでは読み取りません。変換を実行すると画像認識で文字を読み取ります。
              </p>
            )}
          </section>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          Wordに変換する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progressLabel || "処理中..."}
        successLabel="Word文書の生成が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>ページ数: {result.pageCount}</span>
            <span>段落数: {result.paragraphCount}</span>
            <span>見出し数: {result.headingCount}</span>
            <span>表: {result.tableCount}個</span>
            {result.imageCount > 0 && <span>画像: {result.imageCount}個</span>}
            {result.listItemCount > 0 && <span>箇条書き: {result.listItemCount}項目</span>}
            <span>ファイルサイズ: {(result.sizeBytes / 1024).toFixed(1)} KB</span>
            {result.usedOcr && (
              <span>
                OCR使用{result.ocrConfidence !== null ? `（信頼度目安: ${Math.round(result.ocrConfidence)}%）` : ""}
              </span>
            )}
          </div>

          {result.usedOcr && (
            <div className="flex items-start gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
              <span>OCRで文字を読み取りました。誤認識がないか、変換後に確認してください。</span>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <span>複雑なレイアウトは、再現されていない場合があります。Wordで内容を確認してください。</span>
          </div>

          <RewardedDownloadGate onDownload={handleDownload} label="Word文書をダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
