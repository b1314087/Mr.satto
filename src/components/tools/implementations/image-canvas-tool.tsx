"use client";

import { useEffect, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  ImageResizeProcessor,
  ImageCompressProcessor,
  ImageCompressToSizeProcessor,
} from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { dedupeFileNames, downloadBlob, formatBytes, replaceExtension, stripExtension } from "@/lib/utils/format";
import { useObjectUrl } from "@/lib/utils/use-object-url";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchResultList, type BatchResultRow } from "@/components/common/batch-result-list";
import { runBatchSequentially, type BatchItem } from "@/lib/batch/run-batch";
import { RunBar } from "@/components/ui/run-bar";

/**
 * 画像リサイズ・圧縮（工程3で、画像リサイズ（旧 image-resize）と画像圧縮（image-compress）を1つにまとめた）。
 * 「サイズを変更」と「容量を圧縮」を、それぞれ独立して選べる（どちらか一方だけ・両方）。
 * - サイズだけ：従来の画像リサイズと同じ処理（ImageResizeProcessor。形式は元のまま）
 * - 圧縮だけ：従来の画像圧縮と同じ処理（画質指定 ImageCompressProcessor／目標サイズ指定 ImageCompressToSizeProcessor）
 * - 両方：指定した大きさで描いた1枚の画像を、そのまま圧縮する（いったん書き出して読み直すことはしない。メモリを2重に使わない）
 * 旧「画像リサイズ」のアドレスからの転送（?mode=resize）では「サイズを変更」だけを選んだ状態で、
 * 旧「指定KBまで圧縮」からの転送（?mode=size）では「目標サイズ(KB)を指定して圧縮」を選んだ状態で開く。
 */

/** 画像圧縮の2つのやり方 */
type CompressKind = "quality" | "size";

/** どの処理を行うか（リサイズ・圧縮のそれぞれを使うか、圧縮のやり方） */
interface ImageRunPlan {
  resize: boolean;
  compress: boolean;
  compressKind: CompressKind;
}

/** 実行ボタンの文言（処理の組み合わせに合わせる） */
function actionLabelOf(plan: ImageRunPlan): string {
  if (plan.resize && plan.compress) return "リサイズして圧縮する";
  return plan.resize ? "リサイズする" : "圧縮する";
}

/** 目標サイズに届かなかったときの案内（届いたときは null） */
function missedTargetMessage(output: ImageProcessorOutput, targetKB: number): string | null {
  if (output.sizeBytes <= targetKB * 1024) return null;
  return `目標の${targetKB}KBまで小さくできませんでした（現在 ${formatBytes(output.sizeBytes)}）。「サイズを変更」で縦横のサイズも小さくしてから、もう一度お試しください。`;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * 書き出した大きさについての案内（元の画像のままにしたとき・元より大きくなったとき）。それ以外は null
 */
function sizeNoteFor(output: ImageProcessorOutput, original: File): string | null {
  if (output.keptOriginal) {
    return "元の画像より小さくできなかったため、元の画像のままにしました。もともと小さく保存されている画像（PNGのイラストなど）は、これ以上小さくなりません。";
  }
  if (original.size > 0 && output.sizeBytes > original.size) {
    return original.type === "image/png"
      ? "元の画像より大きくなりました。PNGの画像は、画質の設定では小さくなりません。「画像形式変換」でJPEG・WebPに変えると小さくなる場合があります。"
      : "元の画像より大きくなりました。画質を下げるか、縦横のサイズを小さくしてお試しください。";
  }
  return null;
}

interface ImageRunSettings {
  width: number;
  height: number;
  quality: number;
  targetKB: number;
}

/**
 * 実行ボタンとライブプレビューで共通に使う処理。
 * プレビューも実際のProcessorで同じ設定を処理するため、プレビューどおりの結果が書き出される。
 */
async function runImageProcessor(plan: ImageRunPlan, file: File, s: ImageRunSettings): Promise<ImageProcessorOutput> {
  if (!plan.compress) return new ImageResizeProcessor().process({ file, width: s.width, height: s.height });
  const size = plan.resize ? { width: s.width, height: s.height } : {};
  return plan.compressKind === "size"
    ? new ImageCompressToSizeProcessor().process({ file, targetKB: s.targetKB, ...size })
    : new ImageCompressProcessor().process({ file, quality: s.quality / 100, ...size });
}

/** 画像の縦横のピクセル数を調べる（一括リサイズで、画像ごとに縦横比を保つために使う） */
async function readImageSize(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("画像を読み込めませんでした。対応している画像ファイルか確認してください。");
  });
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** 一括処理で、1枚ごとに保存しておく結果（プレビュー用のURLは持たない） */
interface BatchImageResult {
  blob: Blob;
  outputName: string;
  detail?: string;
}

/** プレビューで処理する最大ピクセル数(これを超えるリサイズ指定はプレビューを省略する) */
const PREVIEW_MAX_PIXELS = 40_000_000;
/** 設定変更後、プレビューを再計算するまでの待ち時間(ms) */
const PREVIEW_DEBOUNCE_MS = 250;

export function ImageCanvasTool() {
  const [compressKind, setCompressKind] = useState<CompressKind>("quality");
  // 新工程1：初期状態は「サイズを変更」だけを選んだ状態（圧縮は必要なときに利用者がオンにする）
  const [useResize, setUseResize] = useState(true);
  const [useCompress, setUseCompress] = useState(false);
  const plan: ImageRunPlan = { resize: useResize, compress: useCompress, compressKind };
  const hasAction = useResize || useCompress;
  const actionLabel = actionLabelOf(plan);
  // 選んだ画像。2枚以上のとき（プレミアムプランの一括処理）は、設定を全部の画像にまとめて適用する。
  // プレビュー・縦横の初期値は1枚目の画像で表示する。
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("image-compress");
  const [batchItems, setBatchItems] = useState<BatchItem<BatchImageResult>[]>([]);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);
  const [lockAspect, setLockAspect] = useState(true);
  const [quality, setQuality] = useState(80);
  const [targetKB, setTargetKB] = useState(300);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);
  // 書き出した時点の目標サイズ（あとで入力欄を変えても、結果の案内がぶれないように）
  const [resultTargetKB, setResultTargetKB] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ key: string; file: File; output: ImageProcessorOutput } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);

  const originalUrl = useObjectUrl(file);

  // 旧アドレスから転送されてきたとき：画像リサイズ（?mode=resize）はサイズの変更だけ、
  // 指定KBまで圧縮（?mode=size）は目標サイズの指定を、最初から選んでおく
  useEffect(() => {
    const mode = new URLSearchParams(window.location.search).get("mode");
    if (mode === "resize") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUseResize(true);
      setUseCompress(false);
    } else if (mode === "size") {
      // 旧「指定KBまで圧縮」からの転送：圧縮（目標サイズの指定）だけを選んだ状態で開く（これまでと同じ）
      setUseResize(false);
      setUseCompress(true);
      setCompressKind("size");
    }
  }, []);

  // 設定が処理可能な値かどうか(リサイズの幅・高さ、目標KB)
  const resizeValid = !useResize || (Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1);
  const targetValid = !(useCompress && compressKind === "size") || (Number.isFinite(targetKB) && targetKB >= 1);
  const settingsValid = hasAction && resizeValid && targetValid;
  const tooLarge = useResize && settingsValid && Math.round(width) * Math.round(height) > PREVIEW_MAX_PIXELS;
  // プレビューが「どのファイル・どの設定」の結果かを識別するキー
  const previewKey = !file
    ? ""
    : [
        useResize ? `resize:${Math.round(width)}x${Math.round(height)}` : "",
        useCompress ? (compressKind === "size" ? `size:${targetKB}` : `quality:${quality}`) : "",
        file.name,
        file.size,
        file.lastModified,
      ].join("|");

  // 設定を変えるたびに、実際のProcessorで処理した結果をプレビューとして更新する
  useEffect(() => {
    if (!file || !settingsValid || tooLarge) return;
    let cancelled = false;
    const runPlan: ImageRunPlan = { resize: useResize, compress: useCompress, compressKind };
    const timer = setTimeout(async () => {
      try {
        const output = await runImageProcessor(runPlan, file, { width, height, quality, targetKB });
        if (cancelled) {
          URL.revokeObjectURL(output.url);
          return;
        }
        setPreviewError(null);
        setPreview({ key: previewKey, file, output });
      } catch (e) {
        if (!cancelled) {
          setPreviewError({ key: previewKey, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
        }
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [file, useResize, useCompress, compressKind, settingsValid, tooLarge, width, height, quality, targetKB, previewKey]);

  // プレビュー用Object URLは、差し替わる時・アンマウント時に解放する
  const previewOutput = preview?.output ?? null;
  const shownPreview = preview && preview.file === file ? preview : null;
  const previewStale = shownPreview !== null && shownPreview.key !== previewKey;
  const shownError = previewError && previewError.key === previewKey ? previewError.message : null;
  useEffect(() => {
    return () => {
      if (previewOutput) URL.revokeObjectURL(previewOutput.url);
    };
  }, [previewOutput]);

  useEffect(() => {
    if (!file) {
      // ファイル選択が解除された際に関連state をリセットする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNaturalSize(null);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      setWidth(img.naturalWidth);
      setHeight(img.naturalHeight);
    };
    img.src = url;
    setResult(null);
    setError(null);
    setStatus("idle");
    // Phase 7: revokeをonloadの中だけで行うと、画像のdecodeに失敗した場合
    // （onerror）や、ファイルが素早く変更されてこのeffectが再実行された場合に
    // Object URLが解放されないまま残ってしまう。cleanup関数側で必ず解放する
    // ようにし、どちらのケースでも確実に解放されるようにする。
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    // 処理結果のプレビュー用Object URLは、次の結果に差し替わる時・
    // アンマウント時に解放する（解放しないとメモリリークになる）
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function handleWidthChange(next: number) {
    setWidth(next);
    if (lockAspect && naturalSize) {
      setHeight(Math.round((next * naturalSize.height) / naturalSize.width));
    }
  }

  function handleHeightChange(next: number) {
    setHeight(next);
    if (lockAspect && naturalSize) {
      setWidth(Math.round((next * naturalSize.width) / naturalSize.height));
    }
  }

  /** 一括処理：同じ設定を、選んだ全部の画像に1枚ずつ順番に適用する */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    const runPlan = plan;
    const settings = { width, height, quality, targetKB };
    const keepAspect = lockAspect;
    setStatus("processing");
    setError(null);
    setResult(null);
    const items = await runBatchSequentially<BatchImageResult>(
      files,
      async (target) => {
        let size = { width: settings.width, height: settings.height };
        if (runPlan.resize && keepAspect) {
          // 縦横比を固定しているときは、指定した幅に合わせて、画像ごとに高さを決める
          const natural = await readImageSize(target);
          size = {
            width: Math.round(settings.width),
            height: Math.max(1, Math.round((settings.width * natural.height) / natural.width)),
          };
        }
        const output = await runImageProcessor(runPlan, target, { ...settings, ...size });
        // 一覧ではプレビュー画像を出さないため、URLはすぐに解放する（メモリを使い続けない）
        URL.revokeObjectURL(output.url);
        const missed = runPlan.compress && runPlan.compressKind === "size" ? missedTargetMessage(output, settings.targetKB) : null;
        return {
          blob: output.blob,
          outputName: replaceExtension(target.name, EXT_BY_MIME[output.mimeType] ?? "png"),
          detail: missed
            ? `目標の${settings.targetKB}KBに届きませんでした`
            : `${output.width}×${output.height}px${target.size > 0 ? `・元の${Math.round((output.sizeBytes / target.size) * 100)}%` : ""}`,
        };
      },
      setBatchItems
    );
    setStatus(items.some((item) => item.status === "done") ? "success" : "error");
    if (items.every((item) => item.status === "error")) setError("すべての画像で処理に失敗しました");
  }

  async function handleRun() {
    if (!file) return;
    if (isBatch) {
      await handleRunBatch();
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await runImageProcessor(plan, file, { width, height, quality, targetKB });
      setResult(output);
      setResultTargetKB(useCompress && compressKind === "size" ? targetKB : null);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? replaceExtension(
        file.name,
        result ? EXT_BY_MIME[result.mimeType] ?? "png" : "png"
      )
    : "output.png";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={file ? (
        <div data-testid="tool-preview" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー</p>
          {shownError && <ErrorMessage message={shownError} />}
          {tooLarge && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              指定サイズが大きすぎるため、プレビューは表示できません（書き出しは実行できます）。
            </p>
          )}
          {useCompress && compressKind === "size" && shownPreview && !previewStale && missedTargetMessage(shownPreview.output, targetKB) && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="compress-target-missed">
              {missedTargetMessage(shownPreview.output, targetKB)}
            </p>
          )}
          {shownPreview && !previewStale && sizeNoteFor(shownPreview.output, file) && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="image-size-note">
              {sizeNoteFor(shownPreview.output, file)}
            </p>
          )}
          {isBatch && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              1枚目の画像のプレビューです。ほかの{files.length - 1}枚にも同じ設定で処理します。
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="flex min-w-0 flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                元の画像{naturalSize ? ` ・ ${naturalSize.width} × ${naturalSize.height}px` : ""} ・ {formatBytes(file.size)}
              </figcaption>
              {originalUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={originalUrl}
                  alt="元の画像"
                  className="max-h-[min(55vh,28rem)] w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                />
              )}
            </figure>
            <figure className="flex min-w-0 flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                {shownPreview
                  ? `処理後 ・ ${shownPreview.output.width} × ${shownPreview.output.height}px ・ ${formatBytes(shownPreview.output.sizeBytes)}${
                      file.size > 0 ? `（元の${Math.round((shownPreview.output.sizeBytes / file.size) * 100)}%）` : ""
                    }`
                  : "処理後"}
                {previewStale ? " ・ 更新中..." : ""}
              </figcaption>
              {shownPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shownPreview.output.url}
                  alt="処理後のプレビュー"
                  className={`max-h-[min(55vh,28rem)] w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain transition-opacity dark:border-neutral-700 dark:bg-neutral-900 ${
                    previewStale ? "opacity-50" : ""
                  }`}
                />
              ) : (
                <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  {tooLarge || shownError || !hasAction ? "プレビューなし" : "プレビューを作成中..."}
                </div>
              )}
            </figure>
          </div>
        </div>
      ) : null}
    >
      <div className="flex flex-col gap-2" data-testid="image-ops">
        {/* やること（サイズ変更・圧縮）。両方を選べるので、オン・オフの切り替えボタン（チェックボックスと同じ扱い） */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p id="image-ops-label" className="text-sm font-medium text-ms-text">
            やること<span className="ml-1 text-xs font-normal text-ms-muted">（両方も選べます）</span>
          </p>
          <div className="ms-seg" role="group" aria-labelledby="image-ops-label">
            {(
              [
                { id: "resize", label: "サイズを変更", checked: useResize, set: setUseResize, testId: "image-op-resize" },
                { id: "compress", label: "容量を圧縮", checked: useCompress, set: setUseCompress, testId: "image-op-compress" },
              ] as const
            ).map((op) => (
              <button
                key={op.id}
                type="button"
                role="checkbox"
                aria-checked={op.checked}
                data-testid={op.testId}
                onClick={() => {
                  op.set(!op.checked);
                  setResult(null);
                  setBatchItems([]);
                  setStatus("idle");
                  setError(null);
                }}
              >
                <span aria-hidden="true">{op.checked ? "✓" : "＋"}</span>
                {op.label}
              </button>
            ))}
          </div>
        </div>
        {!hasAction && (
          <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="image-op-none">
            「サイズを変更」「容量を圧縮」の、少なくとも一方を選んでください。
          </p>
        )}
        {useResize && useCompress && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">指定したサイズに変更してから圧縮します。</p>
        )}
      </div>

      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="image/*"
        multiple
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={(selected) => {
          setFiles(batch.pick(files, selected, "replace"));
          setBatchItems([]);
        }}
        onError={setError}
      />
      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} unit="枚" />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

      {files.length > 0 && (
        <FileList
          files={files}
          onRemove={(index) => {
            setFiles((prev) => prev.filter((_, i) => i !== index));
            setBatchItems([]);
          }}
        />
      )}

      {file && useResize && (
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex flex-col gap-1 text-sm">
            幅 (px)
            <input
              type="number"
              min={1}
              value={width}
              onChange={(e) => handleWidthChange(Number(e.target.value))}
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            高さ (px)
            <input
              type="number"
              min={1}
              value={height}
              onChange={(e) => handleHeightChange(Number(e.target.value))}
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={lockAspect}
              onChange={(e) => setLockAspect(e.target.checked)}
            />
            縦横比を固定
          </label>
          {isBatch && (
            <p className="basis-full text-xs text-neutral-500 dark:text-neutral-400" data-testid="batch-resize-note">
              {lockAspect
                ? "縦横比を固定しているため、指定した幅に合わせて、画像ごとに高さを自動で決めます（初期値は1枚目の画像の大きさです）。"
                : "すべての画像を、指定した幅・高さにそろえます。"}
            </p>
          )}
        </div>
      )}

      {useCompress && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p id="compress-kind-label" className="text-sm font-medium text-ms-text">
            圧縮のしかた
          </p>
          <div role="radiogroup" aria-labelledby="compress-kind-label" className="ms-seg" data-testid="compress-kind">
            {(
              [
                { id: "quality", label: "画質で指定", hint: "スライダーで画質を決めます" },
                { id: "size", label: "目標サイズ(KB)で指定", hint: "指定したサイズ以下になるよう自動で調整します" },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={compressKind === o.id}
                title={o.hint}
                data-testid={`compress-kind-${o.id}`}
                onClick={() => {
                  setCompressKind(o.id);
                  // やり方を変えたら、前のやり方の結果は消す
                  setResult(null);
                  setBatchItems([]);
                  setStatus("idle");
                  setError(null);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {file && useCompress && compressKind === "quality" && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex items-center justify-between text-sm">
            <span>画質: {quality}%</span>
          </label>
          <input
            type="range"
            min={10}
            max={100}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
        </div>
      )}

      {file && useCompress && compressKind === "size" && (
        <label className="flex flex-col gap-1 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          目標サイズ (KB)
          <input
            type="number"
            min={1}
            value={targetKB}
            onChange={(e) => setTargetKB(Number(e.target.value))}
            className="w-32 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      )}



      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || !settingsValid} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${files.length}枚をまとめて${actionLabel}` : actionLabel}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={
          isBatch
            ? `処理しています…（${Math.min(batchItems.filter((i) => i.status === "done" || i.status === "error").length + 1, files.length)} / ${files.length}）`
            : undefined
        }
        successLabel="変換が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {batchItems.length > 0 && (
        <BatchResultList
          rows={toBatchRows(batchItems)}
          zipName={`${stripExtension(batchItems[0].file.name) || "images"}-${useResize && !useCompress ? "resized" : "compressed"}.zip`}
        />
      )}

      {result && !isBatch && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          {file && sizeNoteFor(result, file) && (
            <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="image-size-note-result">
              {sizeNoteFor(result, file)}
            </p>
          )}
          {resultTargetKB !== null && missedTargetMessage(result, resultTargetKB) && (
            <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="compress-result-missed">
              {missedTargetMessage(result, resultTargetKB)}
            </p>
          )}
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}

/** 一括処理の状態を、結果一覧の行に変換する（書き出すファイル名が重ならないよう番号を付ける） */
function toBatchRows(items: BatchItem<BatchImageResult>[]): BatchResultRow[] {
  const names = dedupeFileNames(items.map((item) => item.result?.outputName ?? item.file.name));
  return items.map((item, i) => ({
    sourceName: item.file.name,
    status: item.status,
    outputName: item.result ? names[i] : undefined,
    blob: item.result?.blob,
    detail: item.result?.detail,
    error: item.error,
  }));
}
