"use client";

import { useEffect, useRef, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { WordToPdfProcessor } from "@/lib/processors/browser/word-to-pdf";
import { canvasToBlob } from "@/lib/processors/browser/image";
import { closePdfDocument, loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * Word→画像（2026-11-17）。
 * Word（.docx）を、既存の「Word→PDF」と同じ方法でページに組んでから、ページごとに PNG・JPEG の画像にする。
 * - 先に全ページの縮小プレビューを出し、画像にするページ（全部・選んだページ）を選べる。
 * - 解像度（dpi）を選べる。複数ページのときは ZIP にまとめる。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

type Format = "image/png" | "image/jpeg";
type PdfDoc = Awaited<ReturnType<typeof loadPdfDocument>>;

const DPI_OPTIONS = [96, 150, 200, 300] as const;
/** 1枚の画像の画素数の上限（大きすぎるとブラウザが描けないため） */
const MAX_PIXELS = 36_000_000;

interface OutputItem {
  blob: Blob;
  name: string;
  page: number;
  width: number;
  height: number;
}

async function renderPage(pdf: PdfDoc, pageNumber: number, scale: number, mime: Format): Promise<{ blob: Blob; width: number; height: number }> {
  const page = await pdf.getPage(pageNumber);
  let viewport = page.getViewport({ scale });
  if (viewport.width * viewport.height > MAX_PIXELS) {
    const fit = Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height));
    viewport = page.getViewport({ scale: scale * fit });
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を作る準備（Canvas）に失敗しました");
  // JPEG は透明を表せないため、先に白で塗っておく
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await canvasToBlob(canvas, mime, 0.92);
  const out = { blob, width: canvas.width, height: canvas.height };
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

/** 「1-3, 5」のようなページの指定を読む（1始まり） */
export function parsePageRanges(text: string, max: number): number[] | null {
  const pages = new Set<number>();
  const parts = text.split(/[,、，\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  for (const part of parts) {
    const m = /^(\d+)(?:[-－〜~](\d+))?$/.exec(part.normalize("NFKC"));
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > max) return null;
    for (let p = a; p <= b; p++) pages.add(p);
  }
  return Array.from(pages).sort((x, y) => x - y);
}

export function WordToImageTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [format, setFormat] = useState<Format>("image/png");
  const [dpi, setDpi] = useState<(typeof DPI_OPTIONS)[number]>(150);
  const [pageMode, setPageMode] = useState<"all" | "select">("all");
  const [selected, setSelected] = useState<number[]>([]);
  const [rangeText, setRangeText] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<OutputItem[] | null>(null);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);
  const thumbsRef = useRef<string[]>([]);
  const loadId = useRef(0);

  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);
  useEffect(() => () => thumbsRef.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function resetOutputs() {
    setOutputs(null);
    setZipBlob(null);
    setStatus("idle");
  }

  async function handleSelect(files: File[]) {
    const f = files[0];
    if (!f) return;
    const id = ++loadId.current;
    thumbs.forEach((u) => URL.revokeObjectURL(u));
    setThumbs([]);
    setFile(f);
    setPdfBlob(null);
    setPageCount(0);
    setSelected([]);
    setRangeText("");
    setWarnings([]);
    setError(null);
    resetOutputs();
    setLoading(true);
    let pdf: PdfDoc | null = null;
    try {
      const res = await new WordToPdfProcessor().process({ file: f });
      if (id !== loadId.current) return;
      pdf = await loadPdfDocument(new File([res.blob], "word.pdf", { type: "application/pdf" }));
      const urls: string[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const r = await renderPage(pdf, p, Math.min(1, 220 / base.width), "image/jpeg");
        urls.push(URL.createObjectURL(r.blob));
        if (id !== loadId.current) {
          urls.forEach((u) => URL.revokeObjectURL(u));
          return;
        }
      }
      setPdfBlob(res.blob);
      setPageCount(pdf.numPages);
      setThumbs(urls);
      setSelected(Array.from({ length: pdf.numPages }, (_, i) => i + 1));
      setWarnings(res.warnings);
    } catch (e) {
      if (id !== loadId.current) return;
      setFile(null);
      setError(e instanceof Error ? e.message : "Wordのファイルを読み取れませんでした。");
    } finally {
      await closePdfDocument(pdf);
      if (id === loadId.current) setLoading(false);
    }
  }

  function clearFile() {
    loadId.current++;
    thumbs.forEach((u) => URL.revokeObjectURL(u));
    setThumbs([]);
    setFile(null);
    setPdfBlob(null);
    setPageCount(0);
    setSelected([]);
    setLoading(false);
    setError(null);
    resetOutputs();
  }

  const targetPages = pageMode === "all" ? Array.from({ length: pageCount }, (_, i) => i + 1) : [...selected].sort((a, b) => a - b);

  function togglePage(p: number) {
    setPageMode("select");
    setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
    resetOutputs();
  }

  function applyRange() {
    const pages = parsePageRanges(rangeText, pageCount);
    if (!pages) {
      setError(`ページの指定を読み取れませんでした。「1-3, 5」のように、1〜${pageCount}の番号で入力してください。`);
      return;
    }
    setError(null);
    setPageMode("select");
    setSelected(pages);
    resetOutputs();
  }

  async function handleRun() {
    if (!file || !pdfBlob || targetPages.length === 0) return;
    setStatus("processing");
    setError(null);
    setOutputs(null);
    setZipBlob(null);
    let pdf: PdfDoc | null = null;
    try {
      pdf = await loadPdfDocument(new File([pdfBlob], "word.pdf", { type: "application/pdf" }));
      const base = stripExtension(file.name);
      const pad = String(pageCount).length;
      const ext = format === "image/png" ? "png" : "jpg";
      const items: OutputItem[] = [];
      for (const p of targetPages) {
        const r = await renderPage(pdf, p, dpi / 72, format);
        items.push({ ...r, page: p, name: `${base}-${String(p).padStart(pad, "0")}.${ext}` });
      }
      setOutputs(items);
      if (items.length > 1) setZipBlob(await createZip(items.map((i) => ({ name: i.name, blob: i.blob }))));
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "画像にできませんでした。");
      setStatus("error");
    } finally {
      await closePdfDocument(pdf);
    }
  }

  function handleDownload() {
    if (!outputs || !file) return;
    if (outputs.length === 1) downloadBlob(outputs[0].blob, outputs[0].name);
    else if (zipBlob) downloadBlob(zipBlob, `${stripExtension(file.name)}-images.zip`);
  }

  const totalBytes = outputs ? outputs.reduce((s, o) => s + o.blob.size, 0) : 0;

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        thumbs.length > 0 ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              ページのプレビュー（{pageCount}ページ・タップで選択）
            </p>
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="word-image-pages">
              {thumbs.map((url, i) => {
                const p = i + 1;
                const on = targetPages.includes(p);
                return (
                  <li key={p}>
                    <button
                      type="button"
                      onClick={() => togglePage(p)}
                      aria-pressed={on}
                      className={`flex w-full flex-col items-center gap-1 rounded-lg border p-1.5 text-xs transition-colors ${
                        on ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30" : "border-neutral-200 opacity-60 dark:border-neutral-800"
                      }`}
                      data-testid="word-image-page"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`${p}ページ目`} className="max-h-48 w-full object-contain" />
                      <span className="font-semibold">{on ? "✓ " : ""}{p}ページ</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            {loading ? "ページを組んでいます…" : "Wordのファイルを選ぶと、ここにページのプレビューが表示されます"}
          </div>
        )
      }
    >
      <FileDropzone
        compact={!!file}
        accept="application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
        maxSizeMB={30}
        label="Word（.docx）をドラッグ&ドロップ"
        hint="またはタップして選択（上限30MB）"
        onFilesSelected={(f) => void handleSelect(f)}
        onError={setError}
      />
      {file && <FileList files={[file]} onRemove={clearFile} />}
      {loading && <p className="text-xs text-neutral-500" data-testid="word-image-loading">ページを組んでいます…</p>}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300" data-testid="word-image-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {pageCount > 0 && (
        <SettingsStack>
          <SettingsSection n={1} title="画像にするページ" summary={pageMode === "all" ? `全${pageCount}ページ` : `${targetPages.length}ページ`}>
            <Segmented
              value={pageMode}
              onChange={(m) => {
                setPageMode(m);
                resetOutputs();
              }}
              ariaLabel="画像にするページ"
              size="sm"
              testId="word-image-page-mode"
              options={[
                { value: "all", label: "すべてのページ" },
                { value: "select", label: "ページを選ぶ" },
              ]}
            />
            {pageMode === "select" && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={rangeText}
                  onChange={(e) => setRangeText(e.target.value)}
                  placeholder="例：1-3, 5"
                  className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  data-testid="word-image-range"
                />
                <button
                  type="button"
                  onClick={applyRange}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:border-blue-400 dark:border-neutral-700"
                  data-testid="word-image-range-apply"
                >
                  この番号で選ぶ
                </button>
                <span className="text-xs text-neutral-500">プレビューのページをタップしても選べます（{targetPages.length}ページ選択中）</span>
              </div>
            )}
          </SettingsSection>
          <SettingsSection n={2} title="画像の形式と解像度" summary={`${format === "image/png" ? "PNG" : "JPEG"}・${dpi}dpi`}>
            <Segmented
              value={format}
              onChange={(v) => {
                setFormat(v);
                resetOutputs();
              }}
              label="形式"
              size="sm"
              testId="word-image-format"
              options={[
                { value: "image/png", label: "PNG（文字がくっきり）" },
                { value: "image/jpeg", label: "JPEG（ファイルが小さい）" },
              ]}
            />
            <Segmented
              value={String(dpi)}
              onChange={(v) => {
                setDpi(Number(v) as (typeof DPI_OPTIONS)[number]);
                resetOutputs();
              }}
              label="解像度"
              size="sm"
              testId="word-image-dpi"
              options={DPI_OPTIONS.map((d) => ({ value: String(d), label: `${d}dpi` }))}
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">画面で見るなら96〜150dpi、印刷するなら200〜300dpiが目安です（大きいほどファイルも大きくなります）。</p>
          </SettingsSection>
        </SettingsStack>
      )}

      {pageCount > 0 && (
        <RunBar>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={status === "processing" || targetPages.length === 0}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid="word-image-run"
          >
            {targetPages.length === 0 ? "ページを選んでください" : `${targetPages.length}ページを画像にする`}
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel="画像にしました" />
      {error && <ErrorMessage message={error} testId="word-image-error" />}

      {outputs && outputs.length > 0 && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="word-image-result">
            {outputs.length}枚 ・ {outputs[0].width}×{outputs[0].height}px ・ {formatBytes(totalBytes)}
            {outputs.length > 1 ? "（ZIPにまとめます）" : ""}
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label={outputs.length > 1 ? "ZIPをダウンロード" : "ダウンロード"} />
        </ResultPopup>
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ページの組み方は「Word→PDF」と同じです。Wordで開いたときと、改ページの位置や文字の配置が少し違うことがあります。
      </p>
    </PreviewSplitLayout>
  );
}
