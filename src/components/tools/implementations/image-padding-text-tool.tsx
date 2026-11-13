"use client";

import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { SliderField } from "@/components/common/slider-field";
import { TextColorField } from "@/components/common/text-color-field";
import { PositionSliders } from "@/components/common/position-sliders";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  ImagePaddingTextProcessor,
  paddingTextPresetPercent,
  type PaddingTextBandAlign,
  type PaddingTextEdge,
  type PaddingTextEdgeAlign,
  type PaddingTextHAlign,
} from "@/lib/processors/browser/image-padding-text";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { mmToPt, ptToMm } from "@/lib/print/paper-sizes";
import { createZip, type ZipEntry } from "@/lib/utils/zip";
import { downloadBlob, dedupeFileNames, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";

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
  /** X・Yの調整バーで決めた位置（余白の帯の中の割合 0〜100）。null のあいだは、上のボタンで選んだ位置 */
  posX: number | null;
  posY: number | null;
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
  posX: null,
  posY: null,
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
  // ボタンで選んだ位置を、X・Yのバーの値（余白の帯の中の割合）にしたもの
  const presetPos = paddingTextPresetPercent(values.edge, values.edgeAlign, values.bandAlign);
  const [uniformValue, setUniformValue] = useState(0);

  // 2026-11：余白はバー（スライダー）と数値入力の両方で調整できるようにした。バーは0〜1000px（mmは換算）、数値入力は最大4000pxまで
  const barMax = unit === "px" ? 1000 : Math.round(ptToMm(1000));
  const inputMax = unit === "px" ? MAX_PADDING_PX : Math.round(ptToMm(MAX_PADDING_PX));
  function paddingField(key: "paddingTop" | "paddingBottom" | "paddingLeft" | "paddingRight", label: string) {
    return (
      <SliderField
        label={label}
        ariaLabel={`${label}`}
        value={pxToDisplay(values[key], unit)}
        min={0}
        max={barMax}
        inputMax={inputMax}
        step={1}
        unit={unitLabel}
        onChange={(v) => onChange(key, displayToPx(v, unit))}
      />
    );
  }

  const edgeLabel = EDGE_OPTIONS.find((o) => o.id === values.edge)?.label ?? "";
  // 総合改修 22：設定が多く読みにくかったので、内容ごとの折りたたみ（余白・背景・文字・文字色・文字の位置）に分けた
  return (
    <SettingsStack>
      <SettingsSection
        n={1}
        title="余白"
        summary={`上${pxToDisplay(values.paddingTop, unit)}・下${pxToDisplay(values.paddingBottom, unit)}・左${pxToDisplay(values.paddingLeft, unit)}・右${pxToDisplay(values.paddingRight, unit)}${unitLabel}`}
      >
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="padding-sliders">
          {paddingField("paddingTop", "上")}
          {paddingField("paddingBottom", "下")}
          {paddingField("paddingLeft", "左")}
          {paddingField("paddingRight", "右")}
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <div className="min-w-48 flex-1">
            <SliderField label="4辺まとめて" value={uniformValue} min={0} max={barMax} inputMax={inputMax} step={1} unit={unitLabel} onChange={setUniformValue} />
          </div>
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
      </SettingsSection>

      <SettingsSection n={2} title="背景" summary={values.background === "transparent" ? "透明" : values.background}>
      <div className="flex flex-col gap-2">
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
      </SettingsSection>

      <SettingsSection n={3} title="文字" summary={values.text.trim() ? values.text.split("\n")[0] : "（未入力）"}>
      <div className="flex flex-col gap-2">
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
      </div>
      </SettingsSection>

      <SettingsSection n={4} title="文字色" summary={values.color}>
        <TextColorField value={values.color} onChange={(c) => onChange("color", c)} testId="padding-text-color" />
      </SettingsSection>

      <SettingsSection
        n={5}
        title="文字の位置"
        summary={values.posX !== null || values.posY !== null ? `${edgeLabel}の余白・X ${values.posX ?? presetPos.x}%・Y ${values.posY ?? presetPos.y}%` : `${edgeLabel}の余白`}
      >
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">配置する余白</p>
          <div className="flex flex-wrap gap-2">
            {EDGE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onChange("edge", opt.id);
                  onChange("posX", null);
                  onChange("posY", null);
                }}
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
                onClick={() => {
                  onChange("edgeAlign", opt.id);
                  onChange("posX", null);
                  onChange("posY", null);
                }}
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
                onClick={() => {
                  onChange("bandAlign", opt.id);
                  onChange("posX", null);
                  onChange("posY", null);
                }}
                className={toggleButtonClass(values.bandAlign === opt.id, "xs")}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <PositionSliders
          testId="padding-text-xy"
          x={values.posX ?? presetPos.x}
          y={values.posY ?? presetPos.y}
          onChange={(p) => {
            onChange("posX", p.x);
            onChange("posY", p.y);
          }}
        />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          バーで、選んだ余白の中の文字の位置を細かく動かせます（0%＝余白の左端・上端、100%＝右端・下端）。上の位置のボタンを押すと、その位置に戻ります。
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          選択した余白の幅・高さが0pxの場合、その余白には文字が表示されません。
        </p>
      </div>
      </SettingsSection>
    </SettingsStack>
  );
}

export function ImagePaddingTextTool() {
  const [files, setFiles] = useState<File[]>([]);
  // 複数の画像をまとめて処理する一括処理は、プレミアムプランの機能（無料・旧スタンダードは1枚ずつ）
  const batch = useBatchSelection("image-padding-text");
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
    setFiles(batch.pick(files, newFiles, "append"));
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

  // ライブプレビュー：現在表示中の1枚だけを対象に、設定変更後200msデバウンスして（位置のバーを動かしたときに、すぐ反映されるように）
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
    }, 200);
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
    currentSettings?.posX,
    currentSettings?.posY,
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
    if (!(await batch.confirmBatch(files.length))) return;
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
      mobileSticky
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
              <img src={previewResult.url} alt="余白・文字入れ結果のプレビュー" className="max-h-[min(30vh,28rem)] max-w-full object-contain lg:max-h-[min(55vh,28rem)]" />
            ) : (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {previewLoading ? "プレビューを作成しています…" : "設定を変更するとプレビューが表示されます"}
              </p>
            )}
          </div>
        </div>
      
        ) : (
          <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">画像を追加してください。</div>
        )
      }
    >
      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="image/*"
        multiple
        maxSizeMB={50}
        label={batch.batchAllowed ? "画像をドラッグ&ドロップ（複数可）" : "画像をドラッグ&ドロップ"}
        hint="またはタップして選択"
        onFilesSelected={addFiles}
        onError={setError}
      />
      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} unit="枚" />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

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
          <RunBar>
            <button
              type="button"
              onClick={() => void handleSaveCurrent()}
              disabled={status === "processing"} aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-neutral-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              この画像だけ保存
            </button>
            <button
              type="button"
              onClick={() => void handleExportAll()}
              disabled={status === "processing"} aria-busy={status === "processing" || undefined}
              className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {files.length}件を一括出力
            </button>
          </RunBar>
        </div>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {currentResult && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            現在の画像を保存 ・ {formatBytes(currentResult.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(currentResult.blob, currentResult.name)} />
        </ResultPopup>
      )}

      {batchResult && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {batchResult.count}件を書き出しました ・ {formatBytes(batchResult.blob.size)}
          </p>
          <RewardedDownloadGate
            label={batchResult.count === 1 ? "ダウンロード" : "ZIPをダウンロード"}
            onDownload={() => downloadBlob(batchResult.blob, batchResult.name)}
          />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
