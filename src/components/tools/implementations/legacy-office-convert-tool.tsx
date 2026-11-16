"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { RunBar } from "@/components/ui/run-bar";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { ConversionChecks } from "./office-convert-checks";
import type { XlsToXlsxOutput } from "@/lib/office-convert/xls-to-xlsx";
import type { DocToDocxOutput } from "@/lib/office-convert/doc-to-docx";

/**
 * Office旧形式→新形式の変換（Excel：.xls→.xlsx／Word：.doc→.docx）。
 *
 * 拡張子を変えるだけではなく、古い形式の中身を読み取って、新しい形式で書き直す
 * （src/lib/office-convert/xls-to-xlsx.ts・doc-to-docx.ts）。書き出したあと、ファイルを開き直して中身の数を確かめ、
 * 引き継げなかったものがあれば、画面でお知らせする。処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

type Kind = "xls" | "doc";

const TEXT: Record<Kind, { accept: string; label: string; run: string; done: string; download: string; ext: string; intro: string }> = {
  xls: {
    accept: ".xls,application/vnd.ms-excel",
    label: "Excel旧形式のファイル(.xls)をドラッグ&ドロップ",
    run: ".xlsxに変換する",
    done: ".xlsxファイルができました",
    download: "Excelファイル(.xlsx)をダウンロード",
    ext: "xlsx",
    intro: "Excel 97〜2003形式（.xls）のファイルを、今のExcelの形式（.xlsx）に変換します。シート・セルの値・数式・書式・列の幅・行の高さ・セルの結合を引き継ぎます。",
  },
  doc: {
    accept: ".doc,application/msword",
    label: "Word旧形式の文書(.doc)をドラッグ&ドロップ",
    run: ".docxに変換する",
    done: ".docxファイルができました",
    download: "Word文書(.docx)をダウンロード",
    ext: "docx",
    intro: "Word 97〜2003形式（.doc）の文書を、今のWordの形式（.docx）に変換します。文字の書式・段落・スタイル・表・画像・ヘッダー・フッター・ページの設定を引き継ぎます。",
  },
};

const MAX_MB = 30;

export function LegacyOfficeConvertTool({ kind }: { kind: Kind }) {
  const t = TEXT[kind];
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [xlsResult, setXlsResult] = useState<XlsToXlsxOutput | null>(null);
  const [docResult, setDocResult] = useState<DocToDocxOutput | null>(null);
  const [preview, setPreview] = useState<{ state: "idle" | "loading" | "ready" | "error"; file?: File; message?: string }>({ state: "idle" });

  function handleSelect(files: File[]) {
    setFile(files[0] ?? null);
    setStatus("idle");
    setError(null);
    setXlsResult(null);
    setDocResult(null);
    setPreview({ state: "idle" });
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setXlsResult(null);
    setDocResult(null);
    setPreview({ state: "idle" });
    try {
      // 大きなファイルでも画面が固まらないよう、別の処理（Web Worker）で変換する
      const { convertLegacyXls, convertLegacyDoc } = await import("@/lib/office-convert/legacy-convert-client");
      if (kind === "xls") setXlsResult(await convertLegacyXls(file));
      else setDocResult(await convertLegacyDoc(file));
      setStatus("success");
    } catch (e) {
      const known = e instanceof Error && /^[^\x00-\x7F]/.test(e.message);
      setError(known ? (e as Error).message : "ファイルを読み取れませんでした。ファイルが壊れているか、対応していない形式の可能性があります。");
      setStatus("error");
    }
  }

  const blob = xlsResult?.blob ?? docResult?.blob ?? null;

  function handleDownload() {
    if (!file || !blob) return;
    downloadBlob(blob, `${stripExtension(file.name)}.${t.ext}`);
  }

  async function handlePreview() {
    if (!docResult) return;
    setPreview({ state: "loading" });
    try {
      const { WordToPdfProcessor } = await import("@/lib/processors/browser/word-to-pdf");
      const docxFile = new File([docResult.blob], "preview.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      const pdf = await new WordToPdfProcessor().process({ file: docxFile });
      setPreview({ state: "ready", file: new File([pdf.blob], "preview.pdf", { type: "application/pdf" }) });
    } catch (e) {
      setPreview({ state: "error", message: e instanceof Error ? e.message : "プレビューを作れませんでした" });
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid={`legacy-${kind}-tool`}>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t.intro}</p>

      <FileDropzone
        compact={!!file}
        accept={t.accept}
        maxSizeMB={MAX_MB}
        label={t.label}
        hint={`またはタップして選択（上限${MAX_MB}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => handleSelect([])} />}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid="legacy-convert-run"
          >
            {t.run}
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel="変換しています…" successLabel={t.done} />
      {error && <ErrorMessage message={error} testId="legacy-convert-error" />}

      {(xlsResult || docResult) && (
        <ResultPopup>
          <div className="flex flex-col gap-3" data-testid="legacy-convert-result">
            {xlsResult && (
              <ul className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
                {xlsResult.sheets.map((s) => (
                  <li key={s.name} data-testid="legacy-xls-sheet">
                    「{s.name}」{s.hidden ? "（非表示のシート）" : ""}：{s.rows.toLocaleString()}行×{s.cols}列・値{s.cells.toLocaleString()}個
                    {s.formulas ? `・数式${s.formulas.toLocaleString()}個` : ""}
                    {s.merges ? `・結合${s.merges}か所` : ""}
                  </li>
                ))}
              </ul>
            )}
            {docResult && (
              <p className="text-xs text-neutral-600 dark:text-neutral-300" data-testid="legacy-doc-summary">
                段落{docResult.summary.paragraphs.toLocaleString()}個・表{docResult.summary.tables}個・画像{docResult.summary.images}個・セクション{docResult.summary.sections}個
                {docResult.summary.footnotes ? `・脚注${docResult.summary.footnotes}個` : ""}
                {docResult.summary.headers ? "・ヘッダー／フッターあり" : ""}
              </p>
            )}
            <ConversionChecks checks={(xlsResult ?? docResult)!.checks} warnings={(xlsResult ?? docResult)!.warnings} />
            <RewardedDownloadGate onDownload={handleDownload} label={t.download} />
            {docResult && (
              <div className="flex flex-col gap-2">
                {preview.state !== "ready" && (
                  <button type="button" onClick={handlePreview} disabled={preview.state === "loading"} className="w-fit text-xs text-blue-700 underline disabled:opacity-50 dark:text-blue-300">
                    {preview.state === "loading" ? "ページのプレビューを作っています…" : "ページのプレビューを見る"}
                  </button>
                )}
                {preview.state === "error" && <p className="text-xs text-red-600">{preview.message}</p>}
                {preview.state === "ready" && preview.file && (
                  <>
                    <PdfThumbnails file={preview.file} maxPages={6} width={150} title="ページのプレビュー（先頭の6ページまで）" />
                    <p className="text-[11px] text-neutral-500">プレビューはブラウザの中で作った簡易的な表示です。Wordで開いたときと、文字の幅などの細部が違う場合があります。</p>
                  </>
                )}
              </div>
            )}
          </div>
        </ResultPopup>
      )}
    </div>
  );
}
