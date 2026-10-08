"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import {
  ProcessingStatus,
  type ProcessingState,
} from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  RosterTemplateProcessor,
  validateRosterTemplateInput,
  buildRosterFileName,
  type RosterColumnSetting,
} from "@/lib/processors/browser/roster-template";
import { parseTableFile, type ParsedTableFile } from "@/lib/utils/table-file";
import { downloadBlob } from "@/lib/utils/format";
import { RosterPreview } from "./shared/roster-preview";
import { RosterScanPanel } from "./roster-scan-panel";

const ACCEPT =
  ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

interface ColumnState extends RosterColumnSetting {
  enabled: boolean;
}

export function RosterTemplateTool() {
  const [mode, setMode] = useState<"data" | "scan">("data");
  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<ParsedTableFile | null>(null);
  const [columns, setColumns] = useState<ColumnState[]>([]);
  const [rowHeightMm, setRowHeightMm] = useState(8);
  const [headerHeightMm, setHeaderHeightMm] = useState(10);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [excelResult, setExcelResult] = useState<Blob | null>(null);
  const [pdfResult, setPdfResult] = useState<Blob | null>(null);

  async function handleSelect(files: File[]) {
    setFile(files[0]);
    setImportError(null);
    setStatus("idle");
    setError(null);
    try {
      const parsed = await parseTableFile(files[0]);
      setTable(parsed);
      setColumns(
        parsed.headers.map((h) => ({
          sourceHeader: h,
          label: h,
          widthMm: 30,
          enabled: true,
        })),
      );
      setExcelResult(null);
      setPdfResult(null);
    } catch (e) {
      setTable(null);
      setColumns([]);
      setImportError(
        e instanceof Error ? e.message : "ファイルの読み込みに失敗しました",
      );
    }
  }

  function updateColumn(index: number, patch: Partial<ColumnState>) {
    setColumns((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
    setExcelResult(null);
    setPdfResult(null);
    setStatus("idle");
  }

  function updateRowHeightMm(v: number) {
    setRowHeightMm(v);
    setExcelResult(null);
    setPdfResult(null);
    setStatus("idle");
  }

  function updateHeaderHeightMm(v: number) {
    setHeaderHeightMm(v);
    setExcelResult(null);
    setPdfResult(null);
    setStatus("idle");
  }

  const activeColumns: RosterColumnSetting[] = columns
    .filter((c) => c.enabled)
    .map(({ sourceHeader, label, widthMm }) => ({
      sourceHeader,
      label,
      widthMm,
    }));

  const baseInput = table
    ? {
        headers: table.headers,
        rows: table.rows,
        columns: activeColumns,
        rowHeightMm,
        headerHeightMm,
      }
    : null;

  async function handleGenerate(format: "excel" | "pdf") {
    if (!baseInput) return;
    const input = { ...baseInput, format };
    const validationError = validateRosterTemplateInput(input);
    if (validationError) {
      setError(validationError);
      setStatus("error");
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await new RosterTemplateProcessor().process(input);
      if (format === "excel") setExcelResult(output.blob);
      else setPdfResult(output.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const previewInput = baseInput
    ? { ...baseInput, format: "pdf" as const }
    : null;
  const previewValidationError = previewInput
    ? validateRosterTemplateInput(previewInput)
    : null;

  const modeButton = (id: "data" | "scan", label: string) => (
    <button
      type="button"
      aria-pressed={mode === id}
      onClick={() => setMode(id)}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        mode === id
          ? "bg-blue-600 text-white"
          : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {modeButton("data", "CSV/Excelから作る")}
        {modeButton("scan", "スキャンしたPDFの枠を再現する")}
      </div>
      {mode === "scan" && <RosterScanPanel />}
      {mode === "data" && (
        <>
          <FileDropzone
            accept={ACCEPT}
            maxSizeMB={20}
            label="CSV/Excelファイルをドラッグ&ドロップ"
            hint="またはタップして選択"
            onFilesSelected={handleSelect}
            onError={setImportError}
          />
          {file && (
            <FileList
              files={[file]}
              onRemove={() => {
                setFile(null);
                setTable(null);
                setColumns([]);
              }}
            />
          )}
          {importError && <ErrorMessage message={importError} />}

          {table && (
            <PreviewSplitLayout
              preview={
              <div
                data-testid="tool-preview"
                className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
              >
                <p className="mb-2 text-sm font-medium">
                  プレビュー（出力と同じレイアウト）
                </p>
                {activeColumns.length > 0 ? (
                  <RosterPreview
                    headers={table.headers}
                    rows={table.rows}
                    columns={activeColumns}
                    rowHeightMm={rowHeightMm}
                    headerHeightMm={headerHeightMm}
                  />
                ) : (
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    使用する列を選ぶと、ここにプレビューが表示されます。
                  </p>
                )}
              </div>
              }
            >
              <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                <p className="text-sm font-medium">
                  使用する列を選択・設定（{table.rows.length}行読み込みました）
                </p>
                <div className="flex flex-col gap-2">
                  {columns.map((c, i) => (
                    <div
                      key={c.sourceHeader}
                      className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[auto_1fr_140px_100px]"
                    >
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={c.enabled}
                          onChange={(e) =>
                            updateColumn(i, { enabled: e.target.checked })
                          }
                        />
                        <span className="text-neutral-500">
                          {c.sourceHeader}
                        </span>
                      </label>
                      <input
                        value={c.label}
                        onChange={(e) =>
                          updateColumn(i, { label: e.target.value })
                        }
                        disabled={!c.enabled}
                        placeholder="見出しラベル"
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900"
                      />
                      <input
                        type="number"
                        value={c.widthMm}
                        min={1}
                        step={1}
                        disabled={!c.enabled}
                        onChange={(e) =>
                          updateColumn(i, { widthMm: e.target.valueAsNumber })
                        }
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900"
                      />
                      <span className="text-xs text-neutral-400">列幅(mm)</span>
                    </div>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:w-1/2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-neutral-600 dark:text-neutral-300">
                      見出しの高さ (mm)
                    </span>
                    <input
                      type="number"
                      value={headerHeightMm}
                      min={1}
                      step={1}
                      onChange={(e) =>
                        updateHeaderHeightMm(e.target.valueAsNumber)
                      }
                      className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-neutral-600 dark:text-neutral-300">
                      1行の高さ (mm)
                    </span>
                    <input
                      type="number"
                      value={rowHeightMm}
                      min={1}
                      step={1}
                      onChange={(e) =>
                        updateRowHeightMm(e.target.valueAsNumber)
                      }
                      className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    />
                  </label>
                </div>
              </div>

              {previewValidationError && (
                <ErrorMessage message={previewValidationError} />
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => handleGenerate("excel")}
                  disabled={status === "processing" || !!previewValidationError}
                  className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  Excelを作成
                </button>
                <button
                  type="button"
                  onClick={() => handleGenerate("pdf")}
                  disabled={status === "processing" || !!previewValidationError}
                  className="w-fit rounded-lg bg-neutral-800 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900"
                >
                  PDFを作成
                </button>
              </div>

              <ProcessingStatus state={status} successLabel="作成しました" />
              {error && <ErrorMessage message={error} />}

              {(excelResult || pdfResult) && (
                <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
                  {excelResult && (
                    <RewardedDownloadGate
                      onDownload={() =>
                        downloadBlob(excelResult, buildRosterFileName("excel"))
                      }
                      label="Excelファイルをダウンロード"
                    />
                  )}
                  {pdfResult && (
                    <RewardedDownloadGate
                      onDownload={() =>
                        downloadBlob(pdfResult, buildRosterFileName("pdf"))
                      }
                      label="PDFファイルをダウンロード"
                    />
                  )}
                </div>
              )}
            </PreviewSplitLayout>
          )}
        </>
      )}
    </div>
  );
}
