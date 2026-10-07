"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
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
import {
  DEFAULT_CODE_SETTINGS,
  PLACEMENT_IDS,
  PLACEMENT_LABELS,
  emptyGroup,
  type CodePlacement,
  type TicketCodeSettings,
  type TicketGroup,
  type TicketRow,
} from "@/lib/tickets/ticket-layout";
import { parseTableFile, type ParsedTableFile } from "@/lib/utils/table-file";
import { downloadBlob } from "@/lib/utils/format";
import { TicketPreview } from "./shared/ticket-preview";

const ACCEPT = ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

const DEFAULTS: TicketVoucherInput = {
  paperSizeId: "A4",
  orientation: "portrait",
  cellWidthMm: 90,
  cellHeightMm: 50,
  marginMm: 10,
  gapMm: 4,
  showSerial: true,
  serialDigits: 4,
  showCutLines: true,
  codes: DEFAULT_CODE_SETTINGS,
  groups: [emptyGroup()],
  rows: null,
  rowsSerialStart: 1,
};

const inputClass =
  "rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={inputClass} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  step = 1,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <input
        type="number"
        value={value !== null && Number.isFinite(value) ? value : ""}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className={inputClass}
      />
    </label>
  );
}

function PlacementSelect({ label, value, onChange }: { label: string; value: CodePlacement; onChange: (v: CodePlacement) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-300">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as CodePlacement)} className={inputClass}>
        {PLACEMENT_IDS.map((id) => (
          <option key={id} value={id}>
            {PLACEMENT_LABELS[id]}
          </option>
        ))}
      </select>
    </label>
  );
}

type FieldKey = "title" | "date" | "amount" | "freeText" | "serial" | "qrContent" | "barcodeContent";
const FIELD_LABELS: { key: FieldKey; label: string; common: string }[] = [
  { key: "title", label: "タイトルの列", common: "使わない（券の種類1の入力を使う）" },
  { key: "date", label: "日付の列", common: "使わない（券の種類1の入力を使う）" },
  { key: "amount", label: "金額の列", common: "使わない（券の種類1の入力を使う）" },
  { key: "freeText", label: "任意テキストの列", common: "使わない（券の種類1の入力を使う）" },
  { key: "serial", label: "連番（番号）の列", common: "使わない（開始番号からの連番）" },
  { key: "qrContent", label: "二次元コードの内容の列", common: "使わない（下の共通の内容を使う）" },
  { key: "barcodeContent", label: "バーコードの内容の列", common: "使わない（下の共通の内容を使う）" },
];

function formatYen(value: string): string {
  const n = value.replace(/[,，円\s]/g, "");
  if (/^-?\d+(\.\d+)?$/.test(n)) return `${Number(n).toLocaleString("ja-JP")}円`;
  return value;
}

export function TicketVoucherTool() {
  const [form, setForm] = useState<TicketVoucherInput>(DEFAULTS);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);

  const [table, setTable] = useState<ParsedTableFile | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<FieldKey, string>>({
    title: "",
    date: "",
    amount: "",
    freeText: "",
    serial: "",
    qrContent: "",
    barcodeContent: "",
  });
  const [yenFormat, setYenFormat] = useState(true);

  function update<K extends keyof TicketVoucherInput>(key: K, value: TicketVoucherInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setResult(null);
    setStatus("idle");
  }
  function updateCodes(patch: Partial<TicketCodeSettings>) {
    setForm((prev) => ({ ...prev, codes: { ...prev.codes, ...patch } }));
    setResult(null);
    setStatus("idle");
  }
  function updateGroup(index: number, patch: Partial<TicketGroup>) {
    setForm((prev) => ({ ...prev, groups: prev.groups.map((g, i) => (i === index ? { ...g, ...patch } : g)) }));
    setResult(null);
    setStatus("idle");
  }

  const usingRows = form.rows !== null && form.rows.length > 0;
  const validationError = validateTicketVoucherInput(form);

  async function handleImportFile(files: File[]) {
    setImportError(null);
    setTable(null);
    try {
      setTable(await parseTableFile(files[0]));
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "ファイルの読み込みに失敗しました");
    }
  }

  function applyImport() {
    if (!table) return;
    const base = form.groups[0] ?? emptyGroup();
    const idx = (key: FieldKey) => (mapping[key] ? table.headers.indexOf(mapping[key]) : -1);
    const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
    const rows: TicketRow[] = table.rows.map((row) => {
      const vars: Record<string, string> = {};
      table.headers.forEach((h, i) => {
        if (h.trim() !== "") vars[h.trim()] = (row[i] ?? "").trim();
      });
      const amountRaw = idx("amount") >= 0 ? cell(row, idx("amount")) : base.amount;
      return {
        title: idx("title") >= 0 ? cell(row, idx("title")) : base.title,
        date: idx("date") >= 0 ? cell(row, idx("date")) : base.date,
        amount: yenFormat && idx("amount") >= 0 ? formatYen(amountRaw) : amountRaw,
        freeText: idx("freeText") >= 0 ? cell(row, idx("freeText")) : base.freeText,
        serial: cell(row, idx("serial")),
        qrContent: cell(row, idx("qrContent")),
        barcodeContent: cell(row, idx("barcodeContent")),
        vars,
      };
    });
    setForm((prev) => ({ ...prev, rows }));
    setResult(null);
    setStatus("idle");
  }

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
    downloadBlob(result, buildTicketVoucherFileName(form.groups[0]?.title ?? ""));
  }

  const codes = form.codes;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">用紙サイズ</span>
          <select value={form.paperSizeId} onChange={(e) => update("paperSizeId", e.target.value as PaperSizeId)} className={inputClass}>
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
      </div>

      {usingRows ? (
        <div className="flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950">
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
            Excel/CSVから読み込んだ{form.rows?.length}件（1行=1枚）を使っています
          </p>
          <div className="grid grid-cols-2 gap-3 sm:w-1/2">
            <NumberField
              label="開始番号（連番の列を使わないとき）"
              value={form.rowsSerialStart}
              onChange={(v) => update("rowsSerialStart", Math.round(v))}
              min={0}
            />
          </div>
          <button
            type="button"
            onClick={() => update("rows", null)}
            className="w-fit rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 shadow-sm dark:bg-neutral-800 dark:text-neutral-200"
          >
            読み込みをやめて、手入力に戻す
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {form.groups.map((g, i) => {
            const count = Number.isInteger(g.serialStart) && Number.isInteger(g.serialEnd) ? Math.max(0, g.serialEnd - g.serialStart + 1) : 0;
            return (
              <div key={i} className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">券の種類{form.groups.length > 1 ? ` ${i + 1}` : ""}（{count}枚）</p>
                  {form.groups.length > 1 && (
                    <button
                      type="button"
                      onClick={() => update("groups", form.groups.filter((_, idx) => idx !== i))}
                      className="text-xs text-neutral-400 hover:text-red-500"
                    >
                      この種類を削除
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextField label="タイトル" value={g.title} onChange={(v) => updateGroup(i, { title: v })} placeholder="整理券 / 金券 / 引換券 など" />
                  <TextField label="日付" value={g.date} onChange={(v) => updateGroup(i, { date: v })} placeholder="2026-09-30 など" />
                  <TextField label="金額" value={g.amount} onChange={(v) => updateGroup(i, { amount: v })} placeholder="1,000円 など" />
                  <TextField label="任意テキスト" value={g.freeText} onChange={(v) => updateGroup(i, { freeText: v })} placeholder="有効期限・注意事項など" />
                </div>
                <div className="grid grid-cols-2 gap-3 sm:w-1/2">
                  <NumberField label="開始番号" value={g.serialStart} onChange={(v) => updateGroup(i, { serialStart: Math.round(v) })} min={0} />
                  <NumberField label="終了番号" value={g.serialEnd} onChange={(v) => updateGroup(i, { serialEnd: Math.round(v) })} min={0} />
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => {
              const last = form.groups[form.groups.length - 1];
              update("groups", [...form.groups, emptyGroup({ title: "", serialStart: last ? last.serialEnd + 1 : 1, serialEnd: last ? last.serialEnd + 10 : 10 })]);
            }}
            className="w-fit rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
          >
            + 別のタイトル・金額の券を追加
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-medium">Excel/CSVから一括で読み込む（任意・1行=1枚）</p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          1行目を見出しとして、列ごとに「タイトル」「金額」などを割り当てます。券ごとに違う内容にできます。
        </p>
        <FileDropzone accept={ACCEPT} maxSizeMB={20} label="CSV/Excelをドラッグ&ドロップ" hint="またはタップして選択" onFilesSelected={handleImportFile} onError={setImportError} />
        {importError && <ErrorMessage message={importError} />}
        {table && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FIELD_LABELS.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs text-neutral-500">
                  {f.label}
                  <select
                    value={mapping[f.key]}
                    aria-label={f.label}
                    onChange={(e) => setMapping((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">{f.common}</option>
                    {table.headers.map((h, i) => (
                      <option key={`${h}-${i}`} value={h}>{h}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={yenFormat} onChange={(e) => setYenFormat(e.target.checked)} />
              金額の数字を「1,000円」の形にする
            </label>
            <button type="button" onClick={applyImport} className="w-fit rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-200 dark:text-neutral-900">
              読み込んだ{table.rows.length}件を券にする
            </button>
          </div>
        )}
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
        <div className="grid grid-cols-2 gap-3 pl-6 sm:w-1/2">
          <NumberField label="連番の桁数（0埋め）" value={form.serialDigits} onChange={(v) => update("serialDigits", Math.round(v))} min={1} />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={codes.showQr} onChange={(e) => updateCodes({ showQr: e.target.checked })} />
          二次元コードを表示する
        </label>
        {codes.showQr && (
          <div className="flex flex-col gap-3 pl-6">
            <TextField
              label="読み取ったときに表示される内容"
              value={codes.qrContent}
              onChange={(v) => updateCodes({ qrContent: v })}
              placeholder="例: 整理券 {n}番 / {title} {amount}"
            />
            <div className="grid grid-cols-2 gap-3 sm:w-2/3">
              <PlacementSelect label="二次元コードの場所" value={codes.qrPlacement} onChange={(v) => updateCodes({ qrPlacement: v })} />
              <NumberField
                label="大きさ（一辺・mm）"
                value={codes.qrSizeMm}
                onChange={(v) => updateCodes({ qrSizeMm: Number.isFinite(v) ? v : null })}
                step={0.5}
                placeholder="自動"
              />
            </div>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={codes.showBarcode} onChange={(e) => updateCodes({ showBarcode: e.target.checked })} />
          バーコードを表示する（CODE128）
        </label>
        {codes.showBarcode && (
          <div className="flex flex-col gap-3 pl-6">
            <TextField
              label="読み取ったときに表示される内容（半角の英数字・記号のみ）"
              value={codes.barcodeContent}
              onChange={(v) => updateCodes({ barcodeContent: v })}
              placeholder="例: T-{n}"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <PlacementSelect label="バーコードの場所" value={codes.barcodePlacement} onChange={(v) => updateCodes({ barcodePlacement: v })} />
              <NumberField
                label="幅（mm）"
                value={codes.barcodeWidthMm}
                onChange={(v) => updateCodes({ barcodeWidthMm: Number.isFinite(v) ? v : null })}
                step={0.5}
                placeholder="自動"
              />
              <NumberField
                label="高さ（mm）"
                value={codes.barcodeHeightMm}
                onChange={(v) => updateCodes({ barcodeHeightMm: Number.isFinite(v) ? v : null })}
                step={0.5}
                placeholder="自動"
              />
            </div>
          </div>
        )}
        {(codes.showQr || codes.showBarcode) && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            内容には、{"{n}"}（連番）・{"{title}"}（タイトル）・{"{date}"}（日付）・{"{amount}"}（金額）・{"{text}"}（任意テキスト）が使えます。Excelから読み込んだときは、見出しの名前（例: {"{氏名}"}）も使えます。
          </p>
        )}
      </div>

      <div data-testid="tool-preview" className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="mb-2 text-sm font-medium">プレビュー（PDFと同じ配置）</p>
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
