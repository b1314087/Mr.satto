"use client";

import { useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ExcelLabelProcessor, validateExcelLabelInput, type ExcelLabelInput } from "@/lib/processors/browser/excel-label";
import { downloadBlob } from "@/lib/utils/format";

const DEFAULTS: ExcelLabelInput = {
  labelWidthMm: 70,
  labelHeightMm: 42.3,
  rows: 6,
  columns: 2,
  marginTopMm: 10,
  marginBottomMm: 10,
  marginLeftMm: 5,
  marginRightMm: 5,
  gapHMm: 3,
  gapVMm: 0,
  text: "見本ラベル",
};

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </label>
  );
}

export function ExcelLabelTool() {
  const [form, setForm] = useState<ExcelLabelInput>(DEFAULTS);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);

  function update<K extends keyof ExcelLabelInput>(key: K, value: ExcelLabelInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setResult(null);
    setStatus("idle");
  }

  const validationError = validateExcelLabelInput(form);

  async function handleRun() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelLabelProcessor().process(form);
      setResult(output.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result) return;
    downloadBlob(result, "ラベルシート.xlsx");
  }

  const previewCells = Array.from({ length: Math.min(form.rows, 8) * Math.min(form.columns, 6) });
  const previewCols = Math.min(form.columns, 6);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-3">
        <NumberField label="ラベル幅 (mm)" value={form.labelWidthMm} onChange={(v) => update("labelWidthMm", v)} />
        <NumberField label="ラベル高さ (mm)" value={form.labelHeightMm} onChange={(v) => update("labelHeightMm", v)} />
        <NumberField label="列数" value={form.columns} onChange={(v) => update("columns", Math.round(v))} min={1} step={1} />
        <NumberField label="行数" value={form.rows} onChange={(v) => update("rows", Math.round(v))} min={1} step={1} />
        <NumberField label="横間隔 (mm)" value={form.gapHMm} onChange={(v) => update("gapHMm", v)} />
        <NumberField label="縦間隔 (mm)" value={form.gapVMm} onChange={(v) => update("gapVMm", v)} />
        <NumberField label="上余白 (mm)" value={form.marginTopMm} onChange={(v) => update("marginTopMm", v)} />
        <NumberField label="下余白 (mm)" value={form.marginBottomMm} onChange={(v) => update("marginBottomMm", v)} />
        <NumberField label="左余白 (mm)" value={form.marginLeftMm} onChange={(v) => update("marginLeftMm", v)} />
        <NumberField label="右余白 (mm)" value={form.marginRightMm} onChange={(v) => update("marginRightMm", v)} />
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600 dark:text-neutral-300">ラベル内の文字（すべてのラベルに同じ内容が入ります）</span>
        <textarea
          value={form.text}
          onChange={(e) => update("text", e.target.value)}
          rows={3}
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div>
        <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">プレビュー（実際の配置イメージ・8行6列まで表示）</p>
        <div
          className="grid gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900"
          style={{ gridTemplateColumns: `repeat(${previewCols}, minmax(0, 1fr))` }}
        >
          {previewCells.map((_, i) => (
            <div
              key={i}
              className="flex aspect-[3/2] items-center justify-center rounded border border-dashed border-neutral-400 bg-white p-1 text-center text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
            >
              {form.text || "（空）"}
            </div>
          ))}
        </div>
      </div>

      {validationError && <ErrorMessage message={validationError} />}

      <button
        type="button"
        onClick={handleRun}
        disabled={status === "processing" || !!validationError}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        Excelを作成
      </button>

      <ProcessingStatus state={status} successLabel="ラベルシートを作成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
