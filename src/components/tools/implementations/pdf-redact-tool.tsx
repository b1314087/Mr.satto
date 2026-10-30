"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import {
  groupRegionsByPage,
  normalizeRegion,
  REDACT_MAX_PAGES,
  REDACT_MAX_REDACTED_PAGES,
  REDACT_NOTICE,
  type RedactRegion,
} from "@/lib/pdf/redact";
import { PdfRedactProcessor, type PdfRedactOutput } from "@/lib/processors/browser/pdf-redact";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

type PdfDoc = Awaited<ReturnType<typeof loadPdfDocument>>;

/** 表示の倍率（%）。100%のときの、ページの横幅（CSS px） */
const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 250];
const DEFAULT_ZOOM = 100;
const BASE_WIDTH_PX = 560;
const MAX_SOURCE_MB = 50;

interface Draft {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** PDF黒塗り・墨消し。範囲を指定したページを画像にして黒を焼き込み、元のデータを残さない新しいPDFを作る */
export function PdfRedactTool() {
  const [file, setFile] = useState<File | null>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [regions, setRegions] = useState<RedactRegion[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [aspect, setAspect] = useState(1.414);
  const [rendering, setRendering] = useState(false);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ output: PdfRedactOutput; file: File; name: string } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // ファイルを選ぶと読み込む（ブラウザ内だけで処理する）
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      setLoading(true);
      try {
        const pdf = await loadPdfDocument(file);
        loaded = pdf;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        if (pdf.numPages > REDACT_MAX_PAGES) {
          setError(
            `ページ数が多すぎます（${pdf.numPages}ページ）。一度に処理できるのは${REDACT_MAX_PAGES}ページまでです。ページを分けてから、もう一度お試しください。`
          );
          void pdf.destroy();
          setDoc(null);
          setPageCount(0);
          return;
        }
        setDoc(pdf);
        setPageCount(pdf.numPages);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
        setDoc(null);
        setPageCount(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [file]);

  // 表示するページを描く（倍率・ページが変わるたびに描き直す）
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      setRendering(true);
      try {
        const page = await doc.getPage(pageIndex + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setAspect(base.height / base.width);
        const cssWidth = (BASE_WIDTH_PX * zoom) / 100;
        const dpr = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (cssWidth * dpr) / base.width });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch {
        // 描き直しで中断された場合は何もしない
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageIndex, zoom]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.output.url);
    };
  }, [result]);

  function resetAll() {
    setDoc(null);
    setPageCount(0);
    setPageIndex(0);
    setZoom(DEFAULT_ZOOM);
    setRegions([]);
    setDraft(null);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  function invalidateResult() {
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function pointFromEvent(e: React.PointerEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || status === "processing") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointFromEvent(e);
    setDraft({ startX: p.x, startY: p.y, x: p.x, y: p.y });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draft) return;
    const p = pointFromEvent(e);
    setDraft({ ...draft, x: p.x, y: p.y });
  }

  function finishDraw(e: React.PointerEvent<HTMLDivElement>) {
    if (!draft) return;
    const p = pointFromEvent(e);
    const region = normalizeRegion({
      page: pageIndex,
      x: draft.startX,
      y: draft.startY,
      width: p.x - draft.startX,
      height: p.y - draft.startY,
    });
    setDraft(null);
    if (!region) return;
    const redactedPages = new Set(regions.map((r) => r.page));
    if (!redactedPages.has(pageIndex) && redactedPages.size >= REDACT_MAX_REDACTED_PAGES) {
      setError(`黒塗りできるのは、一度に${REDACT_MAX_REDACTED_PAGES}ページまでです。何回かに分けて処理してください。`);
      return;
    }
    setRegions((prev) => [...prev, region]);
    invalidateResult();
  }

  const removeRegion = useCallback((target: RedactRegion) => {
    setRegions((prev) => prev.filter((r) => r !== target));
    setResult(null);
    setStatus("idle");
  }, []);

  async function handleRun() {
    if (!file || regions.length === 0) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new PdfRedactProcessor().process({ file, regions });
      const name = `${stripExtension(file.name)}-redacted.pdf`;
      setResult({ output, file: new File([output.blob], name, { type: "application/pdf" }), name });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const grouped = useMemo(() => groupRegionsByPage(regions), [regions]);
  const pageRegions = regions.filter((r) => r.page === pageIndex);
  const draftRect = draft
    ? {
        left: Math.min(draft.startX, draft.x),
        top: Math.min(draft.startY, draft.y),
        width: Math.abs(draft.x - draft.startX),
        height: Math.abs(draft.y - draft.startY),
      }
    : null;
  const cssWidth = (BASE_WIDTH_PX * zoom) / 100;
  const zoomIndex = ZOOM_STEPS.indexOf(zoom);

  return (
    <div className="flex flex-col gap-6">
      <div
        data-testid="pdf-redact-notice"
        className="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-200"
      >
        <p className="font-semibold">{REDACT_NOTICE.title}</p>
        <ul className="list-disc pl-4">
          {REDACT_NOTICE.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p>
          黒い四角形を重ねるだけで、元の文字を消さない機能は
          <Link href="/tools/pdf-fix" className="underline">
            PDF修正の白消し
          </Link>
          です。個人情報などを確実に消したいときは、このツールを使ってください。
        </p>
      </div>

      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={MAX_SOURCE_MB}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => {
          resetAll();
          setFile(files[0]);
        }}
        onError={setError}
      />

      {file && (
        <FileList
          files={[file]}
          onRemove={() => {
            setFile(null);
            resetAll();
          }}
        />
      )}

      {file && loading && <p className="text-xs text-neutral-400">PDFを読み込み中…</p>}

      {doc && pageCount > 0 && (
        <div data-testid="tool-preview" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            黒塗りしたい場所を、ページ上でドラッグして囲んでください
          </p>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              disabled={pageIndex === 0}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300"
            >
              前のページ
            </button>
            <span data-testid="pdf-redact-page-label" className="text-neutral-600 dark:text-neutral-300">
              {pageIndex + 1} / {pageCount} ページ
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
              disabled={pageIndex >= pageCount - 1}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300"
            >
              次のページ
            </button>
            <span className="mx-2 text-neutral-300">|</span>
            <button
              type="button"
              onClick={() => zoomIndex > 0 && setZoom(ZOOM_STEPS[zoomIndex - 1])}
              disabled={zoomIndex <= 0}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300"
            >
              縮小
            </button>
            <span data-testid="pdf-redact-zoom" className="w-12 text-center text-neutral-600 dark:text-neutral-300">
              {zoom}%
            </span>
            <button
              type="button"
              onClick={() => zoomIndex < ZOOM_STEPS.length - 1 && setZoom(ZOOM_STEPS[zoomIndex + 1])}
              disabled={zoomIndex >= ZOOM_STEPS.length - 1}
              className="rounded-lg bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300"
            >
              拡大
            </button>
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-lg border border-neutral-200 bg-neutral-100 p-2 dark:border-neutral-700 dark:bg-neutral-900">
            <div className="relative mx-auto select-none" style={{ width: cssWidth, height: cssWidth * aspect }}>
              <canvas
                ref={canvasRef}
                data-testid="pdf-redact-canvas"
                className="block bg-white"
                style={{ width: cssWidth, height: cssWidth * aspect }}
              />
              <div
                ref={overlayRef}
                data-testid="pdf-redact-overlay"
                role="application"
                aria-label="黒塗りする範囲を指定するページ"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={finishDraw}
                onPointerCancel={() => setDraft(null)}
                className="absolute inset-0 cursor-crosshair"
                style={{ touchAction: "none" }}
              >
                {pageRegions.map((r, i) => (
                  <div
                    key={`${r.x}-${r.y}-${i}`}
                    data-testid="pdf-redact-region"
                    data-page={r.page}
                    className="pointer-events-none absolute border-2 border-red-500 bg-black/80"
                    style={{
                      left: `${r.x * 100}%`,
                      top: `${r.y * 100}%`,
                      width: `${r.width * 100}%`,
                      height: `${r.height * 100}%`,
                    }}
                  />
                ))}
                {draftRect && (
                  <div
                    className="pointer-events-none absolute border-2 border-dashed border-red-500 bg-black/40"
                    style={{
                      left: `${draftRect.left * 100}%`,
                      top: `${draftRect.top * 100}%`,
                      width: `${draftRect.width * 100}%`,
                      height: `${draftRect.height * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>
          </div>
          {rendering && <p className="text-xs text-neutral-400">ページを表示中…</p>}

          <div className="flex flex-col gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <p data-testid="pdf-redact-summary">
              指定した範囲：{regions.length}個（{grouped.size}ページ）
              {pageRegions.length > 0 && `／ このページ：${pageRegions.length}個`}
            </p>
            {pageRegions.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {pageRegions.map((r, i) => (
                  <li key={`${r.x}-${r.y}-${i}`}>
                    <button
                      type="button"
                      aria-label={`このページの範囲${i + 1}を取り消す`}
                      onClick={() => removeRegion(r)}
                      className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      範囲{i + 1}を取り消す
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setRegions((prev) => prev.slice(0, -1));
                  invalidateResult();
                }}
                disabled={regions.length === 0}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300"
              >
                直前の範囲を取り消す
              </button>
              <button
                type="button"
                onClick={() => {
                  setRegions((prev) => prev.filter((r) => r.page !== pageIndex));
                  invalidateResult();
                }}
                disabled={pageRegions.length === 0}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-300"
              >
                このページの範囲をすべて取り消す
              </button>
            </div>
            {grouped.size > 0 && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                範囲を指定したページ（{[...grouped.keys()].sort((a, b) => a - b).map((p) => p + 1).join("、")}）は、ページ全体が画像になります。
              </p>
            )}
          </div>
        </div>
      )}

      {doc && (
        <button
          type="button"
          onClick={handleRun}
          disabled={regions.length === 0 || status === "processing"}
          aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          黒塗りを確定して新しいPDFを作る
        </button>
      )}

      <ProcessingStatus state={status} successLabel="黒塗りが完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup size="lg">
          <p data-testid="pdf-redact-result-summary" className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.output.regionCount}個の範囲を黒塗りしました（{result.output.redactedPages.length}ページを画像にしました）・
            {result.output.pageCount}ページ・{formatBytes(result.output.sizeBytes)}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            黒塗りしたページに文字が残っていないことを、作成したPDFを開き直して確認済みです。下の画像で、黒塗りの位置を確認してから保存してください。
          </p>
          <PdfThumbnails
            file={result.file}
            pages={result.output.redactedPages.map((p) => p + 1)}
            maxPages={Math.min(REDACT_MAX_PAGES, Math.max(...result.output.redactedPages) + 1)}
            width={160}
            title="黒塗りしたページ"
          />
          <RewardedDownloadGate onDownload={() => downloadBlob(result.output.blob, result.name)} label="黒塗りしたPDFをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
