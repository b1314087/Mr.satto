"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PptxInvertProcessor, type PptxInvertOutput } from "@/lib/processors/browser/pptx-invert";
import type { ImageOutcome, ImageReport } from "@/lib/pptx/invert-pptx";
import { DEFAULT_COLOR_CHOICE, PALETTE_PRESETS, contrastRatio, normalizeHex, presetOf, type ColorChoice } from "@/lib/pptx/palette";
import { downloadBlob, formatBytes } from "@/lib/utils/format";
import { useObjectUrl } from "@/lib/utils/use-object-url";

const ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

const OUTCOME_LABEL: Record<ImageOutcome, string> = {
  inverted: "白黒と判定 → 反転",
  "inverted-gray": "白黒が中心 → 白黒部分だけ反転",
  "kept-color": "カラーと判定 → そのまま",
  "kept-transparent": "透明な画像 → そのまま",
  unsupported: "この形式は反転できない → そのまま",
  "too-large": "大きすぎる → そのまま",
  failed: "読み込めない → そのまま",
  "skipped-option": "画像は反転しない設定 → そのまま",
};

function useBlobUrl(bytes: Uint8Array | undefined, mime: string | undefined): string | null {
  // 画像の表示用のURL。作成・解放は共通フックが担当する（画面から外れたら解放。開発モードでも壊れない）
  const blob = useMemo(() => (bytes ? new Blob([bytes as BlobPart], { type: mime ?? "image/png" }) : null), [bytes, mime]);
  return useObjectUrl(blob);
}

/** 色見本（背景色の上に、文字色で「Aa」を表示する） */
function Swatch({ background, text, className = "" }: { background: string; text: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-9 w-12 shrink-0 items-center justify-center rounded-md border border-neutral-400/60 text-sm font-semibold ${className}`}
      style={{ backgroundColor: `#${background}`, color: `#${text}` }}
    >
      Aa
    </span>
  );
}

/** 色を1つ選ぶ欄（カラーピッカー＋16進の入力。ピッカーが使えない環境でも、16進を入力できる） */
function ColorField({ label, value, onChange, testId }: { label: string; value: string; onChange: (hex: string) => void; testId: string }) {
  // 入力の途中（まだ6桁になっていない文字）は、draft に持つ。正しい色になった時点で反映する
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? `#${value}`;
  const invalid = draft !== null && normalizeHex(draft) === null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="color"
          aria-label={`${label}を選ぶ`}
          value={`#${value.toLowerCase()}`}
          onChange={(e) => {
            const hex = normalizeHex(e.target.value);
            if (hex) {
              setDraft(null);
              onChange(hex);
            }
          }}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-neutral-300 bg-transparent p-0.5 dark:border-neutral-700"
          data-testid={`${testId}`}
        />
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          maxLength={7}
          aria-label={`${label}（16進カラーコード）`}
          aria-invalid={invalid}
          value={shown}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            const hex = normalizeHex(text);
            if (hex) onChange(hex);
          }}
          onBlur={() => setDraft(null)}
          className={`min-w-0 w-28 rounded-lg border bg-white px-2 py-1.5 font-mono text-sm uppercase text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100 ${invalid ? "border-red-500" : "border-neutral-300 dark:border-neutral-700"}`}
          data-testid={`${testId}-hex`}
        />
      </div>
    </div>
  );
}

/** 反転後の配色を選ぶ（プリセット3つ＋自由指定） */
function PaletteSelector({ colors, custom, onPreset, onCustom, onColors }: { colors: ColorChoice; custom: boolean; onPreset: (c: ColorChoice) => void; onCustom: () => void; onColors: (c: ColorChoice) => void }) {
  const selectedPreset = custom ? null : presetOf(colors);
  const ratio = contrastRatio(colors.background, colors.text);
  const card = "flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border border-neutral-200 p-2 text-sm text-neutral-800 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:checked]:ring-1 has-[:checked]:ring-blue-600 dark:border-neutral-700 dark:text-neutral-100 dark:has-[:checked]:bg-blue-950/40";
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" data-testid="pptx-palette">
      <legend className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">反転後の配色</legend>
      <div className="grid grid-cols-1 gap-2 min-[520px]:grid-cols-2">
        {PALETTE_PRESETS.map((p) => (
          <label key={p.id} className={card}>
            <input type="radio" name="pptx-palette" checked={selectedPreset?.id === p.id} onChange={() => onPreset({ background: p.background, text: p.text })} data-testid={`pptx-palette-${p.id}`} />
            <Swatch background={p.background} text={p.text} />
            <span className="min-w-0">
              {p.name}
              <span className="block break-all font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                #{p.background} / #{p.text}
              </span>
            </span>
          </label>
        ))}
        <label className={card}>
          <input type="radio" name="pptx-palette" checked={custom} onChange={onCustom} data-testid="pptx-palette-custom" />
          <Swatch background={colors.background} text={colors.text} className={custom ? "" : "opacity-40"} />
          <span className="min-w-0">
            自由に指定する
            <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">背景色と文字色を選びます</span>
          </span>
        </label>
      </div>
      {custom && (
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-3 min-[520px]:grid-cols-2 dark:border-neutral-700" data-testid="pptx-palette-custom-fields">
          <ColorField label="背景色（元の白）" value={colors.background} onChange={(hex) => onColors({ ...colors, background: hex })} testId="pptx-color-bg" />
          <ColorField label="文字色（元の黒）" value={colors.text} onChange={(hex) => onColors({ ...colors, text: hex })} testId="pptx-color-text" />
        </div>
      )}
      {ratio !== null && ratio < 3 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="pptx-palette-contrast-warning">
          背景色と文字色が近く、文字が読みにくくなる可能性があります。
        </p>
      )}
    </fieldset>
  );
}

function Thumb({ bytes, mime, label, dark }: { bytes?: Uint8Array; mime?: string; label: string; dark?: boolean }) {
  const url = useBlobUrl(bytes, mime);
  if (!bytes) return <div className="h-16 w-24 rounded border border-dashed border-neutral-300 dark:border-neutral-700" aria-hidden />;
  return (
    <figure className="flex flex-col items-center gap-1">
      {/* 透明な部分が分かるよう、背景に市松ではなく単色（元の色）を敷く */}
      <div className={`flex h-16 w-24 items-center justify-center overflow-hidden rounded border border-neutral-300 dark:border-neutral-700 ${dark ? "bg-neutral-500" : "bg-neutral-200"}`}>
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="max-h-full max-w-full object-contain" />
        )}
      </div>
      <figcaption className="text-[11px] text-neutral-500 dark:text-neutral-400">{label}</figcaption>
    </figure>
  );
}

function ImageRow({ image }: { image: ImageReport }) {
  const name = image.path.split("/").pop() ?? image.path;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800" data-testid="pptx-image-row" data-outcome={image.outcome}>
      <Thumb bytes={image.before} mime={image.mime} label="変換前" />
      {image.after ? <Thumb bytes={image.after} mime={image.mime} label="変換後" dark /> : null}
      <div className="min-w-0 text-xs">
        <p className="break-all font-medium text-neutral-800 dark:text-neutral-100">{name}</p>
        <p className="text-neutral-600 dark:text-neutral-300">{OUTCOME_LABEL[image.outcome]}</p>
        {image.coloredRatio !== undefined && (
          <p className="text-neutral-500 dark:text-neutral-400">
            {image.width}×{image.height}px ／ 色のついた部分 {(image.coloredRatio * 100).toFixed(1)}%
          </p>
        )}
      </div>
    </li>
  );
}

export function PptxInvertTool() {
  const [file, setFile] = useState<File | null>(null);
  const [invertImages, setInvertImages] = useState(true);
  const [brightenDarkText, setBrightenDarkText] = useState(false);
  const [colors, setColors] = useState<ColorChoice>(DEFAULT_COLOR_CHOICE);
  const [customColors, setCustomColors] = useState(false);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PptxInvertOutput | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setProgress("");
    setError(null);
    setResult(null);
    try {
      const output = await new PptxInvertProcessor().process({ file, options: { invertImages, brightenDarkText, colors }, onProgress: setProgress });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!result) return;
    downloadBlob(result.blob, result.suggestedName);
  }

  const imageSummary = useMemo(() => {
    if (!result) return null;
    const imgs = result.report.images;
    const inverted = imgs.filter((i) => i.outcome === "inverted" || i.outcome === "inverted-gray").length;
    return { total: imgs.length, inverted, kept: imgs.length - inverted };
  }, [result]);

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={150}
        label="PowerPointファイル（.pptx）をドラッグ&ドロップ"
        hint="またはタップして選択（元のファイルは変更されません）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => { setFile(null); setResult(null); setStatus("idle"); }} />}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <PaletteSelector
            colors={colors}
            custom={customColors}
            onPreset={(c) => {
              setCustomColors(false);
              setColors(c);
            }}
            onCustom={() => setCustomColors(true)}
            onColors={setColors}
          />
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={invertImages} onChange={(e) => setInvertImages(e.target.checked)} data-testid="pptx-option-images" />
            <span>
              白黒と判定できる画像も反転する
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={brightenDarkText} onChange={(e) => setBrightenDarkText(e.target.checked)} data-testid="pptx-option-brighten" />
            <span>
              濃い色の文字を明るくして、黒背景で読みやすくする
            </span>
          </label>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          白黒を反転する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel={progress || "変換しています..."} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && imageSummary && (
        <ResultPopup testId="tool-preview" size="lg">
          <div className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-200" data-testid="pptx-applied-palette">
            <Swatch background={result.report.colorChoice.background} text={result.report.colorChoice.text} />
            <span>
              適用した配色: 背景 #{result.report.colorChoice.background} ／ 文字 #{result.report.colorChoice.text}
            </span>
          </div>
          <dl className="grid w-full grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">スライド数</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100" data-testid="pptx-slide-count">{result.report.slideCount}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">反転した色</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.report.colors.inverted}か所</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">そのままの色</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.report.colors.kept}か所</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">画像（反転／全体）</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{imageSummary.inverted}／{imageSummary.total}</dd>
            </div>
          </dl>

          {result.report.images.length > 0 && (
            <div className="w-full">
              <h3 className="mb-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">画像の判定</h3>
              <ul className="flex flex-col gap-2">
                {result.report.images.map((img) => (
                  <ImageRow key={img.path} image={img} />
                ))}
              </ul>
            </div>
          )}

          {result.report.notes.length > 0 && (
            <div className="w-full" data-testid="pptx-notes">
              <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">確認してください</h3>
              <ul className="list-disc pl-5 text-xs text-neutral-600 dark:text-neutral-300">
                {result.report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-neutral-500 dark:text-neutral-400">変換後: {result.suggestedName}（{formatBytes(result.sizeBytes)}）</p>
          <RewardedDownloadGate onDownload={handleDownload} label="PowerPointファイルをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
