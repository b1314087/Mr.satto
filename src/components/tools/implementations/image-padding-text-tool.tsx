"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { SliderField } from "@/components/common/slider-field";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImagePaddingTextProcessor,
  type PaddingTextBandAlign,
  type PaddingTextEdge,
  type PaddingTextEdgeAlign,
  type PaddingTextHAlign,
} from "@/lib/processors/browser/image-padding-text";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { mmToPt, ptToMm } from "@/lib/print/paper-sizes";
import { createZip, type ZipEntry } from "@/lib/utils/zip";
import { downloadBlob, dedupeFileNames, formatBytes, stripExtension } from "@/lib/utils/format";

// 透明背景をプレビューで分かりやすく示す市松模様。
// electronic-stamp-generator-tool.tsx / image-merge-tool.tsx と同じ配色・寸法。
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, #d4d4d4 25%, transparent 25%), linear-gradient(-45deg, #d4d4d4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d4 75%), linear-gradient(-45deg, transparent 75%, #d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  backgroundColor: "#f5f5f5",
};

type Unit = "px" | "mm";
type OutputFormat = "png" | "jpeg";

interface EditableSettings {
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  background: string;
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
  textAlign: PaddingTextHAlign;
  edge: PaddingTextEdge;
  edgeAlign: PaddingTextEdgeAlign;
  bandAlign: PaddingTextBandAlign;
}

interface PerImageState {
  noText: boolean;
  /** 空オブジェクトの場合は「共通設定を使用」を意味する */
  overrides: Partial<EditableSettings>;
}

const DEFAULT_SETTINGS: EditableSettings = {
  paddingTop: 0,
  paddingBottom: 60,
  paddingLeft: 0,
  paddingRight: 0,
  background: "#ffffff",
  text: "",
  fontSize: 24,
  bold: false,
  color: "#111111",
  textAlign: "center",
  edge: "bottom",
  edgeAlign: "center",
  bandAlign: "center",
};

const EDGE_OPTIONS: { id: PaddingTextEdge; label: string }[] = [
  { id: "top", label: "上" },
  { id: "bottom", label: "下" },
  { id: "left", label: "左" },
  { id: "right", label: "右" },
];

const EDGE_ALIGN_OPTIONS: { id: PaddingTextEdgeAlign; label: string }[] = [
  { id: "start", label: "始点(左/上)" },
  { id: "center", label: "中央" },
  { id: "end", label: "終点(右/下)" },
];

const BAND_ALIGN_OPTIONS: { id: PaddingTextBandAlign; label: string }[] = [
  { id: "near", label: "写真に近い側" },
  { id: "center", label: "中央" },
  { id: "far", label: "外側" },
];

const TEXT_ALIGN_OPTIONS: { id: PaddingTextHAlign; label: string }[] = [
  { id: "left", label: "左揃え" },
  { id: "center", label: "中央揃え" },
  { id: "right", label: "右揃え" },
];

const BACKGROUND_PRESETS: { id: string; label: string; value: string }[] = [
  { id: "white", label: "白", value: "#ffffff" },
  { id: "black", label: "黒", value: "#000000" },
  { id: "transparent", label: "透明", value: "transparent" },
];

const MAX_PADDING_PX = 4000;
const MAX_FONT_SIZE = 400;

function toggleButtonClass(active: boolean, size: "sm" | "xs" = "sm"): string {
  const padding = size === "sm" ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs";
  return `rounded-lg font-medium ${padding} ${
    active
      ? "bg-blue-600 text-white"
      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

function pxToDisplay(px: number, unit: Unit): number {
  if (unit === "px") return Math.round(px);
  return Math.round(ptToMm(px) * 10) / 10;
}

function displayToPx(value: number, unit: Unit): number {
  if (unit === "px") return Math.round(value);
  return Math.round(mmToPt(value));
}

/**
 * 共通設定・個別設定の両方で使い回す設定フォーム。
 * 同じUIを2箇所に書かないための共有コンポーネント。
 */
function SettingsFields({
  values,
  onChange,
  unit,
}: {
  values: EditableSettings;
  onChange: <K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) => void;
  unit: Unit;
}) {
  const unitLabel = unit === "px" ? "px" : "mm";
  const [uniformValue, setUniformValue] = useState(0);

  function paddingField(key: "paddingTop" | "paddingBottom" | "paddingLeft" | "paddingRight", label: string) {
    return (
      <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
        {label}
        <input
          type="number"
          min={0}
          max={unit === "px" ? MAX_PADDING_PX : Math.round(ptToMm(MAX_PADDING_PX))}
          value={pxToDisplay(values[key], unit)}
          onChange={(e) => onChange(key, displayToPx(Number(e.target.value), unit))}
          className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        {unitLabel}
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">余白</p>
        <div className="flex flex-wrap items-center gap-3">
          {paddingField("paddingTop", "上")}
          {paddingField("paddingBottom", "下")}
          {paddingField("paddingLeft", "左")}
          {paddingField("paddingRight", "右")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={0}
            value={uniformValue}
            onChange={(e) => setUniformValue(Number(e.target.value))}
            className="w-20 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{unitLabel}</span>
          <button
            type="button"
            onClick={() => {
              const px = displayToPx(uniformValue, unit);
              onChange("paddingTop", px);
              onChange("paddingBottom", px);
              onChange("paddingLeft", px);
              onChange("paddingRight", px);
            }}
            className={toggleButtonClass(false, "xs")}
          >
            4辺を同じ値にする
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">背景</p>
        <div className="flex flex-wrap items-center gap-2">
          {BACKGROUND_PRESETS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange("background", opt.value)}
              className={toggleButtonClass(values.background === opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
            カスタム
            <input
              type="color"
              value={values.background === "transparent" ? "#ffffff" : values.background}
              onChange={(e) => onChange("background", e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-neutral-300 dark:border-neutral-700"
            />
          </label>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          JPEGで保存する場合、透明は白背景になります。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">文字</p>
        <textarea
          value={values.text}
          onChange={(e) => onChange("text", e.target.value)}
          placeholder="余白に表示する文字（複数行可）"
          rows={2}
          className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-72">
            <SliderField label="文字サイズ" value={values.fontSize} min={6} max={MAX_FONT_SIZE} unit="px" onChange={(v) => onChange("fontSize", v)} />
          </div>
          <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
            色
            <input
              type="color"
              value={values.color}
              onChange={(e) => onChange("color", e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-neutral-300 dark:border-neutral-700"
            />
          </label>
          <button
            type="button"
            onClick={() => onChange("bold", !values.bold)}
            className={toggleButtonClass(values.bold, "xs")}
          >
            太字
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {TEXT_ALIGN_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange("textAlign", opt.id)}
              className={toggleButtonClass(values.textAlign === opt.id, "xs")}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">配置する余白</p>
          <div className="flex flex-wrap gap-2">
            {EDGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange("edge", opt.id)}
                className={toggleButtonClass(values.edge === opt.id, "xs")}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">余白内の位置（沿った方向）</p>
          <div className="flex flex-wrap gap-2">
            {EDGE_ALIGN_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange("edgeAlign", opt.id)}
                className={toggleButtonClass(values.edgeAlign === opt.id, "xs")}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">余白内の位置（縦位置・厚み方向）</p>
          <div className="flex flex-wrap gap-2">
            {BAND_ALIGN_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange("bandAlign", opt.id)}
                className={toggleButtonClass(values.bandAlign === opt.id, "xs")}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          選択した余白の幅・高さが0pxの場合、その余白には文字が表示されません。
        </p>
      </div>
    </div>
  );
}

export function ImagePaddingTextTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [common, setCommon] = useState<EditableSettings>(DEFAULT_SETTINGS);
  const [perImage, setPerImage] = useState<Map<File, PerImageState>>(new Map());
  // 画像削除等でfiles.lengthが縮んだ場合に範囲外を指さないよう、
  // 生のindexをそのままstateにせず、毎回レンダー時に丸めた値を使う
  // （useEffectでのクランプはcascading renderを招くため避ける）。
  const [rawIndex, setRawIndex] = useState(0);
  const currentIndex = Math.min(rawIndex, Math.max(0, files.length - 1));
  const [unit, setUnit] = useState<Unit>("px");
  const [format, setFormat] = useState<OutputFormat>("png");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentResult, setCurrentResult] = useState<{ blob: Blob; name: string } | null>(null);
  const [batchResult, setBatchResult] = useState<{ blob: Blob; name: string; count: number } | null>(null);

  const [previewResult, setPreviewResult] = useState<ImageProcessorOutput | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRunIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (previewResult) URL.revokeObjectURL(previewResult.url);
    };
  }, [previewResult]);

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setBatchResult(null);
    setCurrentResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function getState(file: File): PerImageState {
    return perImage.get(file) ?? { noText: false, overrides: {} };
  }

  function resolveSettings(file: File): EditableSettings {
    const state = getState(file);
    const merged = { ...common, ...state.overrides };
    if (state.noText) merged.text = "";
    return merged;
  }

  const currentFile: File | undefined = files[currentIndex];
  const currentState = currentFile ? getState(currentFile) : null;
  const isIndividual = !!currentState && Object.keys(currentState.overrides).length > 0;
  const currentSettings = currentFile ? resolveSettings(currentFile) : null;

  function setUseIndividual(useIndividual: boolean) {
    if (!currentFile) return;
    setPerImage((prev) => {
      const next = new Map(prev);
      const state = next.get(currentFile) ?? { noText: false, overrides: {} };
      next.set(currentFile, {
        ...state,
        overrides: useIndividual ? { ...common, ...state.overrides } : {},
      });
      return next;
    });
  }

  function updateIndividualField<K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) {
    if (!currentFile) return;
    setPerImage((prev) => {
      const next = new Map(prev);
      const state = next.get(currentFile) ?? { noText: false, overrides: {} };
      next.set(currentFile, { ...state, overrides: { ...state.overrides, [key]: value } });
      return next;
    });
  }

  function setCurrentNoText(noText: boolean) {
    if (!currentFile) return;
    setPerImage((prev) => {
      const next = new Map(prev);
      const state = next.get(currentFile) ?? { noText: false, overrides: {} };
      next.set(currentFile, { ...state, noText });
      return next;
    });
  }

  function updateCommonField<K extends keyof EditableSettings>(key: K, value: EditableSettings[K]) {
    setCommon((c) => ({ ...c, [key]: value }));
  }

  // ライブプレビュー：現在表示中の1枚だけを対象に、設定変更後500msデバウンスして
  // 実際のProcessorを呼ぶ（画像結合ツールと同じ考え方。複数画像を毎回まとめて
  // 再処理しない設計にすることで、大量画像でも重い処理を繰り返さないようにする）。
  useEffect(() => {
    if (!currentFile || !currentSettings) {
      // 画像未選択時はプレビューをクリアする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviewResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
      setPreviewLoading(false);
      return;
    }
    const runId = ++previewRunIdRef.current;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const output = await new ImagePaddingTextProcessor().process({
            file: currentFile,
            ...currentSettings,
            format,
          });
          if (previewRunIdRef.current !== runId) {
            URL.revokeObjectURL(output.url);
            return;
          }
          setPreviewResult((prev) => {
            if (prev) URL.revokeObjectURL(prev.url);
            return output;
          });
          setPreviewLoading(false);
        } catch {
          if (previewRunIdRef.current === runId) setPreviewLoading(false);
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
    // currentSettingsはレンダーのたびに新しいオブジェクト参照になるため、
    // 依存配列にはオブジェクトそのものではなく個々のプリミティブ値を並べる
    // （参照が毎回変わることでデバウンスタイマーが無駄にリセットされるのを防ぐ）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentFile,
    format,
    currentSettings?.paddingTop,
    currentSettings?.paddingBottom,
    currentSettings?.paddingLeft,
    currentSettings?.paddingRight,
    currentSettings?.background,
    currentSettings?.text,
    currentSettings?.fontSize,
    currentSettings?.bold,
    currentSettings?.color,
    currentSettings?.textAlign,
    currentSettings?.edge,
    currentSettings?.edgeAlign,
    currentSettings?.bandAlign,
  ]);

  async function handleSaveCurrent() {
    if (!currentFile || !currentSettings) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImagePaddingTextProcessor().process({
        file: currentFile,
        ...currentSettings,
        format,
      });
      URL.revokeObjectURL(output.url);
      const ext = format === "jpeg" ? "jpg" : "png";
      const name = `${stripExtension(currentFile.name)}_余白文字入れ.${ext}`;
      setCurrentResult({ blob: output.blob, name });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  async function handleExportAll() {
    if (files.length === 0) return;
    setStatus("processing");
    setError(null);
    try {
      const ext = format === "jpeg" ? "jpg" : "png";
      const outputs: { name: string; blob: Blob }[] = [];
      for (const file of files) {
        const settings = resolveSettings(file);
        const output = await new ImagePaddingTextProcessor().process({
          file,
          ...settings,
          format,
        });
        URL.revokeObjectURL(output.url);
        outputs.push({ name: `${stripExtension(file.name)}_余白文字入れ.${ext}`, blob: output.blob });
      }

      const uniqueNames = dedupeFileNames(outputs.map((o) => o.name));

      if (outputs.length === 1) {
        setBatchResult({ blob: outputs[0].blob, name: uniqueNames[0], count: 1 });
      } else {
        const entries: ZipEntry[] = outputs.map((o, i) => ({ name: uniqueNames[i], blob: o.blob }));
        const zipBlob = await createZip(entries);
        const zipName = `${stripExtension(files[0].name) || "images"}_余白文字入れ.zip`;
        setBatchResult({ blob: zipBlob, name: zipName, count: outputs.length });
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <PreviewSplitLayout
      preview={
        files.length > 0 && currentFile ? (
        <div data-testid="tool-preview" className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            プレビュー（{currentIndex + 1}枚目）
            {previewResult && (
              <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                {previewResult.width} × {previewResult.height}px
                {previewLoading ? "・更新中…" : ""}
              </span>
            )}
          </p>
          <div
            className="flex min-h-[8rem] items-center justify-center rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
            style={currentSettings?.background === "transparent" ? CHECKER_STYLE : { backgroundColor: "#f5f5f5" }}
          >
            {previewResult ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewResult.url} alt="余白・文字入れ結果のプレビュー" className="max-h-72 max-w-full object-contain" />
            ) : (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {previewLoading ? "プレビューを作成しています…" : "設定を変更するとプレビューが表示されます"}
              </p>
            )}
          </div>
        </div>
      
        ) : (
          <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            画像を追加すると、ここにプレビューが表示されます。
          </div>
        )
      }
    >
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={50}
        label="画像をドラッグ&ドロップ（複数可）"
        hint="またはタップして選択"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length > 0 && currentFile && (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setRawIndex(Math.max(0, currentIndex - 1))}
            disabled={currentIndex === 0}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-30 dark:border-neutral-700"
          >
            ← 前へ
          </button>
          <span className="text-sm text-neutral-600 dark:text-neutral-300">
            {currentIndex + 1} / {files.length}
          </span>
          <button
            type="button"
            onClick={() => setRawIndex(Math.min(files.length - 1, currentIndex + 1))}
            disabled={currentIndex === files.length - 1}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-30 dark:border-neutral-700"
          >
            次へ →
          </button>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">共通設定（全画像に適用）</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setUnit("px")}
                className={toggleButtonClass(unit === "px", "xs")}
              >
                px
              </button>
              <button
                type="button"
                onClick={() => setUnit("mm")}
                className={toggleButtonClass(unit === "mm", "xs")}
              >
                mm
              </button>
            </div>
          </div>
          <SettingsFields values={common} onChange={updateCommonField} unit={unit} />
        </div>
      )}

      {files.length > 0 && currentFile && currentState && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {currentIndex + 1}枚目の個別設定
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={currentState.noText}
                  onChange={(e) => setCurrentNoText(e.target.checked)}
                />
                この画像は文字なし
              </label>
              <button
                type="button"
                onClick={() => setUseIndividual(!isIndividual)}
                className={toggleButtonClass(isIndividual, "xs")}
              >
                {isIndividual ? "個別設定を使用中" : "共通設定を使用中"}
              </button>
            </div>
          </div>
          {isIndividual && currentSettings && (
            <SettingsFields values={currentSettings} onChange={updateIndividualField} unit={unit} />
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">出力形式</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setFormat("png")} className={toggleButtonClass(format === "png")}>
              PNG
            </button>
            <button type="button" onClick={() => setFormat("jpeg")} className={toggleButtonClass(format === "jpeg")}>
              JPEG
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleSaveCurrent()}
              disabled={status === "processing"}
              className="w-fit rounded-lg bg-neutral-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              この画像だけ保存
            </button>
            <button
              type="button"
              onClick={() => void handleExportAll()}
              disabled={status === "processing"}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {files.length}件を一括出力
            </button>
          </div>
        </div>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {currentResult && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            現在の画像を保存 ・ {formatBytes(currentResult.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(currentResult.blob, currentResult.name)} />
        </div>
      )}

      {batchResult && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {batchResult.count}件を書き出しました ・ {formatBytes(batchResult.blob.size)}
          </p>
          <RewardedDownloadGate
            label={batchResult.count === 1 ? "ダウンロード" : "ZIPをダウンロード"}
            onDownload={() => downloadBlob(batchResult.blob, batchResult.name)}
          />
        </div>
      )}
    </PreviewSplitLayout>
  );
}
