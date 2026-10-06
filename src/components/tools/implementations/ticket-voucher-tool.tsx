"use client";

import { useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  TicketVoucherProcessor,
  validateTicketVoucherInput,
  buildTicketVoucherFileName,
  type TicketVoucherInput,
} from "@/lib/processors/browser/ticket-voucher";
import { PAPER_SIZE_IDS, PAPER_SIZE_LABELS, type PaperSizeId, type PaperOrientation } from "@/lib/print/paper-sizes";
import { downloadBlob } from "@/lib/utils/format";
import { TicketPreview } from "./shared/ticket-preview";

const DEFAULTS: TicketVoucherInput = {
  paperSizeId: "A4",
  orientation: "portrait",
  cellWidthMm: 90,
  cellHeightMm: 50,
  count: 10,
  title: "整理券",
  date: "",
  amount: "",
  freeText: "",
  showSerial: true,
  serialStart: 1,
  serialDigits: 4,
  showQr: false,
  qrContent: "{n}",
  showBarcode: false,
  barcodeContent: "{n}",
  showCutLines: true,
  marginMm: 10,
  gapMm: 4,
};

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </label>
  );
}

function NumberField({ label, value, onChange, min = 0, step = 1 }: { label: string; value: number; onChange: (v: number) => void; min?: number; step?: number }) {
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

export function TicketVoucherTool() {
  const [form, setForm] = useState<TicketVoucherInput>(DEFAULTS);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);

  function update<K extends keyof TicketVoucherInput>(key: K, value: TicketVoucherInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setResult(null);
    setStatus("idle");
  }

  const validationError = validateTicketVoucherInput(form);

  async function handleRun() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new TicketVoucherProcessor().process(form);
      setResult(output.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result) return;
    downloadBlob(result, buildTicketVoucherFileName(form.title));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">用紙サイズ</span>
          <select
            value={form.paperSizeId}
            onChange={(e) => update("paperSizeId", e.target.value as PaperSizeId)}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {PAPER_SIZE_IDS.map((id) => (
              <option key={id} value={id}>{PAPER_SIZE_LABELS[id]}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">向き</span>
          <div className="flex gap-2">
            {(["portrait", "landscape"] as PaperOrientation[]).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => update("orientation", o)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  form.orientation === o ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {o === "portrait" ? "縦" : "横"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-4">
        <NumberField label="1枚の幅 (mm)" value={form.cellWidthMm} onChange={(v) => update("cellWidthMm", v)} step={0.5} />
        <NumberField label="1枚の高さ (mm)" value={form.cellHeightMm} onChange={(v) => update("cellHeightMm", v)} step={0.5} />
        <NumberField label="余白 (mm)" value={form.marginMm} onChange={(v) => update("marginMm", v)} step={0.5} />
        <NumberField label="間隔 (mm)" value={form.gapMm} onChange={(v) => update("gapMm", v)} step={0.5} />
        <NumberField label="枚数" value={form.count} onChange={(v) => update("count", Math.round(v))} min={1} />
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800 sm:grid-cols-2">
        <TextField label="タイトル" value={form.title} onChange={(v) => update("title", v)} placeholder="整理券 / 金券 / 引換券 など" />
        <TextField label="日付" value={form.date} onChange={(v) => update("date", v)} placeholder="2026-09-30 など" />
        <TextField label="金額" value={form.amount} onChange={(v) => update("amount", v)} placeholder="1,000円 など" />
        <TextField label="任意テキスト" value={form.freeText} onChange={(v) => update("freeText", v)} placeholder="有効期限・注意事項など" />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.showCutLines} onChange={(e) => update("showCutLines", e.target.checked)} />
          切り取り線を表示する
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.showSerial} onChange={(e) => update("showSerial", e.target.checked)} />
          連番を表示する
        </label>
        {form.showSerial && (
          <div className="grid grid-cols-2 gap-3 pl-6 sm:w-1/2">
            <NumberField label="開始番号" value={form.serialStart} onChange={(v) => update("serialStart", Math.round(v))} min={0} />
            <NumberField label="桁数（0埋め）" value={form.serialDigits} onChange={(v) => update("serialDigits", Math.round(v))} min={1} />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.showQr} onChange={(e) => update("showQr", e.target.checked)} />
          QRコードを表示する
        </label>
        {form.showQr && (
          <div className="pl-6 sm:w-1/2">
            <TextField label="QRコードの内容（{n} は連番に置き換わります）" value={form.qrContent} onChange={(v) => update("qrContent", v)} />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.showBarcode} onChange={(e) => update("showBarcode", e.target.checked)} />
          バーコードを表示する（CODE128）
        </label>
        {form.showBarcode && (
          <div className="pl-6 sm:w-1/2">
            <TextField label="バーコードの内容（{n} は連番に置き換わります）" value={form.barcodeContent} onChange={(v) => update("barcodeContent", v)} />
          </div>
        )}
      </div>

      <div data-testid="tool-preview" className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="mb-2 text-sm font-medium">プレビュー（PDFと同じ配置・1ページ分）</p>
        <TicketPreview form={form} />
      </div>

      {validationError && <ErrorMessage message={validationError} />}

      <button
        type="button"
        onClick={handleRun}
        disabled={status === "processing" || !!validationError}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        PDFを作成
      </button>

      <ProcessingStatus state={status} successLabel="PDFを作成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
        </div>
      )}
    </div>
  );
}
