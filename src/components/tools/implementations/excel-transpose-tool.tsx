"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  SheetTabs,
  limitSheetRows,
  toGridRows,
  xlsxRowsToText,
} from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { ExcelTransposeProcessor, transposeRows } from "@/lib/processors/browser/excel-transpose";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function ExcelTransposeTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; sheetCount: number } | null>(null);

  const [tab, setTab] = useState(0);
  const { data: sheets, error: previewError, loading } = useAsyncFileData(file, readXlsxSheets);

  // プレビュー: 出力と同じ transposeRows で、選んだシートの行と列を入れ替える(大きなシートは先頭の行だけで計算)
  const preview = useMemo(() => {
    if (!sheets || sheets.length === 0) return null;
    const { sheets: limitedSheets, limited } = limitSheetRows(sheets);
    const index = Math.min(tab, limitedSheets.length - 1);
    const sheet = limitedSheets[index];
    const before = xlsxRowsToText(sheet.rows);
    const after = xlsxRowsToText(transposeRows(sheet.rows));
    return {
      names: sheets.map((s) => s.name),
      index,
      limited,
      totalRows: sheets[index].rows.length,
      beforeSize: [before.length, before[0]?.length ?? 0],
      afterSize: [after.length, after[0]?.length ?? 0],
      before: toGridRows(before.slice(0, 10)),
      after: toGridRows(after.slice(0, 10)),
    };
  }, [sheets, tab]);

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
    try {
      const output = await new ExcelTransposeProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-transposed.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={50}
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (preview || previewError || loading) && (
        <BeforeAfterPreview
          title="行と列の入れ替えプレビュー"
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={previewError}
          beforeLabel="入れ替え前"
          afterLabel="入れ替え後"
          maxRows={10}
          maxCols={8}
          headerRow={false}
          totalRows={preview?.beforeSize[0]}
          afterTotalRows={preview?.afterSize[0]}
          header={preview && <SheetTabs names={preview.names} active={preview.index} onChange={setTab} />}
          summary={
            preview && (
              <span>
                {preview.beforeSize[0]}行 × {preview.beforeSize[1]}列 → {preview.afterSize[0]}行 × {preview.afterSize[1]}列
                （すべてのシートが同じように入れ替わります）
              </span>
            )
          }
          notes={
            preview?.limited
              ? [`ファイルが大きいため、各シートの先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(表示中のシートは全${preview.totalRows}行)。実際の処理は全行が対象です。`]
              : undefined
          }
        />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          行と列を入れ替える
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.sheetCount}シートを変換しました
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
