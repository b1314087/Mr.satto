"use client";

import { CsvEncodingControl } from "@/components/common/csv-encoding-control";
import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import {
  PreviewGrid,
  PreviewNotice,
  PreviewShell,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRows, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { WorkerCanceledError } from "@/lib/workers/worker-channel";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { CsvToExcelProcessor } from "@/lib/processors/browser/csv-excel";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";

export function CsvToExcelTool() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const runCtrlRef = useRef<AbortController | null>(null);
  // 画面を離れるとき・別のファイルを選んだときは、処理を止める（大きなファイルの Worker も終了する）
  useEffect(() => () => runCtrlRef.current?.abort(), []);
  const [result, setResult] = useState<{ blob: Blob; rowCount: number } | null>(null);

  // プレビュー: 変換処理(CsvToExcelProcessor)と同じ読み方(parseCsv + 空行除外)でシートの中身を表示する
  const { data: rows, error: previewError, loading } = useAsyncFileData(file, loadCsvRows);
  const columnCount = rows ? rows.reduce((max, r) => Math.max(max, r.length), 0) : 0;

  function handleSelect(files: File[]) {
    runCtrlRef.current?.abort();
    runCtrlRef.current = null;
    setWasCanceled(false);
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    const ctrl = new AbortController();
    runCtrlRef.current = ctrl;
    setStatus("processing");
    setError(null);
    setResult(null);
    setCanceling(false);
    setWasCanceled(false);
    try {
      // 大きなファイルは、画面とは別の処理（Worker）で変換する（ロードマップC 工程3）
      const output = await new CsvToExcelProcessor().process({ file, cancelSignal: ctrl.signal });
      if (runCtrlRef.current !== ctrl) return;
      setResult({ blob: output.blob, rowCount: output.rowCount });
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

  const downloadName = file ? `${stripExtension(file.name)}.xlsx` : "converted.xlsx";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={!!file}
        accept=".csv,text/csv"
        maxSizeMB={50}
        label="CSVファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
      {file && <CsvEncodingControl files={[file]} />}

      {file && (rows || previewError || loading) && (
        <PreviewShell
          title="Excelに変換される内容(プレビュー)"
          loading={loading}
          summary={rows && <span>{rows.length}行 × {columnCount}列</span>}
        >
          {previewError && <PreviewNotice message={previewError} />}
          {rows && (
            <PreviewGrid rows={toGridRows(rows.slice(0, 10))} totalRows={rows.length} maxRows={10} maxCols={8} headerRow={false} />
          )}
        </PreviewShell>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            Excelに変換する
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        successLabel="Excelへの変換が完了しました"
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

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行 ・ {formatBytes(result.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </div>
  );
}
