"use client";

import { useCsvExport } from "@/components/common/csv-export-encoding";
import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import { SheetFilePreview } from "@/components/common/sheet-preview";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { WorkerCanceledError } from "@/lib/workers/worker-channel";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ExcelToCsvProcessor, sheetRowsToCsvBlob, type ExcelSheet } from "@/lib/processors/browser/csv-excel";
import { sanitizeFileName, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";

export function ExcelToCsvTool() {
  /** CSVの書き出しの文字コード（UTF-8 BOM付き・BOMなし・Shift_JIS）を選んでダウンロードする */
  const csvExport = useCsvExport();
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<ExcelSheet[] | null>(null);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const runCtrlRef = useRef<AbortController | null>(null);
  // 画面を離れるとき・別のファイルを選んだときは、処理を止める（大きなファイルの Worker も終了する）
  useEffect(() => () => runCtrlRef.current?.abort(), []);

  function handleSelect(files: File[]) {
    runCtrlRef.current?.abort();
    runCtrlRef.current = null;
    setWasCanceled(false);
    setFile(files[0]);
    setSheets(null);
    setSelectedSheetIndex(0);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    const ctrl = new AbortController();
    runCtrlRef.current = ctrl;
    setStatus("processing");
    setError(null);
    setSheets(null);
    setCanceling(false);
    setWasCanceled(false);
    try {
      // 大きなファイルは、画面とは別の処理（Worker）で読み取る（ロードマップC 工程3）
      const output = await new ExcelToCsvProcessor().process({ file, cancelSignal: ctrl.signal });
      if (runCtrlRef.current !== ctrl) return;
      setSheets(output.sheets);
      setSelectedSheetIndex(0);
      setStatus("success");
    } catch (e) {
      if (runCtrlRef.current !== ctrl) return;
      if (e instanceof WorkerCanceledError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      if (runCtrlRef.current === ctrl) {
        runCtrlRef.current = null;
        setCanceling(false);
      }
    }
  }

  const selectedSheet = sheets?.[selectedSheetIndex] ?? null;

  function handleDownload() {
    if (!file || !selectedSheet) return;
    const blob = sheetRowsToCsvBlob(selectedSheet.rows);
    const base = stripExtension(file.name);
    const name =
      sheets && sheets.length > 1
        ? `${base}-${sanitizeFileName(selectedSheet.name)}.csv`
        : `${base}.csv`;
    void csvExport.download(blob, name);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={!!file}
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        maxSizeMB={50}
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && !sheets && (
        <div data-testid="tool-preview">
          <SheetFilePreview
            file={file}
            title="CSVに変換される内容(プレビュー)"
            maxRows={10}
            maxCols={8}
          />
        </div>
      )}

      {file && !sheets && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            CSVに変換する
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        successLabel="変換が完了しました"
        onCancel={() => {
          setCanceling(true);
          runCtrlRef.current?.abort();
        }}
        canceling={canceling}
      />
      {wasCanceled && (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300" data-testid="convert-canceled">
          処理をキャンセルしました。
        </p>
      )}
      {error && <ErrorMessage message={error} />}

      {sheets && sheets.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {sheets.length > 1 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                ダウンロードするシートを選択
              </p>
              <div className="ms-seg">
                {sheets.map((sheet, i) => (
                  <button aria-pressed={i === selectedSheetIndex}
                    key={`${sheet.name}-${i}`}
                    type="button"
                    onClick={() => setSelectedSheetIndex(i)}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedSheet && (
            <div className="flex flex-col gap-2" data-testid="tool-preview">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                「{selectedSheet.name}」・{selectedSheet.rows.length}行
              </p>
              <CsvPreviewTable rows={selectedSheet.rows} />
            </div>
          )}

          {csvExport.picker}
          {csvExport.confirm}
          <RewardedDownloadGate onDownload={handleDownload} label="CSVでダウンロード" />
        </div>
      )}
    </div>
  );
}
