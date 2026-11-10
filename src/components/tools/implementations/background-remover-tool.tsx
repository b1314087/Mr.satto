"use client";

import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { SliderField } from "@/components/common/slider-field";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { loadImage } from "@/lib/processors/browser/image";
import {
  MAX_REMOVE_PIXELS,
  applyColorKey,
  estimateBackgroundColor,
  hexToRgb,
  rgbToHex,
  type RGB,
} from "@/lib/processors/browser/background-remove";
import { BgRemoveEngine } from "@/lib/processors/browser/background-remove-client";
import { WorkerCanceledError } from "@/lib/workers/worker-channel";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { useObjectUrl } from "@/lib/utils/use-object-url";
import { RunBar } from "@/components/ui/run-bar";

type PreviewBg = "checker" | "white" | "black" | "green";

const PREVIEW_MAX_SIDE = 720;

const CHECKER_STYLE: React.CSSProperties = {
  backgroundColor: "#ffffff",
  backgroundImage:
    "linear-gradient(45deg,#d4d4d8 25%,transparent 25%,transparent 75%,#d4d4d8 75%),linear-gradient(45deg,#d4d4d8 25%,transparent 25%,transparent 75%,#d4d4d8 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

const BG_STYLE: Record<PreviewBg, React.CSSProperties> = {
  checker: CHECKER_STYLE,
  white: { backgroundColor: "#ffffff" },
  black: { backgroundColor: "#000000" },
  green: { backgroundColor: "#22c55e" },
};

interface Prepared {
  file: File;
  base: ImageData;
  autoColor: RGB;
}

/**
 * 背景透過(背景除去)。指定した色(白い背景など)に近い部分を透明にする。
 * 画像は外部へ送信されない。許容する色の差・境界のぼかしのスライダーは、プレビューに即反映される。
 * （AIで背景を判定するモードは、工程2で削除した）
 */
export function BackgroundRemoverTool() {
  const [files, setFiles] = useState<File[]>([]);
  // 複数の画像をまとめて処理する一括処理は、プレミアムプランの機能（無料・旧スタンダードは1枚ずつ）
  const batch = useBatchSelection("background-remover");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [keyHex, setKeyHex] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState(20);
  const [colorSoftness, setColorSoftness] = useState(20);
  const [previewBg, setPreviewBg] = useState<PreviewBg>("checker");

  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; name: string; label: string } | null>(null);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  // 元の解像度での書き出しは、画面とは別の処理（Worker）で行う（ロードマップC 工程3。使えない環境では画面側）
  const engineRef = useRef<BgRemoveEngine | null>(null);
  const engine = () => (engineRef.current ??= new BgRemoveEngine());
  const runCtrlRef = useRef<AbortController | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const [engineUsed, setEngineUsed] = useState<string | null>(null);

  // 画面を離れるときは、処理を止め、Worker を終了させる
  useEffect(() => {
    return () => {
      runCtrlRef.current?.abort();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  const selectedFile = files[Math.min(selectedIndex, files.length - 1)] ?? null;
  const ready = prepared !== null && prepared.file === selectedFile;
  const keyColor: RGB = keyHex ? hexToRgb(keyHex) : ready ? prepared.autoColor : [255, 255, 255];
  const originalUrl = useObjectUrl(selectedFile);

  // 選択画像が変わったら、プレビュー用の縮小データを作る
  useEffect(() => {
    let cancelled = false;
    if (!selectedFile) return;
    const file = selectedFile;
    (async () => {
      try {
        const img = await loadImage(file);
        if (cancelled) return;
        const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        ctx.drawImage(img, 0, 0, w, h);
        const base = ctx.getImageData(0, 0, w, h);
        setPreviewError(null);
        setPrepared({ file, base, autoColor: estimateBackgroundColor(base) });
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : "プレビューを作成できませんでした");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  // スライダー・色が変わるたびにプレビューを描き直す
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!ready || !canvas) return;
    const frame = requestAnimationFrame(() => {
      const { base } = prepared;
      const out = applyColorKey(base, keyColor, tolerance, colorSoftness);
      canvas.width = base.width;
      canvas.height = base.height;
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, base.width, base.height);
      ctx?.putImageData(out, 0, 0);
    });
    return () => cancelAnimationFrame(frame);
    // keyColor は keyHex / prepared から導出される値
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, prepared, tolerance, colorSoftness, keyHex]);

  function addFiles(newFiles: File[]) {
    setFiles(batch.pick(files, newFiles, "append"));
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex((cur) => (cur > index ? cur - 1 : cur));
    setResult(null);
  }

  /** プレビューをクリックして背景色を拾う */
  function pickColor(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!ready) return;
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    // object-contain で描画されるため、実際の画像領域に座標を合わせる
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const drawW = canvas.width * scale;
    const drawH = canvas.height * scale;
    const x = Math.floor(((e.clientX - rect.left - (rect.width - drawW) / 2) / drawW) * canvas.width);
    const y = Math.floor(((e.clientY - rect.top - (rect.height - drawH) / 2) / drawH) * canvas.height);
    const { base } = prepared;
    if (x < 0 || y < 0 || x >= base.width || y >= base.height) return;
    const i = (y * base.width + x) * 4;
    setKeyHex(rgbToHex([base.data[i], base.data[i + 1], base.data[i + 2]]));
  }

  async function handleRun() {
    if (files.length === 0) return;
    if (!(await batch.confirmBatch(files.length))) return;
    const ctrl = new AbortController();
    runCtrlRef.current = ctrl;
    setStatus("processing");
    setError(null);
    setResult(null);
    setCanceling(false);
    setWasCanceled(false);
    try {
      const usedNames = new Map<string, number>();
      const outputs: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgressLabel(files.length > 1 ? `処理中 ${i + 1} / ${files.length}` : "処理中...");
        const img = await loadImage(file);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w * h > MAX_REMOVE_PIXELS) throw new Error(`${file.name}: 画像が大きすぎます(${w}×${h})。縮小してからお試しください`);
        // 画像ごとに四隅の色を推定する(色を手動で選んでいればその色を全画像に使う)
        const blob = await engine().render(img, { key: keyHex ? hexToRgb(keyHex) : null, tolerance, softness: colorSoftness }, ctrl.signal);
        if (ctrl.signal.aborted) throw new WorkerCanceledError();
        const base = `${stripExtension(file.name)}-nobg`;
        const count = usedNames.get(base) ?? 0;
        usedNames.set(base, count + 1);
        outputs.push({ name: count === 0 ? `${base}.png` : `${base}-${count + 1}.png`, blob });
      }
      if (outputs.length === 1) {
        setResult({ blob: outputs[0].blob, name: outputs[0].name, label: "背景を透明にしました(PNG)" });
      } else {
        const zip = await createZip(outputs);
        setResult({
          blob: zip,
          name: `${stripExtension(files[0].name) || "images"}-nobg.zip`,
          label: `${outputs.length}枚の背景を透明にし、ZIPにまとめました`,
        });
      }
      setEngineUsed(engineRef.current?.lastEngine ?? null);
      setStatus("success");
    } catch (e) {
      if (e instanceof WorkerCanceledError || ctrl.signal.aborted) {
        // 止めたときは、途中までの結果を出さない
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      setProgressLabel("");
      setCanceling(false);
      if (runCtrlRef.current === ctrl) runCtrlRef.current = null;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="image/*"
        multiple
        maxSizeMB={30}
        label={batch.batchAllowed ? "画像をドラッグ&ドロップ（複数可）" : "画像をドラッグ&ドロップ"}
        hint="またはタップして選択（JPG・PNG・WebP）。画像は外部に送信されず、お使いの端末の中だけで処理されます"
        onFilesSelected={addFiles}
        onError={setError}
      />
      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} unit="枚" />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />
      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}

      {files.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <button
              key={`${f.name}-${i}`}
              type="button"
              onClick={() => setSelectedIndex(i)}
              aria-pressed={i === Math.min(selectedIndex, files.length - 1)}
              className={`max-w-[12rem] truncate rounded-lg border px-3 py-1.5 text-xs ${
                i === Math.min(selectedIndex, files.length - 1)
                  ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                  : "border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
              }`}
            >
              {i + 1}. {f.name}
            </button>
          ))}
        </div>
      )}

      {selectedFile && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-neutral-500 dark:text-neutral-400">背景:</span>
<div className="ms-seg" role="group" aria-label="プレビューの背景">
              {(
                [
                  ["checker", "市松"],
                  ["white", "白"],
                  ["black", "黒"],
                  ["green", "緑"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={previewBg === v}
                  onClick={() => setPreviewBg(v)}
                >
                  {label}
                </button>
              ))}
            </div>
</div>
          </div>
          {previewError && <ErrorMessage message={previewError} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">元の画像</figcaption>
              {originalUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={originalUrl} alt="元の画像" className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900" />
              )}
            </figure>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                背景を透明にした結果(背景をクリックして色を選べます)
              </figcaption>
              <canvas
                ref={previewCanvasRef}
                data-testid="bg-preview"
                aria-label="背景除去後のプレビュー"
                onClick={pickColor}
                style={BG_STYLE[previewBg]}
                className="max-h-72 w-full cursor-crosshair rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
              />
            </figure>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            指定した色に近い部分を透明にします（白背景・単色背景向け）。消す色は、四隅の色から自動で選ばれます。プレビューの背景をクリックして選ぶこともできます。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">消す色</span>
            <input
              type="color"
              aria-label="消す色"
              value={rgbToHex(keyColor)}
              onChange={(e) => setKeyHex(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-neutral-300 dark:border-neutral-700"
            />
            <span className="font-mono text-sm text-neutral-600 dark:text-neutral-300">{rgbToHex(keyColor)}</span>
            <button
              type="button"
              onClick={() => setKeyHex(null)}
              className="rounded-md px-2.5 py-1 text-xs text-neutral-600 ring-1 ring-neutral-300 hover:bg-neutral-100 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-800"
            >
              四隅の色から自動で選ぶ
            </button>
          </div>
          <SliderField label="許容する色の差" value={tolerance} min={0} max={100} unit="%" onChange={setTolerance} hint="大きいほど、指定色に近い色までまとめて消えます" />
          <SliderField label="境界のぼかし" value={colorSoftness} min={0} max={100} unit="%" onChange={setColorSoftness} />
        </div>
      )}

      {files.length > 0 && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {files.length > 1 ? `${files.length}枚の背景を透明にする` : "背景を透明にする"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={progressLabel || "処理中..."}
        successLabel="背景を透明にしました"
        onCancel={() => {
          setCanceling(true);
          runCtrlRef.current?.abort();
        }}
        canceling={canceling}
      />
      {wasCanceled && (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300" data-testid="bg-canceled">
          処理をキャンセルしました。
        </p>
      )}
      {engineUsed && <span hidden data-testid="bg-engine" data-engine={engineUsed} />}
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.label} ・ {formatBytes(result.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, result.name)} />
        </ResultPopup>
      )}
    </div>
  );
}
