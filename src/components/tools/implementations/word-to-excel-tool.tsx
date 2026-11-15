"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { RunBar } from "@/components/ui/run-bar";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { WordToExcelProcessor, readWordDocumentInfo, type WordDocumentInfo, type WordToExcelOutput } from "@/lib/office-convert/word-to-excel";
import { MAX_OFFICE_FILE_MB } from "@/lib/office-convert/file-check";
import { ConversionChecks } from "./office-convert-checks";
import { FilledPdfAiPanel, formAiEnabled } from "./filled-pdf-to-excel/ai-panel";

/**
 * Word→Excel変換。Wordの表を、表ごとにExcelのシートにする（結合・書式・列の幅を引き継ぐ）。
 * 表以外の文章は「本文」のシートに入れる。処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 * 表になっていない文章は、プレミアムの「AIで表にする」補助で、列に分けた表にもできる（任意。利用者が内容を確認し、同意したときだけ、その文章をAIへ送る）。
 */
export function WordToExcelTool() {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<WordDocumentInfo | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WordToExcelOutput | null>(null);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    readWordDocumentInfo(file)
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
        setFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  function handleSelect(files: File[]) {
    setFile(files[0] ?? null);
    setInfo(null);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new WordToExcelProcessor().process({ file, onProgress: setProgress });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "変換に失敗しました");
      setStatus("error");
    } finally {
      setProgress("");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        表は表ごとに1つのシートになり、Excelで編集できるセルになります。表以外の文章は「本文」のシートに、段落ごとに入ります。
      </p>

      <FileDropzone
        compact={!!file}
        // .doc も選べるようにして、選ばれたときに「.docxで保存し直す」案内を出す（変換はしない）
        accept=".docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        maxSizeMB={MAX_OFFICE_FILE_MB}
        label="Word文書(.docx)をドラッグ&ドロップ"
        hint={`またはタップして選択（上限${MAX_OFFICE_FILE_MB}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => handleSelect([])} />}

      {file && !info && !error && <p className="text-xs text-neutral-400">文書を読み込んでいます…</p>}

      {info && (
        <section aria-label="変換する表" className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="word-to-excel-tables">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {info.tables.length > 0 ? `文書の中の表（${info.tables.length}個）と、変換後のシート` : "この文書には表がありません（文章を「本文」のシートに入れます）"}
          </p>
          {info.tables.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs text-neutral-700 dark:text-neutral-200">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-700">
                    <th className="py-1 pr-3 font-medium">表</th>
                    <th className="py-1 pr-3 font-medium">大きさ</th>
                    <th className="py-1 pr-3 font-medium">結合</th>
                    <th className="py-1 font-medium">シート名</th>
                  </tr>
                </thead>
                <tbody>
                  {info.tables.map((t) => (
                    <tr key={t.index} className="border-b border-neutral-100 dark:border-neutral-800" data-testid="word-to-excel-table-row">
                      <td className="py-1 pr-3">表{t.index}</td>
                      <td className="py-1 pr-3">
                        {t.rows}行×{t.cols}列{t.joinedWithPrevious > 0 ? `（分かれていた表を${t.joinedWithPrevious + 1}つつなげます）` : ""}
                      </td>
                      <td className="py-1 pr-3">{t.merges > 0 ? `${t.merges}か所` : "なし"}</td>
                      <td className="py-1">「{t.sheetName}」</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(info.paragraphCount > 0 || info.textBoxCount > 0) && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              表以外の文章（{info.paragraphCount}段落{info.textBoxCount > 0 ? `・テキストボックス${info.textBoxCount}個` : ""}）は「本文」のシートに入ります。
            </p>
          )}
        </section>
      )}

      {info && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            Excelに変換する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel={progress || "変換しています…"} successLabel="Excelファイルができました" />
      {error && <ErrorMessage message={error} />}

      {/* 表になっていない文章を、AIで列に分けて表にする（プレミアム・任意）。表以外の文章があるときだけ出す */}
      {file && info && (info.paragraphCount > 0 || info.textBoxCount > 0) && formAiEnabled() && (
        <FilledPdfAiPanel files={[file]} totalPages={null} purpose="word" />
      )}

      {result && (
        <ResultPopup>
          <div className="flex flex-col gap-3" data-testid="word-to-excel-result">
            <ConversionChecks checks={result.checks} warnings={result.warnings} />
            <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
          </div>
        </ResultPopup>
      )}
    </div>
  );
}
