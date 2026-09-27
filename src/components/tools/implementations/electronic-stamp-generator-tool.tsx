"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  STAMP_COLORS,
  STAMP_LIMITS,
  StampExportProcessor,
  autoTrimTransparentMargins,
  cropCanvasRegion,
  generateStampCanvas,
  loadStampImageToCanvas,
  loadStampPdf,
  removeLightBackground,
  renderStampPdfPage,
  resizeCanvasByScale,
  type StampColorId,
  type StampShape,
  type StampTextLayout,
} from "@/lib/processors/browser/electronic-stamp";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob } from "@/lib/utils/format";

/**
 * 電子印鑑生成ツール（Phase 16）。
 *
 * 重要: これは「印影画像（透明PNG）を作る・取り込むためのツール」であり、
 * 法的な効力を持つ電子署名・デジタル署名・電子契約を提供するものではない。
 * UI文言でもその旨を明示し、「電子署名」という語は使用しない。
 *
 * 「文字から作る」「印鑑を取り込む」の2モードを持つ。処理はすべて
 * ブラウザのCanvas上で完結し、画像・PDFの中身をサーバーへ送信したり、
 * localStorage/sessionStorage/IndexedDBへ保存したりすることは一切ない。
 */

type Mode = "text" | "import";
type ImportStep = "select" | "crop" | "adjust";

interface Box {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

const DEFAULT_BOX: Box = { xPct: 15, yPct: 15, wPct: 70, hPct: 70 };
const MIN_SIZE_PCT = 5;
const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

function clampBox(next: Box): Box {
  const wPct = Math.min(Math.max(next.wPct, MIN_SIZE_PCT), 100);
  const hPct = Math.min(Math.max(next.hPct, MIN_SIZE_PCT), 100);
  const xPct = Math.min(Math.max(next.xPct, 0), 100 - wPct);
  const yPct = Math.min(Math.max(next.yPct, 0), 100 - hPct);
  return { xPct, yPct, wPct, hPct };
}

/** 透明背景が分かるよう、プレビューの背後に敷くチェッカー柄 */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, #d4d4d4 25%, transparent 25%), linear-gradient(-45deg, #d4d4d4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d4 75%), linear-gradient(-45deg, transparent 75%, #d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  backgroundColor: "#f5f5f5",
};

const COLOR_OPTIONS: { id: StampColorId; label: string }[] = [
  { id: "red", label: "朱色" },
  { id: "black", label: "黒" },
  { id: "blue", label: "青" },
];

function extToSuffix(): string {
  return "png";
}

export function ElectronicStampGeneratorTool() {
  const [mode, setMode] = useState<Mode>("text");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function resetResult() {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleExport(canvas: HTMLCanvasElement) {
    setStatus("processing");
    setError(null);
    try {
      const output = await new StampExportProcessor().process({ canvas });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "印影画像の生成に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setMode("text");
            resetResult();
          }}
          aria-pressed={mode === "text"}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            mode === "text"
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          文字から作る
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("import");
            resetResult();
          }}
          aria-pressed={mode === "import"}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            mode === "import"
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          印鑑を取り込む
        </button>
      </div>

      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        本ツールで作成・取り込みできるのは「印影画像」です。法的な効力を持つ電子署名・デジタル署名を提供するものではありません。
      </p>

      {mode === "text" ? (
        <TextStampPanel onExport={handleExport} status={status} />
      ) : (
        <ImportStampPanel onExport={handleExport} status={status} />
      )}

      <ProcessingStatus state={status} processingLabel="生成中..." successLabel="印影画像が完成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-700" style={CHECKER_STYLE}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.url} alt="生成された印影画像のプレビュー" className="max-h-56 max-w-full object-contain" />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px（透明PNG）
          </p>
          <RewardedDownloadGate
            label="PNGをダウンロード"
            onDownload={() => downloadBlob(result.blob, `electronic-stamp.${extToSuffix()}`)}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A. 文字から印影を生成
// ---------------------------------------------------------------------------

function TextStampPanel({
  onExport,
  status,
}: {
  onExport: (canvas: HTMLCanvasElement) => void | Promise<void>;
  status: ProcessingState;
}) {
  const [text, setText] = useState("印");
  const [shape, setShape] = useState<StampShape>("round");
  const [layout, setLayout] = useState<StampTextLayout>("vertical");
  const [sizePx, setSizePx] = useState(300);
  const [fontScale, setFontScale] = useState(1);
  const [borderWidthRatio, setBorderWidthRatio] = useState(0.05);
  const [paddingRatio, setPaddingRatio] = useState(0.08);
  const [color, setColor] = useState<StampColorId>("red");
  const [offsetXPct, setOffsetXPct] = useState(0);
  const [offsetYPct, setOffsetYPct] = useState(0);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const latestCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const target = previewRef.current;
    if (!target) return;
    const generated = generateStampCanvas({
      text: text.trim() || "印",
      shape,
      layout,
      sizePx,
      fontScale,
      borderWidthRatio,
      paddingRatio,
      color,
      offsetXPct,
      offsetYPct,
    });
    latestCanvasRef.current = generated;
    target.width = generated.width;
    target.height = generated.height;
    const ctx = target.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(generated, 0, 0);
    }
  }, [text, shape, layout, sizePx, fontScale, borderWidthRatio, paddingRatio, color, offsetXPct, offsetYPct]);

  const textTooLong = Array.from(text).length > STAMP_LIMITS.maxTextLength;

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      <div className="flex flex-1 flex-col gap-4">
        <div>
          <label htmlFor="stamp-text-input" className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-200">
            文字
          </label>
          <input
            id="stamp-text-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={STAMP_LIMITS.maxTextLength + 4}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="例）印、山田、承認"
          />
          {textTooLong && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              文字数は{STAMP_LIMITS.maxTextLength}文字以内でご利用ください。
            </p>
          )}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">印影タイプ</legend>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={shape === "round"}
              onClick={() => setShape("round")}
              className={`rounded-lg px-3 py-1.5 text-sm ${shape === "round" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              丸印
            </button>
            <button
              type="button"
              aria-pressed={shape === "square"}
              onClick={() => setShape("square")}
              className={`rounded-lg px-3 py-1.5 text-sm ${shape === "square" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              角印
            </button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">文字の向き</legend>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={layout === "vertical"}
              onClick={() => setLayout("vertical")}
              className={`rounded-lg px-3 py-1.5 text-sm ${layout === "vertical" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              縦書き
            </button>
            <button
              type="button"
              aria-pressed={layout === "horizontal"}
              onClick={() => setLayout("horizontal")}
              className={`rounded-lg px-3 py-1.5 text-sm ${layout === "horizontal" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              横書き
            </button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">色</legend>
          <div className="flex gap-2">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={color === c.id}
                onClick={() => setColor(c.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${color === c.id ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                <span
                  aria-hidden="true"
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: STAMP_COLORS[c.id] }}
                />
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
          印影サイズ（{sizePx}px）
          <input
            type="range"
            min={STAMP_LIMITS.minStampSizePx}
            max={STAMP_LIMITS.maxStampSizePx}
            step={10}
            value={sizePx}
            onChange={(e) => setSizePx(Number(e.target.value))}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
          文字サイズ
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={fontScale}
            onChange={(e) => setFontScale(Number(e.target.value))}
          />
        </label>

        <details className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-700">
          <summary className="cursor-pointer font-medium text-neutral-700 dark:text-neutral-200">
            詳細設定（枠の太さ・余白・位置調整）
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              枠の太さ
              <input
                type="range"
                min={0.01}
                max={0.1}
                step={0.005}
                value={borderWidthRatio}
                onChange={(e) => setBorderWidthRatio(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              内側の余白
              <input
                type="range"
                min={0}
                max={0.3}
                step={0.01}
                value={paddingRatio}
                onChange={(e) => setPaddingRatio(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              文字位置（左右）
              <input
                type="range"
                min={-20}
                max={20}
                step={1}
                value={offsetXPct}
                onChange={(e) => setOffsetXPct(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              文字位置（上下）
              <input
                type="range"
                min={-20}
                max={20}
                step={1}
                value={offsetYPct}
                onChange={(e) => setOffsetYPct(Number(e.target.value))}
              />
            </label>
          </div>
        </details>

        <button
          type="button"
          disabled={status === "processing" || text.trim() === "" || textTooLong}
          onClick={() => {
            if (latestCanvasRef.current) void onExport(latestCanvasRef.current);
          }}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          印影画像を生成する
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700" style={CHECKER_STYLE}>
          <canvas ref={previewRef} aria-label="印影のプレビュー" className="max-h-72 max-w-full" />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">背景の市松模様は透明部分を示す表示用のものです</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. 既存の印鑑を取り込む
// ---------------------------------------------------------------------------

function ImportStampPanel({
  onExport,
  status,
}: {
  onExport: (canvas: HTMLCanvasElement) => void | Promise<void>;
  status: ProcessingState;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ImportStep>("select");
  const [error, setError] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  // PDF関連
  const pdfDocRef = useRef<Awaited<ReturnType<typeof loadStampPdf>> | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [selectedPage, setSelectedPage] = useState(1);
  const [isPdf, setIsPdf] = useState(false);

  // 表示中の元画像（PDFの場合は選択中ページ）
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);

  // 切り抜き範囲
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize";
    corner?: Corner;
    startClientX: number;
    startClientY: number;
    startBox: Box;
  } | null>(null);

  // 切り抜き後〜調整
  const croppedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [removalEnabled, setRemovalEnabled] = useState(true);
  const [thresholdPercent, setThresholdPercent] = useState(55);
  const [autoTrimEnabled, setAutoTrimEnabled] = useState(true);
  const [scalePercent, setScalePercent] = useState(100);
  const [trimMessage, setTrimMessage] = useState<string | null>(null);
  const finalPreviewRef = useRef<HTMLCanvasElement>(null);
  const finalCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    return () => {
      if (sourceImageUrl) URL.revokeObjectURL(sourceImageUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFromFile(f: File) {
    setError(null);
    setLoadingSource(true);
    try {
      const pdfLike = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      setIsPdf(pdfLike);
      if (pdfLike) {
        const pdf = await loadStampPdf(f);
        if (pdf.numPages === 0) throw new Error("このPDFにはページがありません。");
        pdfDocRef.current = pdf;
        setPageCount(pdf.numPages);
        setSelectedPage(1);
        await renderPage(pdf, 1);
      } else {
        pdfDocRef.current = null;
        setPageCount(1);
        setSelectedPage(1);
        const canvas = await loadStampImageToCanvas(f);
        applySourceCanvas(canvas);
      }
      setBox(DEFAULT_BOX);
      setStep("crop");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした。対応形式を確認してください。");
      setStep("select");
    } finally {
      setLoadingSource(false);
    }
  }

  function applySourceCanvas(canvas: HTMLCanvasElement) {
    if (sourceImageUrl) URL.revokeObjectURL(sourceImageUrl);
    sourceCanvasRef.current = canvas;
    setSourceSize({ width: canvas.width, height: canvas.height });
    const url = canvas.toDataURL("image/png");
    setSourceImageUrl(url);
  }

  async function renderPage(pdf: Awaited<ReturnType<typeof loadStampPdf>>, pageNumber: number) {
    const canvas = await renderStampPdfPage(pdf, pageNumber, 900);
    applySourceCanvas(canvas);
  }

  async function handlePageChange(next: number) {
    if (!pdfDocRef.current || next < 1 || next > pageCount) return;
    setLoadingSource(true);
    try {
      setSelectedPage(next);
      await renderPage(pdfDocRef.current, next);
      setBox(DEFAULT_BOX);
    } catch {
      setError("ページの表示に失敗しました。");
    } finally {
      setLoadingSource(false);
    }
  }

  function handleBoxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "move", startClientX: e.clientX, startClientY: e.clientY, startBox: box };
  }

  function handleHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, corner: Corner) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", corner, startClientX: e.clientX, startClientY: e.clientY, startBox: box };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dxPct = ((e.clientX - drag.startClientX) / rect.width) * 100;
    const dyPct = ((e.clientY - drag.startClientY) / rect.height) * 100;

    if (drag.mode === "move") {
      setBox(clampBox({ ...drag.startBox, xPct: drag.startBox.xPct + dxPct, yPct: drag.startBox.yPct + dyPct }));
      return;
    }

    let { xPct, yPct, wPct, hPct } = drag.startBox;
    const corner = drag.corner ?? "se";
    if (corner.includes("e")) wPct = drag.startBox.wPct + dxPct;
    if (corner.includes("s")) hPct = drag.startBox.hPct + dyPct;
    if (corner.includes("w")) {
      wPct = drag.startBox.wPct - dxPct;
      xPct = drag.startBox.xPct + dxPct;
    }
    if (corner.includes("n")) {
      hPct = drag.startBox.hPct - dyPct;
      yPct = drag.startBox.yPct + dyPct;
    }
    setBox(clampBox({ xPct, yPct, wPct, hPct }));
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  const NUDGE_PCT = 2;
  function handleBoxKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const delta: Record<string, Partial<Box>> = {
      ArrowLeft: { xPct: box.xPct - NUDGE_PCT },
      ArrowRight: { xPct: box.xPct + NUDGE_PCT },
      ArrowUp: { yPct: box.yPct - NUDGE_PCT },
      ArrowDown: { yPct: box.yPct + NUDGE_PCT },
    };
    const patch = delta[e.key];
    if (!patch) return;
    e.preventDefault();
    setBox(clampBox({ ...box, ...patch }));
  }

  function handleCancelCrop() {
    setBox(DEFAULT_BOX);
  }

  function handleConfirmCrop() {
    const source = sourceCanvasRef.current;
    const size = sourceSize;
    if (!source || !size) return;
    const region = {
      x: Math.round((box.xPct / 100) * size.width),
      y: Math.round((box.yPct / 100) * size.height),
      width: Math.round((box.wPct / 100) * size.width),
      height: Math.round((box.hPct / 100) * size.height),
    };
    try {
      const cropped = cropCanvasRegion(source, region);
      croppedCanvasRef.current = cropped;
      setRemovalEnabled(true);
      setThresholdPercent(55);
      setAutoTrimEnabled(true);
      setScalePercent(100);
      setStep("adjust");
    } catch {
      setError("印影部分をもう少し大きく選択してください。");
    }
  }

  useEffect(() => {
    if (step !== "adjust") return;
    const base = croppedCanvasRef.current;
    const target = finalPreviewRef.current;
    if (!base || !target) return;
    try {
      let working = base;
      if (removalEnabled) {
        working = removeLightBackground(working, thresholdPercent);
      }
      let trimmedNote: string | null = null;
      if (autoTrimEnabled) {
        const { canvas: trimmed, trimmed: didTrim } = autoTrimTransparentMargins(working, 6);
        working = trimmed;
        if (removalEnabled && !didTrim) {
          trimmedNote = "印影が検出できなかったため、余白のトリミングは行われていません。";
        }
      }
      if (scalePercent !== 100) {
        working = resizeCanvasByScale(working, scalePercent);
      }
      finalCanvasRef.current = working;
      setTrimMessage(trimmedNote);
      target.width = working.width;
      target.height = working.height;
      const ctx = target.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(working, 0, 0);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "この画像では背景を完全に透明化できない場合があります。");
    }
  }, [step, removalEnabled, thresholdPercent, autoTrimEnabled, scalePercent]);

  return (
    <div className="flex flex-col gap-5">
      {error && <ErrorMessage message={error} />}
      {step === "select" && (
        <>
          <FileDropzone
            accept="image/png,image/jpeg,application/pdf"
            label="印鑑の画像・PDFをドラッグ&ドロップ"
            hint="またはタップして選択（PNG・JPG・PDF）"
            onFilesSelected={(files) => {
              setFile(files[0]);
              void loadFromFile(files[0]);
            }}
            onError={setError}
          />
          {loadingSource && <p className="text-sm text-neutral-500 dark:text-neutral-400">読み込み中...</p>}
        </>
      )}

      {step === "crop" && sourceImageUrl && sourceSize && (
        <div className="flex flex-col gap-3">
          {file && <p className="text-xs text-neutral-500 dark:text-neutral-400">{file.name}</p>}

          {isPdf && pageCount > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => void handlePageChange(selectedPage - 1)}
                disabled={selectedPage <= 1 || loadingSource}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 disabled:opacity-40 dark:bg-neutral-800"
              >
                前へ
              </button>
              <span>
                {selectedPage} / {pageCount} ページ
              </span>
              <button
                type="button"
                onClick={() => void handlePageChange(selectedPage + 1)}
                disabled={selectedPage >= pageCount || loadingSource}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 disabled:opacity-40 dark:bg-neutral-800"
              >
                次へ
              </button>
            </div>
          )}

          <div
            ref={containerRef}
            data-testid="stamp-crop-container"
            className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sourceImageUrl} alt="取り込んだ印鑑のプレビュー" draggable={false} className="block h-auto w-full select-none" />
            <div
              role="group"
              tabIndex={0}
              aria-label="印影の切り抜き範囲。矢印キーで移動できます"
              onPointerDown={handleBoxPointerDown}
              onKeyDown={handleBoxKeyDown}
              data-testid="stamp-crop-box"
              className="absolute cursor-move border-2 border-blue-400 bg-blue-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              style={{ left: `${box.xPct}%`, top: `${box.yPct}%`, width: `${box.wPct}%`, height: `${box.hPct}%` }}
            >
              {CORNERS.map((corner) => (
                <div
                  key={corner}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => handleHandlePointerDown(e, corner)}
                  aria-label={`切り抜き範囲の${corner}角をドラッグしてサイズ変更`}
                  className={`absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-blue-500 shadow ${
                    corner === "nw"
                      ? "left-0 top-0 cursor-nwse-resize"
                      : corner === "ne"
                        ? "left-full top-0 cursor-nesw-resize"
                        : corner === "sw"
                          ? "left-0 top-full cursor-nesw-resize"
                          : "left-full top-full cursor-nwse-resize"
                  }`}
                />
              ))}
            </div>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            枠をドラッグして印影を囲み、「切り抜く」を押してください。枠にフォーカスして矢印キーで移動もできます。
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCancelCrop}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            >
              範囲をリセット
            </button>
            <button
              type="button"
              onClick={handleConfirmCrop}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              切り抜く
            </button>
          </div>
        </div>
      )}

      {step === "adjust" && (
        <div className="flex flex-col gap-5 lg:flex-row">
          <div className="flex flex-1 flex-col gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={removalEnabled}
                onChange={(e) => setRemovalEnabled(e.target.checked)}
              />
              背景を自動的に透明化する
            </label>
            <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
              しきい値（{thresholdPercent}）
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                disabled={!removalEnabled}
                value={thresholdPercent}
                onChange={(e) => setThresholdPercent(Number(e.target.value))}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              背景が複雑な画像・影や柄・透かしがある画像では完全に分離できない場合があります。しきい値を調整してご確認ください。
            </p>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={autoTrimEnabled}
                onChange={(e) => setAutoTrimEnabled(e.target.checked)}
              />
              余白を自動的にトリミングする
            </label>
            {trimMessage && <p className="text-xs text-amber-700 dark:text-amber-400">{trimMessage}</p>}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">出力サイズ</legend>
              <div className="flex gap-2">
                {[50, 100, 150, 200].map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={scalePercent === p}
                    onClick={() => setScalePercent(p)}
                    className={`rounded-lg px-3 py-1.5 text-sm ${scalePercent === p ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep("crop")}
                className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                範囲を選び直す
              </button>
              <button
                type="button"
                disabled={status === "processing"}
                onClick={() => {
                  if (finalCanvasRef.current) void onExport(finalCanvasRef.current);
                }}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                印影画像を生成する
              </button>
            </div>
          </div>

          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700" style={CHECKER_STYLE}>
              <canvas ref={finalPreviewRef} data-testid="stamp-final-preview" aria-label="調整後の印影プレビュー" className="max-h-72 max-w-full" />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">背景の市松模様は透明部分を示す表示用のものです</p>
          </div>
        </div>
      )}
    </div>
  );
}
