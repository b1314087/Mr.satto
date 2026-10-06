"use client";

import { useMemo, useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ExcelLabelProcessor,
  buildAxisPlan,
  validateExcelLabelInput,
  type AxisSegment,
  type ExcelLabelInput,
} from "@/lib/processors/browser/excel-label";
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

  // プレビュー: Excel出力と同じ配置計画(buildAxisPlan: 余白・ラベル・間隔の並び)から、mmの比率どおりに描く
  const layout = useMemo(() => {
    if (validateExcelLabelInput(form)) return null;
    const rowPlan = buildAxisPlan(form.rows, form.labelHeightMm, form.gapVMm, form.marginTopMm, form.marginBottomMm);
    const colPlan = buildAxisPlan(form.columns, form.labelWidthMm, form.gapHMm, form.marginLeftMm, form.marginRightMm);
    const place = (plan: AxisSegment[]) => {
      let offset = 0;
      const total = plan.reduce((sum, seg) => sum + seg.mm, 0);
      const labels: { start: number; size: number }[] = [];
      for (const seg of plan) {
        if (seg.kind === "label") labels.push({ start: offset, size: seg.mm });
        offset += seg.mm;
      }
      return { total, labels };
    };
    const rowsPlaced = place(rowPlan);
    const colsPlaced = place(colPlan);
    if (!(rowsPlaced.total > 0) || !(colsPlaced.total > 0)) return null;
    return { widthMm: colsPlaced.total, heightMm: rowsPlaced.total, rows: rowsPlaced.labels, cols: colsPlaced.labels };
  }, [form]);

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

      <section
        aria-label="ラベルシートのプレビュー"
        data-testid="tool-preview"
        className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          ラベルシートのプレビュー(設定の変更に合わせて更新されます)
        </p>
        {layout ? (
          <>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              全体 約{Math.round(layout.widthMm * 10) / 10}×{Math.round(layout.heightMm * 10) / 10}mm ・ ラベル{form.rows * form.columns}枚（{form.columns}列×{form.rows}行）
            </p>
            <div className="w-full max-w-sm" style={{ containerType: "inline-size" }}>
              <div
                className="relative w-full overflow-hidden rounded border border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-100"
                style={{ aspectRatio: `${layout.widthMm} / ${layout.heightMm}` }}
              >
                {layout.rows.map((r, ri) =>
                  layout.cols.map((c, ci) => (
                    <div
                      key={`${ri}-${ci}`}
                      className="absolute flex items-center justify-center overflow-hidden border border-neutral-400 bg-neutral-50 p-px text-center text-neutral-700"
                      style={{
                        left: `${(c.start / layout.widthMm) * 100}%`,
                        top: `${(r.start / layout.heightMm) * 100}%`,
                        width: `${(c.size / layout.widthMm) * 100}%`,
                        height: `${(r.size / layout.heightMm) * 100}%`,
                        fontSize: "clamp(5px, 2.2cqw, 11px)",
                        lineHeight: 1.2,
                      }}
                    >
                      <span className="line-clamp-3 whitespace-pre-wrap break-all">{form.text || "（空）"}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              余白・間隔・ラベルの大きさをmmの比率どおりに描いた配置イメージです。実際のExcelでは列幅が文字数単位の近似になるため、見た目が多少前後します。
            </p>
          </>
        ) : (
          <p className="text-xs text-neutral-400">設定が正しくないため、プレビューを表示できません。</p>
        )}
      </section>

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
