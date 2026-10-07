"use client";

import { useState } from "react";
import { EnvelopePreview } from "./shared/envelope-preview";
import { FileDropzone } from "@/components/common/file-dropzone";
import {
  ProcessingStatus,
  type ProcessingState,
} from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  EnvelopeAddressProcessor,
  validateEnvelopeAddressInput,
  buildEnvelopeFileName,
  type EnvelopeWritingMode,
  type EnvelopeOrientation,
  type EnvelopeHonorific,
  type EnvelopeBlocks,
  type EnvelopeFreeText,
} from "@/lib/processors/browser/envelope-address";
import {
  composeRecipientText,
  defaultBlocks,
  ENVELOPE_BLOCK_IDS,
  ENVELOPE_BLOCK_LABELS,
  HONORIFIC_LABELS,
  MAX_FONT_PT,
  MIN_FONT_PT,
  newFreeText,
  resolveBlocks,
  type EnvelopeBlockId,
} from "@/lib/print/envelope-layout";
import { resolveEnvelopePageSizePt } from "@/lib/print/envelope-sizes";
import { approxWidth } from "./shared/approx-text";
import { SliderField } from "@/components/common/slider-field";
import {
  ENVELOPE_SIZE_IDS,
  ENVELOPE_SIZE_LABELS,
  type EnvelopeSizeId,
} from "@/lib/print/envelope-sizes";
import { parseTableFile } from "@/lib/utils/table-file";
import { downloadBlob } from "@/lib/utils/format";

const ACCEPT =
  ".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

const ADDRESS_PLACEHOLDER = "〒100-0001\n東京都千代田区千代田1-1\n山田 太郎";

function AddressBox({
  value,
  label,
  onChange,
  onRemove,
}: {
  value: string;
  label: string;
  onChange: (v: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <textarea
        value={value}
        rows={3}
        aria-label={label}
        placeholder={ADDRESS_PLACEHOLDER}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-xs text-neutral-400 hover:text-red-500">
          削除
        </button>
      )}
    </div>
  );
}

export function EnvelopeAddressTool() {
  const [envelopeSize, setEnvelopeSize] = useState<EnvelopeSizeId>("chou3");
  const [writingMode, setWritingMode] =
    useState<EnvelopeWritingMode>("vertical");
  const [orientation, setOrientation] =
    useState<EnvelopeOrientation>("portrait");
  const [honorific, setHonorific] = useState<EnvelopeHonorific>("sama");
  const [blocks, setBlocks] = useState<EnvelopeBlocks>(defaultBlocks);
  const [freeTexts, setFreeTexts] = useState<EnvelopeFreeText[]>([]);
  const [nextFreeId, setNextFreeId] = useState(1);
  const [recipients, setRecipients] = useState<string[]>([""]);
  const [sender, setSender] = useState("");
  const [useSender, setUseSender] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);

  const [importTable, setImportTable] = useState<{
    headers: string[];
    rows: string[][];
  } | null>(null);
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

  /** 書字方向・封筒の向きが変わると標準の位置も変わるため、位置の指定だけをもとに戻す */
  function resetBlockPositions() {
    setBlocks((prev) => {
      const next = { ...prev };
      for (const id of ENVELOPE_BLOCK_IDS)
        next[id] = { ...prev[id], x: null, y: null };
      return next;
    });
  }

  function updateBlock(
    id: EnvelopeBlockId,
    patch: Partial<EnvelopeBlocks[EnvelopeBlockId]>,
  ) {
    setBlocks((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    clearResult();
  }

  function updateFree(id: string, patch: Partial<EnvelopeFreeText>) {
    setFreeTexts((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
    clearResult();
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
      setImportError(
        e instanceof Error ? e.message : "ファイルの読み込みに失敗しました",
      );
    }
  }

  function applyImport() {
    if (!importTable) return;
    const postalIdx = importTable.headers.indexOf(colPostal);
    const addressIdx = importTable.headers.indexOf(colAddress);
    const nameIdx = importTable.headers.indexOf(colName);
    const imported = importTable.rows.map((row) =>
      composeRecipientText({
        postalCode: postalIdx >= 0 ? (row[postalIdx] ?? "") : "",
        address: addressIdx >= 0 ? (row[addressIdx] ?? "") : "",
        name: nameIdx >= 0 ? (row[nameIdx] ?? "") : "",
      }),
    );
    setRecipients(imported.length > 0 ? imported : [""]);
    clearResult();
  }

  const input = {
    envelopeSize,
    writingMode,
    orientation,
    honorific,
    blocks,
    freeTexts,
    recipients,
    sender: useSender ? sender : null,
  };
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
  const validRecipients = recipients.filter((r) => r.trim() !== "");
  const safePreviewIndex = Math.min(
    previewIndex,
    Math.max(0, validRecipients.length - 1),
  );
  const previewPerson = validRecipients[safePreviewIndex];

  // スライダーの現在値（位置を指定していない項目は、標準の位置）
  const pageSize = resolveEnvelopePageSizePt(envelopeSize, orientation);
  const placements = resolveBlocks(
    {
      width: pageSize.width,
      height: pageSize.height,
      writingMode,
      honorific,
      blocks,
      freeTexts,
      recipient: previewPerson,
      sender: useSender ? sender : null,
    },
    approxWidth,
  );
  const visibleBlockIds = ENVELOPE_BLOCK_IDS.filter(
    (id) => useSender || id !== "sender",
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)] lg:items-start">
      {/* プレビュー: 設定を操作しているあいだも見えるように、画面に固定する（スマホは下部、PC幅は右側） */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-white/95 px-2 pb-2 pt-1 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95 lg:sticky lg:inset-x-auto lg:bottom-auto lg:top-20 lg:order-2 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none lg:dark:bg-transparent">
        <div
          data-testid="tool-preview"
          className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800 lg:p-4"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              プレビュー（{ENVELOPE_SIZE_LABELS[envelopeSize]}・
              {orientation === "portrait" ? "縦向き" : "横向き"}）
            </p>
            {validRecipients.length > 1 && (
              <div className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
                <button
                  type="button"
                  onClick={() =>
                    setPreviewIndex(Math.max(0, safePreviewIndex - 1))
                  }
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
                  onClick={() =>
                    setPreviewIndex(
                      Math.min(
                        validRecipients.length - 1,
                        safePreviewIndex + 1,
                      ),
                    )
                  }
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
            blocks={blocks}
            freeTexts={freeTexts}
            recipient={previewPerson}
            sender={useSender ? sender : null}
          />
          <p className="mt-2 hidden text-xs text-neutral-500 dark:text-neutral-400 lg:block">
            PDFと同じ配置で表示しています（フォントは実際のPDFと多少異なります）。
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-6 pb-[42vh] lg:order-1 lg:pb-0">
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">
              封筒サイズ
            </span>
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
                    envelopeSize === id
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {ENVELOPE_SIZE_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">
              書字方向
            </span>
            <div className="flex gap-2">
              {(["vertical", "horizontal"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setWritingMode(mode);
                    resetBlockPositions();
                    // 封筒の向きは書字方向とは独立。ここでは変えない
                    clearResult();
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    writingMode === mode
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
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
            <span className="text-neutral-600 dark:text-neutral-300">
              封筒の向き
            </span>
            <div className="flex gap-2">
              {(["portrait", "landscape"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={orientation === o}
                  onClick={() => {
                    setOrientation(o);
                    resetBlockPositions();
                    clearResult();
                  }}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    orientation === o
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {o === "portrait" ? "縦向き" : "横向き"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">
              敬称（宛先の最後の行につきます）
            </span>
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
                    honorific === h
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {HONORIFIC_LABELS[h]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium">
            文字の大きさ・位置（スライダーで調整。PDFと同じ配置がプレビューに出ます）
          </p>
          {visibleBlockIds.map((id) => {
            const label = ENVELOPE_BLOCK_LABELS[id];
            const pl = placements[id];
            const b = blocks[id];
            return (
              <details
                key={id}
                open={id === "recipient"}
                className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <summary className="cursor-pointer text-sm font-medium">
                  {label}
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-3">
                  <SliderField
                    label="文字サイズ"
                    ariaLabel={`${label}の文字サイズ`}
                    value={pl.size}
                    min={MIN_FONT_PT}
                    max={MAX_FONT_PT}
                    unit="pt"
                    onChange={(v) => updateBlock(id, { size: v })}
                  />
                  <SliderField
                    label="X"
                    ariaLabel={`${label}のX位置`}
                    value={pl.xPct}
                    min={0}
                    max={100}
                    step={0.5}
                    unit="%"
                    onChange={(v) => updateBlock(id, { x: v })}
                  />
                  <SliderField
                    label="Y"
                    ariaLabel={`${label}のY位置`}
                    value={pl.yPct}
                    min={0}
                    max={100}
                    step={0.5}
                    unit="%"
                    onChange={(v) => updateBlock(id, { y: v })}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={b.bold}
                      onChange={(e) =>
                        updateBlock(id, { bold: e.target.checked })
                      }
                    />
                    {label}を太字にする
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      updateBlock(id, { size: null, x: null, y: null })
                    }
                    className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  >
                    {label}を標準に戻す
                  </button>
                </div>
              </details>
            );
          })}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium">
            自由に入力するテキスト（「在中」「請求書在中」など。すべての封筒に同じ位置で印刷）
          </p>
          {freeTexts.map((f, i) => (
            <div
              key={f.id}
              className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
            >
              <div className="flex items-start gap-2">
                <textarea
                  value={f.text}
                  rows={2}
                  aria-label={`自由テキスト${i + 1}の内容`}
                  placeholder="印刷する文字を入力（改行できます）"
                  onChange={(e) => updateFree(f.id, { text: e.target.value })}
                  className="flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
                <button
                  type="button"
                  onClick={() => {
                    setFreeTexts((prev) => prev.filter((x) => x.id !== f.id));
                    clearResult();
                  }}
                  className="text-xs text-neutral-400 hover:text-red-500"
                >
                  削除
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <SliderField
                  label="文字サイズ"
                  ariaLabel={`自由テキスト${i + 1}の文字サイズ`}
                  value={f.size}
                  min={MIN_FONT_PT}
                  max={MAX_FONT_PT}
                  unit="pt"
                  onChange={(v) => updateFree(f.id, { size: v })}
                />
                <SliderField
                  label="X"
                  ariaLabel={`自由テキスト${i + 1}のX位置`}
                  value={f.x}
                  min={0}
                  max={100}
                  step={0.5}
                  unit="%"
                  onChange={(v) => updateFree(f.id, { x: v })}
                />
                <SliderField
                  label="Y"
                  ariaLabel={`自由テキスト${i + 1}のY位置`}
                  value={f.y}
                  min={0}
                  max={100}
                  step={0.5}
                  unit="%"
                  onChange={(v) => updateFree(f.id, { y: v })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={f.bold}
                  onChange={(e) => updateFree(f.id, { bold: e.target.checked })}
                />
                自由テキスト{i + 1}を太字にする
              </label>
            </div>
          ))}
          <button
            type="button"
            onClick={() => {
              setFreeTexts((prev) => [
                ...prev,
                newFreeText(`free-${nextFreeId}`, {
                  x: 8,
                  y: 8 + prev.length * 6,
                }),
              ]);
              setNextFreeId((n) => n + 1);
              clearResult();
            }}
            className="w-fit rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
          >
            + 自由に入力するテキストを追加
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium">宛先（{recipients.length}件）</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            郵便番号・住所・氏名を、1つの枠に自由に入力します（改行できます。敬称は最後の行につきます）。
          </p>
          {recipients.map((r, i) => (
            <AddressBox
              key={i}
              value={r}
              label={`宛先${i + 1}`}
              onChange={(v) => {
                const next = [...recipients];
                next[i] = v;
                setRecipients(next);
                clearResult();
              }}
              onRemove={
                recipients.length > 1
                  ? () => setRecipients(recipients.filter((_, idx) => idx !== i))
                  : undefined
              }
            />
          ))}
          <button
            type="button"
            onClick={() => setRecipients([...recipients, ""])}
            className="w-fit rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200"
          >
            + 宛先を追加
          </button>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium">
            Excel/CSVから複数宛先をまとめて読み込む（任意）
          </p>
          <FileDropzone
            accept={ACCEPT}
            maxSizeMB={20}
            label="CSV/Excelをドラッグ&ドロップ"
            hint="またはタップして選択"
            onFilesSelected={handleImportFile}
            onError={setImportError}
          />
          {importError && <ErrorMessage message={importError} />}
          {importTable && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  郵便番号の列
                  <select
                    value={colPostal}
                    onChange={(e) => setColPostal(e.target.value)}
                    className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">使用しない</option>
                    {importTable.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  住所の列
                  <select
                    value={colAddress}
                    onChange={(e) => setColAddress(e.target.value)}
                    className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">使用しない</option>
                    {importTable.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  氏名の列
                  <select
                    value={colName}
                    onChange={(e) => setColName(e.target.value)}
                    className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="">使用しない</option>
                    {importTable.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                type="button"
                onClick={applyImport}
                className="w-fit rounded-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-200 dark:text-neutral-900"
              >
                読み込んだ{importTable.rows.length}件を宛先に反映
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={useSender}
              onChange={(e) => {
                setUseSender(e.target.checked);
                clearResult();
              }}
            />
            差出人を印刷する
          </label>
          {useSender && (
            <AddressBox
              value={sender}
              label="差出人"
              onChange={(v) => {
                setSender(v);
                clearResult();
              }}
            />
          )}
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
            <RewardedDownloadGate
              onDownload={handleDownload}
              label="PDFをダウンロード"
            />
          </div>
        )}
      </div>
    </div>
  );
}
