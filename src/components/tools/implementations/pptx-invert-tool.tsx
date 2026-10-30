"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { featureFlags } from "@/lib/config/features";
import { PptxInvertAiPanel } from "./pptx-invert-ai-panel";
import { PptxInvertProcessor, type PptxInvertOutput } from "@/lib/processors/browser/pptx-invert";
import { DEFAULT_COLOR_CHOICE, PALETTE_PRESETS, contrastRatio, normalizeHex, presetOf, type ColorChoice } from "@/lib/pptx/palette";
import { downloadBlob } from "@/lib/utils/format";
import { ImageCompare } from "./shared/image-compare";

const ACCEPT = ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

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

export function PptxInvertTool() {
  const [file, setFile] = useState<File | null>(null);
  const [invertImages, setInvertImages] = useState(true);
  const [brightenDarkText, setBrightenDarkText] = useState(false);
  const [enhanceText, setEnhanceText] = useState(true);
  const [reduceColorFringe, setReduceColorFringe] = useState(true);
  const [colors, setColors] = useState<ColorChoice>(DEFAULT_COLOR_CHOICE);
  const [customColors, setCustomColors] = useState(false);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PptxInvertOutput | null>(null);
  const [runId, setRunId] = useState(0);

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
      const output = await new PptxInvertProcessor().process({ file, options: { invertImages, enhanceText, reduceColorFringe, brightenDarkText, colors }, onProgress: setProgress });
      setResult(output);
      setRunId((n) => n + 1);
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
            <input type="checkbox" className="mt-1" checked={enhanceText} disabled={!invertImages} onChange={(e) => setEnhanceText(e.target.checked)} data-testid="pptx-option-enhance" />
            <span>
              画像の中の文字を、くっきり見やすくする
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">細い文字を明るく・少し太くし、文字のまわりのにじみ（二重に見える原因）を減らします。文書のような画像だけに使います。</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={reduceColorFringe || enhanceText} disabled={!invertImages || enhanceText} onChange={(e) => setReduceColorFringe(e.target.checked)} data-testid="pptx-option-fringe" />
            <span>
              文字の縁の細い色（オレンジや青）も、白黒として反転する
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">オンにすると、白い文字のまわりに色の輪が浮いて二重線に見えるのを防ぎます。赤い枠や色つきの図は、色のまま残ります。オフにすると、従来どおり色のついた部分はすべて残します。「画像の中の文字を、くっきり見やすくする」がオンのときは、この処理も自動で行われます（オフにして使い分けられます）。</span>
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
          disabled={status === "processing"} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          白黒を反転する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel={progress || "変換しています..."} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && imageSummary && (
        <ResultPopup testId="tool-preview" size="lg">
          {/* 結果の画面は、プレビューとダウンロードだけ。件数や判定の説明は、データ属性にだけ残す（自動テスト用） */}
          <div
            className="flex w-full flex-col gap-3"
            data-testid="pptx-result"
            data-slide-count={result.report.slideCount}
            data-inverted-images={imageSummary.inverted}
            data-total-images={imageSummary.total}
            data-palette-background={result.report.colorChoice.background}
            data-palette-text={result.report.colorChoice.text}
            data-notes={result.report.notes.join(" / ")}
          >
            {result.report.images.map((img) => (
              <div key={img.path} data-testid="pptx-image-row" data-outcome={img.outcome} data-image-name={img.path.split("/").pop() ?? img.path} className="w-full">
                <ImageCompare
                  items={[
                    { label: "変換前", bytes: img.before, mime: img.mime },
                    { label: "変換後", bytes: img.after, mime: img.mime, dark: true },
                  ]}
                />
              </div>
            ))}
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="PowerPointファイルをダウンロード" />
          {file && featureFlags.billing && <PptxInvertAiPanel key={runId} file={file} result={result} />}
        </ResultPopup>
      )}
    </div>
  );
}
