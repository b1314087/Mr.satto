"use client";

import { useState } from "react";
import { EnvelopePreview } from "./shared/envelope-preview";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  EnvelopeAddressProcessor,
  validateEnvelopeAddressInput,
  buildEnvelopeFileName,
  type EnvelopePerson,
  type EnvelopeWritingMode,
  type EnvelopeOrientation,
  type EnvelopeHonorific,
  type EnvelopeTextStyle,
} from "@/lib/processors/browser/envelope-address";
import { DEFAULT_SIZES, DEFAULT_TEXT_STYLE, HONORIFIC_LABELS, MAX_FONT_PT, MIN_FONT_PT } from "@/lib/print/envelope-layout";
import { ENVELOPE_SIZE_IDS, ENVELOPE_SIZE_LABELS, type EnvelopeSizeId } from "@/lib/print/envelope-sizes";
import { parseTableFile } from "@/lib/utils/table-file";
import { downloadBlob } from "@/lib/utils/format";

const ACCEPT = ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

function emptyPerson(): EnvelopePerson {
  return { postalCode: "", address: "", name: "" };
}

function PersonFields({
  person,
  onChange,
  onRemove,
}: {
  person: EnvelopePerson;
  onChange: (p: EnvelopePerson) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <input
          value={person.postalCode}
          onChange={(e) => onChange({ ...person, postalCode: e.target.value })}
          placeholder="郵便番号 (例: 1000001)"
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <input
          value={person.address}
          onChange={(e) => onChange({ ...person, address: e.target.value })}
          placeholder="住所"
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm sm:col-span-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex items-center gap-2">
        <input
          value={person.name}
          onChange={(e) => onChange({ ...person, name: e.target.value })}
          placeholder="氏名"
          className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-xs text-neutral-400 hover:text-red-500">
            削除
          </button>
        )}
      </div>
    </div>
  );
}

export function EnvelopeAddressTool() {
  const [envelopeSize, setEnvelopeSize] = useState<EnvelopeSizeId>("chou3");
  const [writingMode, setWritingMode] = useState<EnvelopeWritingMode>("vertical");
  const [orientation, setOrientation] = useState<EnvelopeOrientation>("landscape");
  const [honorific, setHonorific] = useState<EnvelopeHonorific>("sama");
  const [style, setStyle] = useState<EnvelopeTextStyle>(DEFAULT_TEXT_STYLE);
  const [recipients, setRecipients] = useState<EnvelopePerson[]>([emptyPerson()]);
  const [sender, setSender] = useState<EnvelopePerson>(emptyPerson());
  const [useSender, setUseSender] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);

  const [importTable, setImportTable] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [colPostal, setColPostal] = useState<string>("");
  const [colAddress, setColAddress] = useState<string>("");
  const [colName, setColName] = useState<string>("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);

  function clearResult() {
    setResult(null);
    setStatus("idle");
  }

  async function handleImportFile(files: File[]) {
    setImportError(null);
    setImportTable(null);
    try {
      const table = await parseTableFile(files[0]);
      setImportTable(table);
      setColPostal("");
      setColAddress("");
      setColName("");
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "ファイルの読み込みに失敗しました");
    }
  }

  function applyImport() {
    if (!importTable) return;
    const postalIdx = importTable.headers.indexOf(colPostal);
    const addressIdx = importTable.headers.indexOf(colAddress);
    const nameIdx = importTable.headers.indexOf(colName);
    const imported: EnvelopePerson[] = importTable.rows.map((row) => ({
      postalCode: postalIdx >= 0 ? (row[postalIdx] ?? "") : "",
      address: addressIdx >= 0 ? (row[addressIdx] ?? "") : "",
      name: nameIdx >= 0 ? (row[nameIdx] ?? "") : "",
    }));
    setRecipients(imported.length > 0 ? imported : [emptyPerson()]);
    clearResult();
  }

  const input = { envelopeSize, writingMode, orientation, honorific, style, recipients, sender: useSender ? sender : null };
  const validationError = validateEnvelopeAddressInput(input);

  async function handleRun() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new EnvelopeAddressProcessor().process(input);
      setResult(output.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result) return;
    downloadBlob(result, buildEnvelopeFileName(envelopeSize));
  }

  // PDFに出力される宛先(空の宛先は除外)を1件ずつプレビューする
  const validRecipients = recipients.filter(
    (r) => r.postalCode.trim() || r.address.trim() || r.name.trim()
  );
  const safePreviewIndex = Math.min(previewIndex, Math.max(0, validRecipients.length - 1));
  const previewPerson = validRecipients[safePreviewIndex];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">封筒サイズ</span>
          <div className="flex flex-wrap gap-2">
            {ENVELOPE_SIZE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setEnvelopeSize(id);
                  clearResult();
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  envelopeSize === id ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {ENVELOPE_SIZE_LABELS[id]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">書字方向</span>
          <div className="flex gap-2">
            {(["vertical", "horizontal"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setWritingMode(mode);
                  // 縦書きは封筒を縦長に、横書きは横長にするのが一般的なため、向きも合わせる(あとから自由に変更できる)
                  setOrientation(mode === "vertical" ? "portrait" : "landscape");
                  clearResult();
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  writingMode === mode ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {mode === "vertical" ? "縦書き" : "横書き"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">封筒の向き</span>
          <div className="flex gap-2">
            {(["portrait", "landscape"] as const).map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={orientation === o}
                onClick={() => {
                  setOrientation(o);
                  clearResult();
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  orientation === o ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {o === "portrait" ? "縦向き" : "横向き"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-300">宛名の敬称</span>
          <div className="flex gap-2">
            {(["sama", "onchu", "none"] as const).map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={honorific === h}
                onClick={() => {
                  setHonorific(h);
                  clearResult();
                }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  honorific === h ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {HONORIFIC_LABELS[h]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-medium">文字のサイズと太字（サイズを空にすると標準の大きさ）</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(
            [
              { label: "宛名", sizeKey: "nameSize", boldKey: "nameBold", def: DEFAULT_SIZES[writingMode].name },
              { label: "住所", sizeKey: "addressSize", boldKey: "addressBold", def: DEFAULT_SIZES[writingMode].address },
              { label: "差出人", sizeKey: "senderSize", boldKey: "senderBold", def: DEFAULT_SIZES[writingMode].sender },
            ] as const
          ).map((f) => (
            <div key={f.label} className="flex flex-col gap-1.5 text-sm">
              <label className="flex flex-col gap-1 text-neutral-600 dark:text-neutral-300">
                {f.label}の文字サイズ（pt）
                <input
                  type="number"
                  inputMode="decimal"
                  min={MIN_FONT_PT}
                  max={MAX_FONT_PT}
                  step={1}
                  value={style[f.sizeKey] ?? ""}
                  placeholder={`標準 ${f.def}`}
                  aria-label={`${f.label}の文字サイズ`}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : e.target.valueAsNumber;
                    setStyle((prev) => ({ ...prev, [f.sizeKey]: v }));
                    clearResult();
                  }}
                  className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex items-center gap-2 text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={style[f.boldKey]}
                  onChange={(e) => {
                    setStyle((prev) => ({ ...prev, [f.boldKey]: e.target.checked }));
                    clearResult();
                  }}
                />
                {f.label}を太字にする
              </label>
            </div>
          ))}
        </div>
      </div>

      <div data-testid="tool-preview" className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">プレビュー（{ENVELOPE_SIZE_LABELS[envelopeSize]}・{orientation === "portrait" ? "縦向き" : "横向き"}）</p>
          {validRecipients.length > 1 && (
            <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
              <button
                type="button"
                onClick={() => setPreviewIndex(Math.max(0, safePreviewIndex - 1))}
                disabled={safePreviewIndex === 0}
                className="rounded-md bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800"
              >
                前の宛先
              </button>
              <span className="tabular-nums">
                {safePreviewIndex + 1} / {validRecipients.length}件目
              </span>
              <button
                type="button"
                onClick={() => setPreviewIndex(Math.min(validRecipients.length - 1, safePreviewIndex + 1))}
                disabled={safePreviewIndex >= validRecipients.length - 1}
                className="rounded-md bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800"
              >
                次の宛先
              </button>
            </div>
          )}
        </div>
        <EnvelopePreview
          envelopeSize={envelopeSize}
          writingMode={writingMode}
          orientation={orientation}
          honorific={honorific}
          style={style}
          recipient={previewPerson}
          sender={useSender ? sender : null}
        />
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          PDFと同じ配置で表示しています（フォントは実際のPDFと多少異なります）。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">宛先（{recipients.length}件）</p>
        {recipients.map((r, i) => (
          <PersonFields
            key={i}
            person={r}
            onChange={(p) => {
              const next = [...recipients];
              next[i] = p;
              setRecipients(next);
              clearResult();
            }}
            onRemove={recipients.length > 1 ? () => setRecipients(recipients.filter((_, idx) => idx !== i)) : undefined}
          />
        ))}
        <button
          type="button"
          onClick={() => setRecipients([...recipients, emptyPerson()])}
          className="w-fit rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
        >
          + 宛先を追加
        </button>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-medium">Excel/CSVから複数宛先をまとめて読み込む（任意）</p>
        <FileDropzone accept={ACCEPT} maxSizeMB={20} label="CSV/Excelをドラッグ&ドロップ" hint="またはタップして選択" onFilesSelected={handleImportFile} onError={setImportError} />
        {importError && <ErrorMessage message={importError} />}
        {importTable && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                郵便番号の列
                <select value={colPostal} onChange={(e) => setColPostal(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
                  <option value="">使用しない</option>
                  {importTable.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                住所の列
                <select value={colAddress} onChange={(e) => setColAddress(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
                  <option value="">使用しない</option>
                  {importTable.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                氏名の列
                <select value={colName} onChange={(e) => setColName(e.target.value)} className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
                  <option value="">使用しない</option>
                  {importTable.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            </div>
            <button type="button" onClick={applyImport} className="w-fit rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-200 dark:text-neutral-900">
              読み込んだ{importTable.rows.length}件を宛先に反映
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={useSender} onChange={(e) => { setUseSender(e.target.checked); clearResult(); }} />
          差出人を印刷する
        </label>
        {useSender && <PersonFields person={sender} onChange={(p) => { setSender(p); clearResult(); }} />}
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

      <ProcessingStatus state={status} successLabel="封筒PDFを作成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <RewardedDownloadGate onDownload={handleDownload} label="PDFをダウンロード" />
        </div>
      )}
    </div>
  );
}
