"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { SliderField } from "@/components/common/slider-field";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { canvasToBlob, loadImage } from "@/lib/processors/browser/image";
import {
  MAX_REMOVE_PIXELS,
  applyColorKey,
  applyMaskToImage,
  estimateBackgroundColor,
  hexToRgb,
  predictMask,
  rgbToHex,
  upscaleMask,
  type RGB,
} from "@/lib/processors/browser/background-remove";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

type Mode = "ai" | "color";
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
  /** AIマスク(プレビューサイズ)。AIの推論が終わるまでnull */
  mask: Uint8ClampedArray | null;
  autoColor: RGB;
}

/**
 * 背景透過(背景除去)。無料のまま使えるよう、AI(軽量U²-Net)もブラウザ内で動かす。
 * 画像は外部へ送信されない。初回だけモデル(約19MB)を読み込むため少し時間がかかる。
 * しきい値・境界のぼかしのスライダーは、再計算なしでプレビューに即反映される。
 */
export function BackgroundRemoverTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("ai");
  const [threshold, setThreshold] = useState(50);
  const [softness, setSoftness] = useState(20);
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
  // 解析済みのAIマスク(元の画像サイズではなく320×320)をファイルごとに覚えて、再推論を避ける
  const maskCache = useRef(new WeakMap<File, Uint8ClampedArray>());

  const selectedFile = files[Math.min(selectedIndex, files.length - 1)] ?? null;
  const ready = prepared !== null && prepared.file === selectedFile;
  const analyzing = mode === "ai" && ready && prepared.mask === null && previewError === null;
  const keyColor: RGB = keyHex ? hexToRgb(keyHex) : ready ? prepared.autoColor : [255, 255, 255];
  const originalUrl = useMemo(() => (selectedFile ? URL.createObjectURL(selectedFile) : null), [selectedFile]);
  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);

  // 選択画像が変わったら、プレビュー用の縮小データを作る(AIの解析は下のeffectが担当)
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
        const small = maskCache.current.get(file) ?? null;
        setPreviewError(null);
        setPrepared({ file, base, mask: small ? upscaleMask(small, w, h) : null, autoColor: estimateBackgroundColor(base) });
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : "プレビューを作成できませんでした");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFile]);

  // AIモードへ切り替えたとき、まだ解析していなければ解析する
  useEffect(() => {
    if (mode !== "ai" || !ready || prepared.mask) return;
    let cancelled = false;
    const { file, base, autoColor } = prepared;
    (async () => {
      try {
        const img = await loadImage(file);
        const small = await predictMask(img);
        if (cancelled) return;
        maskCache.current.set(file, small);
        setPrepared({ file, base, mask: upscaleMask(small, base.width, base.height), autoColor });
      } catch (e) {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : "背景の解析に失敗しました");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, ready, prepared]);

  // スライダー・色が変わるたびにプレビューを描き直す
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!ready || !canvas) return;
    const frame = requestAnimationFrame(() => {
      const { base, mask } = prepared;
      let out: ImageData | null = null;
      if (mode === "ai") {
        if (mask) out = applyMaskToImage(base, mask, threshold / 100, softness / 100);
      } else {
        out = applyColorKey(base, keyColor, tolerance, colorSoftness);
      }
      canvas.width = base.width;
      canvas.height = base.height;
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, base.width, base.height);
      if (out) ctx?.putImageData(out, 0, 0);
      else ctx?.putImageData(base, 0, 0);
    });
    return () => cancelAnimationFrame(frame);
    // keyColor は keyHex / prepared から導出される値
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, prepared, mode, threshold, softness, tolerance, colorSoftness, keyHex]);

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setSelectedIndex((cur) => (cur > index ? cur - 1 : cur));
    setResult(null);
  }

  /** プレビューをクリックして背景色を拾う(色指定モード) */
  function pickColor(e: React.MouseEvent<HTMLCanvasElement>) {
    if (mode !== "color" || !ready) return;
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
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const usedNames = new Map<string, number>();
      const outputs: { name: string; blob: Blob }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgressLabel(files.length > 1 ? `処理中 ${i + 1} / ${files.length}${mode === "ai" ? "(AIで解析中)" : ""}` : mode === "ai" ? "AIで解析中..." : "処理中...");
        const img = await loadImage(file);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w * h > MAX_REMOVE_PIXELS) throw new Error(`${file.name}: 画像が大きすぎます(${w}×${h})。縮小してからお試しください`);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        ctx.drawImage(img, 0, 0);
        const full = ctx.getImageData(0, 0, w, h);
        let out: ImageData;
        if (mode === "ai") {
          let small = maskCache.current.get(file);
          if (!small) {
            small = await predictMask(img);
            maskCache.current.set(file, small);
          }
          out = applyMaskToImage(full, upscaleMask(small, w, h), threshold / 100, softness / 100);
        } else {
          // 色指定は、画像ごとに四隅の色を推定する(色を手動で選んでいればその色を全画像に使う)
          const key = keyHex ? hexToRgb(keyHex) : estimateBackgroundColor(full);
          out = applyColorKey(full, key, tolerance, colorSoftness);
        }
        ctx.putImageData(out, 0, 0);
        const blob = await canvasToBlob(canvas, "image/png");
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
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    } finally {
      setProgressLabel("");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        multiple
        maxSizeMB={30}
        label="画像をドラッグ&ドロップ（複数可）"
        hint="またはタップして選択（JPG・PNG・WebP）。画像は外部に送信されず、お使いの端末の中だけで処理されます"
        onFilesSelected={addFiles}
        onError={setError}
      />
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

      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">方法</p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { v: "ai", label: "AIで自動(人物・物・動物など)" },
                { v: "color", label: "色を指定して消す(白背景・単色背景向け)" },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                aria-pressed={mode === o.v}
                onClick={() => setMode(o.v)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  mode === o.v ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedFile && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー</p>
            <div className="flex items-center gap-1 text-xs" role="group" aria-label="プレビューの背景">
              <span className="text-neutral-500 dark:text-neutral-400">背景:</span>
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
                  className={`rounded-md px-2 py-0.5 ${previewBg === v ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {previewError && <ErrorMessage message={previewError} />}
          {analyzing && (
            <p role="status" className="text-sm text-blue-700 dark:text-blue-300">
              AIで背景を解析しています…(初回はモデルの読み込みに数秒〜十数秒かかります)
            </p>
          )}
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
                背景を透明にした結果{mode === "color" ? "(背景をクリックして色を選べます)" : ""}
              </figcaption>
              <canvas
                ref={previewCanvasRef}
                data-testid="bg-preview"
                aria-label="背景除去後のプレビュー"
                onClick={pickColor}
                style={BG_STYLE[previewBg]}
                className={`max-h-72 w-full rounded-lg border border-neutral-200 object-contain dark:border-neutral-700 ${mode === "color" ? "cursor-crosshair" : ""}`}
              />
            </figure>
          </div>
        </div>
      )}

      {files.length > 0 && mode === "ai" && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <SliderField label="切り抜きの強さ" value={threshold} min={5} max={95} unit="%" onChange={setThreshold} onReset={threshold !== 50 ? () => setThreshold(50) : undefined} hint="大きいほど背景として消える範囲が広がります。残したい部分まで消えるときは下げます" />
          <SliderField label="境界のぼかし" value={softness} min={0} max={100} unit="%" onChange={setSoftness} onReset={softness !== 20 ? () => setSoftness(20) : undefined} hint="輪郭をなじませます。0%でくっきりした境界になります" />
        </div>
      )}

      {files.length > 0 && mode === "color" && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
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
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || (mode === "ai" && analyzing)}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length > 1 ? `${files.length}枚の背景を透明にする` : "背景を透明にする"}
        </button>
      )}

      <ProcessingStatus state={status} processingLabel={progressLabel || "処理中..."} successLabel="背景を透明にしました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.label} ・ {formatBytes(result.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, result.name)} />
        </div>
      )}
    </div>
  );
}
