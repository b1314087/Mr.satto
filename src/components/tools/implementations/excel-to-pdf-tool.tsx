"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ExcelToPdfProcessor,
  readExcelSheets,
  type ExcelToPdfOutput,
  type OrientationOption,
  type FitOption,
  type RawExcelSheet,
} from "@/lib/processors/browser/excel-to-pdf";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import {
  PreviewGrid,
  PreviewShell,
  SheetTabs,
  toGridRows,
  xlsxRowsToText,
} from "@/components/tools/implementations/shared/before-after-table";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

/**
 * Excel（XLSX）→ PDF（Phase 9、Phase 18.2 B節で大幅改修）。
 *
 * 対応形式は.xlsxのみ（.xlsには非対応。read-excel-fileが安全に対応できることを
 * 確認できていないため）。数式は再計算せず保存済みの値を表示する。
 *
 * 「Excelの印刷設定でPDF保存した結果にできるだけ近づける」ことを目標に、
 * 印刷範囲・用紙サイズ・向き・余白・Fit to Page・拡大縮小・改ページ・
 * 非表示行列・セルの実際の罫線をExcelファイル自身から読み取って反映する
 * （開発指示書Phase 18.2 B節）。向き・ページの収め方は既定で「自動
 * （Excelの設定を優先）」とし、Excel側に情報が無い場合のみ以下の手動指定へ
 * フォールバックする。取得できないもの（結合セル・チャート・図形・数式の
 * 再計算結果・セルの塗りつぶし色等）は無理に再現しない。
 */
export function ExcelToPdfTool() {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<RawExcelSheet[] | null>(null);
  const [selectedSheets, setSelectedSheets] = useState<Set<string>>(new Set());
  const [orientation, setOrientation] = useState<OrientationOption>("auto");
  const [fitMode, setFitMode] = useState<FitOption>("auto");
  const [repeatHeaderRow, setRepeatHeaderRow] = useState(true);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExcelToPdfOutput | null>(null);
  const [loadingSheets, setLoadingSheets] = useState(false);

  async function handleSelect(files: File[]) {
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setSheets(null);
    setSelectedSheets(new Set());
    setLoadingSheets(true);
    try {
      const readSheets = await readExcelSheets(selected);
      setSheets(readSheets);
      setSelectedSheets(new Set(readSheets.map((s) => s.name)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      setFile(null);
    } finally {
      setLoadingSheets(false);
    }
  }

  // プレビュー: 変換前は読み込んだシートの中身(表)、変換後は生成したPDFの1ページ目を表示する(変換処理そのものは変更しない)
  const [tab, setTab] = useState(0);
  const resultPdf = useMemo(
    () => (result ? new File([result.blob], "converted-preview.pdf", { type: "application/pdf" }) : null),
    [result]
  );
  const previewIndex = sheets ? Math.min(tab, sheets.length - 1) : 0;
  const previewRows = useMemo(
    () => (sheets && sheets.length > 0 ? toGridRows(xlsxRowsToText(sheets[previewIndex].rows.slice(0, 10))) : null),
    [sheets, previewIndex]
  );

  function toggleSheet(name: string) {
    setSelectedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleRun() {
    if (!file || !sheets) return;
    setStatus("processing");
    setError(null);
    setResult(null);

    try {
      const output = await new ExcelToPdfProcessor().process({
        file,
        sheets,
        selectedSheetNames: Array.from(selectedSheets),
        orientation,
        fitMode,
        repeatHeaderRow,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.pdf`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          Excelファイル(.xlsx)をPDFに変換します。対応形式は.xlsxのみです（.xlsには対応していません）。
          数式は再計算せず、Excelに保存されている値をそのまま表示します。処理はブラウザ内で完結し、
          ファイルが外部のサーバーへ送信されることはありません。
        </p>
        <p>
          印刷範囲・用紙サイズ・向き・余白・列幅・改ページなどはExcelファイル自身に保存されている設定を
          できるだけ読み取って反映します（取得できない場合のみ下記の指定や自動推定にフォールバックします）。
          グラフ・図形・結合セルなど、取得できない情報は再現されない場合があります。
        </p>
      </div>

      <FileDropzone
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        maxSizeMB={30}
        label="Excelファイル(.xlsx)をドラッグ&ドロップ"
        hint="またはタップして選択（上限30MB）"
        onFilesSelected={(files) => void handleSelect(files)}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => { setFile(null); setSheets(null); }} />}

      {loadingSheets && <p className="text-xs text-neutral-500 dark:text-neutral-400">シート情報を読み込み中...</p>}

      {sheets && sheets.length > 0 && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
          <div>
            <p className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">変換するシート</p>
            <div className="flex flex-col gap-1.5">
              {sheets.map((s) => (
                <label key={s.name} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                  <input
                    type="checkbox"
                    checked={selectedSheets.has(s.name)}
                    onChange={() => toggleSheet(s.name)}
                    className="h-4 w-4 rounded border-neutral-300"
                  />
                  {s.name}
                  <span className="text-xs text-neutral-400">({s.rows.length}行)</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-6">
            <div>
              <p className="mb-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200">向き</p>
              <div className="flex gap-2">
                {(
                  [
                    { value: "auto", label: "自動（Excelの設定）" },
                    { value: "portrait", label: "縦" },
                    { value: "landscape", label: "横" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setOrientation(o.value)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      orientation === o.value
                        ? "border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                        : "border-neutral-300 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200">ページの収め方</p>
              <div className="flex gap-2">
                {(
                  [
                    { value: "auto", label: "自動（Excelの設定）" },
                    { value: "fit-width", label: "横幅に合わせる" },
                    { value: "multi-page", label: "列数が多い場合はページを分ける" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setFitMode(o.value)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      fitMode === o.value
                        ? "border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                        : "border-neutral-300 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input
              type="checkbox"
              checked={repeatHeaderRow}
              onChange={(e) => setRepeatHeaderRow(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-300"
            />
            先頭行を見出し行としてページ上部に繰り返す
          </label>
        </div>
      )}

      {sheets && sheets.length > 0 && (
        <PreviewShell
          title="Excelの内容とPDFのプレビュー"
          notes={[
            "変換前はシートの内容(表)を表示しています。PDFの見た目は、変換したあとに1ページ目の画像で確認できます。",
          ]}
        >
          <SheetTabs names={sheets.map((s) => s.name)} active={previewIndex} onChange={setTab} />
          {previewRows && (
            <PreviewGrid rows={previewRows} totalRows={sheets[previewIndex].rows.length} maxRows={10} maxCols={8} headerRow={false} />
          )}
          {resultPdf && <PdfThumbnails file={resultPdf} maxPages={1} width={260} title="変換後PDFの1ページ目" />}
        </PreviewShell>
      )}

      {sheets && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || selectedSheets.size === 0}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          PDFに変換する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="変換中..." successLabel="PDFの生成が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>ページ数: {result.pageCount}</span>
            <span>シート数: {result.sheetCount}</span>
            <span>合計行数: {result.totalRowCount}</span>
            <span>ファイルサイズ: {(result.sizeBytes / 1024).toFixed(1)} KB</span>
          </div>

          {result.warnings.length > 0 && (
            <div className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              {result.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
        </div>
      )}
    </div>
  );
}
