"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { usePdfThumbnails } from "@/components/common/pdf-thumbnails";
import { PdfCompressProcessor } from "@/lib/processors/browser/pdf";
import type { PdfCompressOutput } from "@/lib/processors/browser/pdf";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import {
  DEFAULT_PRESET_ID,
  IMAGE_QUALITY_MAX,
  IMAGE_QUALITY_MIN,
  MAX_EDGE_MAX,
  MAX_EDGE_MIN,
  PDF_COMPRESS_PRESETS,
  getPreset,
  matchPreset,
  parseIntegerSetting,
  sizeReduction,
  type PdfCompressPresetId,
  type PdfCompressSettings,
} from "@/lib/pdf/compress-settings";

/** 1つのPDFの先頭ページの縮小表示(圧縮前・圧縮後で同じ形式) */
function FirstPageThumb({ file, label, sizeBytes }: { file: File; label: string; sizeBytes: number }) {
  const { urls, loading, error } = usePdfThumbnails(file, 1, 200);
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <div className="flex min-h-40 w-[200px] max-w-full items-center justify-center overflow-hidden rounded-md border border-neutral-200 bg-white dark:border-neutral-700">
        {urls[1] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={urls[1]} alt={`${label}の先頭ページ`} data-testid="pdf-thumb" className="h-auto w-full" />
        ) : error ? (
          <span className="px-2 text-center text-xs text-red-600 dark:text-red-400">{error}</span>
        ) : (
          <span className="text-xs text-neutral-400">{loading ? "読み込み中…" : "…"}</span>
        )}
      </div>
      <figcaption className="text-xs text-neutral-600 dark:text-neutral-300">
        {label}: {formatBytes(sizeBytes)}
      </figcaption>
    </figure>
  );
}

/** 設定の入力（文字のまま持ち、確かめてから処理に渡す） */
interface SettingsInput {
  recompressImages: boolean;
  qualityText: string;
  edgeText: string;
  /** 画像を縮小しない（長辺の上限なし） */
  noResize: boolean;
}

function inputFromSettings(settings: PdfCompressSettings): SettingsInput {
  return {
    recompressImages: settings.recompressImages,
    qualityText: String(settings.imageQuality),
    edgeText: String(settings.maxImageEdge ?? getPreset(DEFAULT_PRESET_ID).settings.maxImageEdge),
    noResize: settings.maxImageEdge === null,
  };
}

/** 入力を確かめ、処理に渡せる設定にする。問題があれば、項目ごとのメッセージを返す */
function validateInput(input: SettingsInput): { settings: PdfCompressSettings | null; qualityError: string | null; edgeError: string | null } {
  const quality = parseIntegerSetting(input.qualityText, IMAGE_QUALITY_MIN, IMAGE_QUALITY_MAX, "画像の品質");
  const edge = input.noResize ? null : parseIntegerSetting(input.edgeText, MAX_EDGE_MIN, MAX_EDGE_MAX, "画像の長辺の上限");
  if (!input.recompressImages) {
    // 画像を変えない設定では、数値は使わない（入力の誤りがあっても圧縮できる）
    const fallback = getPreset("structure").settings;
    return { settings: fallback, qualityError: null, edgeError: null };
  }
  const qualityError = quality.ok ? null : quality.message;
  const edgeError = edge === null || edge.ok ? null : edge.message;
  if (!quality.ok || (edge !== null && !edge.ok)) return { settings: null, qualityError, edgeError };
  return {
    settings: { recompressImages: true, imageQuality: quality.value, maxImageEdge: edge === null ? null : (edge as { value: number }).value },
    qualityError: null,
    edgeError: null,
  };
}

function settingsLabel(settings: PdfCompressSettings): string {
  if (!settings.recompressImages) return "画像はそのまま（構造の整理のみ）";
  const preset = matchPreset(settings);
  const name = preset ? getPreset(preset).label : "自分で指定";
  return `${name}（画像の品質 ${settings.imageQuality}・長辺の上限 ${settings.maxImageEdge === null ? "なし" : `${settings.maxImageEdge}px`}）`;
}

/**
 * PDF圧縮。
 * 構造の最適化（pdf-lib）に加えて、PDFに埋め込まれたJPEG画像を、指定した品質・長辺の上限で作り直す（工程18）。
 * 初めての人は、そのまま「圧縮する」を押せば「標準」の設定で圧縮できる。プリセットを選ぶと、数値の欄にも値が入る。
 * 数値を変えただけでは処理しない（「圧縮する」を押したときに、その時点の設定で圧縮する）。
 * 結果は常に実測した元サイズ・圧縮後サイズをそのまま表示し、削減できなかった場合もその事実をそのまま伝える
 * （開発指示書■9・■24: 圧縮できたふりをする実装は禁止）。圧縮率そのものは指定できない。
 */
export function PdfCompressTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfCompressOutput | null>(null);
  const [input, setInput] = useState<SettingsInput>(() => inputFromSettings(getPreset(DEFAULT_PRESET_ID).settings));
  const checked = validateInput(input);
  const presetId: PdfCompressPresetId | null = checked.settings ? matchPreset(checked.settings) : null;

  // 設定を変えたら、前の設定で作った結果は捨てる（違う設定の結果をダウンロードさせない）
  function changeInput(next: SettingsInput) {
    setInput(next);
    setResult(null);
    if (status === "success") setStatus("idle");
  }

  // Phase 7: 生成結果のObject URL(result.url)は画面上で使っていないが、
  // 解放しないとページを離れるまでメモリに残り続けるため、明示的に解放する。
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file || !checked.settings) return;
    const settings = checked.settings;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new PdfCompressProcessor().process({ file, settings });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  // 圧縮後のPDFの先頭ページを表示するため、結果のBlobをFileにする
  const compressedFile = useMemo(
    () => (result ? new File([result.blob], "compressed.pdf", { type: "application/pdf" }) : null),
    [result]
  );

  const reduction = result ? sizeReduction(result.originalSizeBytes, result.compressedSizeBytes) : null;

  return (
    <PreviewSplitLayout
      previewWidth="md"
      preview={
        file ? (
        <section
          aria-label="圧縮前後のプレビュー"
          data-testid="tool-preview"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">圧縮前後の比較</p>
          <div className="flex flex-wrap items-start gap-6">
            <FirstPageThumb file={file} label="圧縮前" sizeBytes={file.size} />
            {result && compressedFile ? (
              <FirstPageThumb file={compressedFile} label="圧縮後" sizeBytes={result.compressedSizeBytes} />
            ) : (
              <div className="flex min-h-40 w-[200px] max-w-full items-center justify-center rounded-md border border-dashed border-neutral-300 px-3 text-center text-xs text-neutral-400 dark:border-neutral-700">結果がここに表示されます</div>
            )}
          </div>
          {result && (
            <div className="flex flex-col gap-1" aria-label="サイズの比較">
              <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className="h-2 rounded-full bg-neutral-400 dark:bg-neutral-500"
                  style={{ width: "100%" }}
                />
              </div>
              <div className="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className={`h-2 rounded-full ${
                    result.compressedSizeBytes <= result.originalSizeBytes ? "bg-green-600" : "bg-amber-500"
                  }`}
                  style={{
                    width: `${Math.min(100, (result.compressedSizeBytes / Math.max(1, result.originalSizeBytes)) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">上が圧縮前、下が圧縮後です。</p>
            </div>
          )}
        </section>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            PDFを選ぶと、ここにプレビューが表示されます
          </div>
        )
      }
    >
      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={100}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      <CompressSettingsPanel input={input} presetId={presetId} checked={checked} onChange={changeInput} />

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || !checked.settings} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          圧縮する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <div data-testid="compress-result" className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
            <p data-testid="compress-sizes">
              元のサイズ: {formatBytes(result.originalSizeBytes)} → 圧縮後:{" "}
              {formatBytes(result.compressedSizeBytes)}
            </p>
            {reduction && reduction.savedBytes > 0 ? (
              <p data-testid="compress-reduction" className="font-medium text-green-700 dark:text-green-400">
                {formatBytes(reduction.savedBytes)} 削減（{reduction.percent.toFixed(1)}%）
              </p>
            ) : reduction && reduction.savedBytes === 0 ? (
              <p data-testid="compress-reduction" className="text-neutral-500 dark:text-neutral-400">
                サイズは変わりませんでした（0.0%）。結果のPDFは正常に作成されています。
              </p>
            ) : reduction ? (
              <p data-testid="compress-reduction" className="text-neutral-500 dark:text-neutral-400">
                サイズが {formatBytes(-reduction.savedBytes)} 増えました（{reduction.percent.toFixed(1)}%）。結果のPDFは正常に作成されていますが、元のPDFを使うほうが小さく済みます。
              </p>
            ) : null}
            <p data-testid="compress-used-settings" className="text-xs text-neutral-500 dark:text-neutral-400">
              使った設定：{settingsLabel(result.settings)}
            </p>
            {result.imageStats && (
              <p data-testid="compress-image-stats" className="text-xs text-neutral-500 dark:text-neutral-400">
                {result.imageStats.imageCount === 0
                  ? "このPDFには画像がないため、画像の設定は使われませんでした。"
                  : `画像${result.imageStats.imageCount}個のうち、${result.imageStats.recompressed}個を作り直しました（うち縮小${result.imageStats.resized}個）。` +
                    (result.imageStats.skipped > 0 ? `JPEG以外などの対象外${result.imageStats.skipped}個は、そのままです。` : "") +
                    (result.imageStats.keptOriginal > 0 ? `作り直しても小さくならなかった${result.imageStats.keptOriginal}個は、元のままです。` : "")}
              </p>
            )}
            {result.hadSignature && (
              <p data-testid="compress-signature-warning" className="text-xs text-amber-800 dark:text-amber-300">
                このPDFには電子署名が含まれていました。圧縮して保存し直したため、署名は無効になっています。署名が必要な場合は、元のPDFを使ってください。
              </p>
            )}
          </div>
          <RewardedDownloadGate
            onDownload={() =>
              downloadBlob(result.blob, `${stripExtension(file?.name ?? "file")}-compressed.pdf`)
            }
          />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}

/** 圧縮の設定（プリセットと、画像の品質・長辺の上限の数値） */
function CompressSettingsPanel({
  input,
  presetId,
  checked,
  onChange,
}: {
  input: SettingsInput;
  presetId: PdfCompressPresetId | null;
  checked: ReturnType<typeof validateInput>;
  onChange: (next: SettingsInput) => void;
}) {
  const disabled = !input.recompressImages;
  const sliderValue = (text: string, min: number, max: number, fallback: number) => {
    const n = Number(text);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const presetButton = (id: PdfCompressPresetId) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      presetId === id ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
    }`;

  return (
    <fieldset data-testid="compress-settings" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <legend className="px-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">圧縮の設定</legend>
      <div role="group" aria-label="おすすめの設定" className="flex flex-wrap gap-2">
        {PDF_COMPRESS_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={presetId === p.id}
            data-testid={`compress-preset-${p.id}`}
            onClick={() => onChange(inputFromSettings(p.settings))}
            className={presetButton(p.id)}
          >
            {p.label}
            {p.id === DEFAULT_PRESET_ID ? "（おすすめ）" : ""}
          </button>
        ))}
      </div>
      <p data-testid="compress-preset-description" className="text-xs text-neutral-500 dark:text-neutral-400">
        {presetId ? getPreset(presetId).description : "数値を自分で指定しています。"}
      </p>

      <div className={`flex flex-col gap-3 ${disabled ? "opacity-50" : ""}`}>
        <div className="flex flex-col gap-1">
          <label htmlFor="compress-quality" className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
            画像の品質（{IMAGE_QUALITY_MIN}〜{IMAGE_QUALITY_MAX}）
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              aria-label="画像の品質（スライダー）"
              data-testid="compress-quality-slider"
              min={IMAGE_QUALITY_MIN}
              max={IMAGE_QUALITY_MAX}
              step={1}
              disabled={disabled}
              value={sliderValue(input.qualityText, IMAGE_QUALITY_MIN, IMAGE_QUALITY_MAX, 75)}
              onChange={(e) => onChange({ ...input, qualityText: e.target.value })}
              className="w-48 max-w-full"
            />
            <input
              id="compress-quality"
              type="number"
              inputMode="numeric"
              data-testid="compress-quality"
              min={IMAGE_QUALITY_MIN}
              max={IMAGE_QUALITY_MAX}
              step={1}
              disabled={disabled}
              value={input.qualityText}
              onChange={(e) => onChange({ ...input, qualityText: e.target.value })}
              aria-invalid={checked.qualityError ? true : undefined}
              className="w-20 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            高いほど画質を保ちやすく、低いほどサイズが小さくなりやすくなります（画質は下がります）。PDF内のJPEG画像に使います。
          </p>
          {checked.qualityError && (
            <p role="alert" data-testid="compress-quality-error" className="text-xs text-red-700 dark:text-red-400">
              {checked.qualityError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="compress-edge" className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
            画像の長辺の上限（{MAX_EDGE_MIN}〜{MAX_EDGE_MAX}px）
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="range"
              aria-label="画像の長辺の上限（スライダー）"
              data-testid="compress-edge-slider"
              min={MAX_EDGE_MIN}
              max={MAX_EDGE_MAX}
              step={100}
              disabled={disabled || input.noResize}
              value={sliderValue(input.edgeText, MAX_EDGE_MIN, MAX_EDGE_MAX, 2000)}
              onChange={(e) => onChange({ ...input, edgeText: e.target.value })}
              className="w-48 max-w-full"
            />
            <input
              id="compress-edge"
              type="number"
              inputMode="numeric"
              data-testid="compress-edge"
              min={MAX_EDGE_MIN}
              max={MAX_EDGE_MAX}
              step={1}
              disabled={disabled || input.noResize}
              value={input.edgeText}
              onChange={(e) => onChange({ ...input, edgeText: e.target.value })}
              aria-invalid={checked.edgeError ? true : undefined}
              className="w-24 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">px</span>
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                data-testid="compress-no-resize"
                disabled={disabled}
                checked={input.noResize}
                onChange={(e) => onChange({ ...input, noResize: e.target.checked })}
              />
              縮小しない
            </label>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            縦・横の長い方がこのピクセル数を超える画像だけを縮小します。小さくするほどサイズは減りやすく、拡大したときの細かさは下がります。
          </p>
          {checked.edgeError && (
            <p role="alert" data-testid="compress-edge-error" className="text-xs text-red-700 dark:text-red-400">
              {checked.edgeError}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="compress-reset"
          onClick={() => onChange(inputFromSettings(getPreset(DEFAULT_PRESET_ID).settings))}
          className="text-xs text-neutral-600 underline underline-offset-2 dark:text-neutral-300"
        >
          初期値に戻す
        </button>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        文字・図形・リンクは変わりません（文字の検索・選択もそのまま）。どれだけ小さくなるかはPDFの中身しだいで、圧縮率は指定できません。JPEG以外の画像はそのまま残ります。
      </p>
    </fieldset>
  );
}
