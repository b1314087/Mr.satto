"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { getPdfjs } from "@/lib/pdf/pdfjs-client";
import { detectGrid, type GrayImage } from "@/lib/roster/scan-grid";
import {
  buildScanGridExcel,
  buildScanGridFileName,
  validateScanGridExcelInput,
} from "@/lib/processors/browser/roster-template";
import { downloadBlob } from "@/lib/utils/format";

/** 読み取り用に描画する画像の長辺(px)。大きいほど細かい線を拾えるが重くなる */
const RENDER_LONG_SIDE = 2200;

interface ScanResult {
  fileName: string;
  pageCount: number;
  pageNumber: number;
  angleDeg: number;
  colWidthsMm: number[];
  rowHeightsMm: number[];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

async function analyzePdf(file: File, pageNumber: number): Promise<ScanResult> {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const pdf = await task.promise;
    const n = Math.min(Math.max(1, pageNumber), pdf.numPages);
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = RENDER_LONG_SIDE / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("画像の処理に対応していないブラウザです");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round(rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114);
    }
    const img: GrayImage = { width: canvas.width, height: canvas.height, data: gray };
    const grid = detectGrid(img);
    // ページの実寸(mm)から、1画素あたりのmmを求める
    const mmPerPx = (base.width * 25.4) / 72 / canvas.width;
    return {
      fileName: file.name,
      pageCount: pdf.numPages,
      pageNumber: n,
      angleDeg: grid.angleDeg,
      colWidthsMm: grid.colWidthsPx.map((w) => round1(w * mmPerPx)),
      rowHeightsMm: grid.rowHeightsPx.map((h) => round1(h * mmPerPx)),
    };
  } finally {
    void task.destroy();
  }
}

function NumberCell({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-neutral-500">
      {label}
      <input
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : ""}
        min={1}
        step={0.5}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
    </label>
  );
}

/** 枠のかたちを縮小して描いた図（検出した列幅・行の高さの比率どおり） */
function GridSchematic({ colWidthsMm, rowHeightsMm }: { colWidthsMm: number[]; rowHeightsMm: number[] }) {
  const totalW = colWidthsMm.reduce((a, b) => a + b, 0);
  const totalH = rowHeightsMm.reduce((a, b) => a + b, 0);
  if (!(totalW > 0) || !(totalH > 0)) return null;
  const xs = [0];
  colWidthsMm.forEach((w) => xs.push(xs[xs.length - 1] + w));
  const ys = [0];
  rowHeightsMm.forEach((h) => ys.push(ys[ys.length - 1] + h));
  return (
    <svg
      viewBox={`-1 -1 ${totalW + 2} ${totalH + 2}`}
      role="img"
      aria-label="検出した枠のイメージ"
      className="mx-auto block max-h-96 w-full max-w-md border border-neutral-200 bg-white"
    >
      {xs.map((x, i) => (
        <line key={`v${i}`} x1={x} y1={0} x2={x} y2={totalH} stroke="#222" strokeWidth={0.4} />
      ))}
      {ys.map((y, i) => (
        <line key={`h${i}`} x1={0} y1={y} x2={totalW} y2={y} stroke="#222" strokeWidth={0.4} />
      ))}
    </svg>
  );
}

export function RosterScanPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [analyzing, setAnalyzing] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [colWidthsMm, setColWidthsMm] = useState<number[]>([]);
  const [rowHeightsMm, setRowHeightsMm] = useState<number[]>([]);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);

  async function analyze(f: File, page: number) {
    setAnalyzing(true);
    setScanError(null);
    setResult(null);
    setStatus("idle");
    try {
      const r = await analyzePdf(f, page);
      setScan(r);
      setPageNumber(r.pageNumber);
      setColWidthsMm(r.colWidthsMm);
      setRowHeightsMm(r.rowHeightsMm);
    } catch (e) {
      setScan(null);
      setColWidthsMm([]);
      setRowHeightsMm([]);
      setScanError(e instanceof Error ? e.message : "PDFの読み取りに失敗しました");
    } finally {
      setAnalyzing(false);
    }
  }

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setPageNumber(1);
    void analyze(files[0], 1);
  }

  const validation = scan ? validateScanGridExcelInput({ colWidthsMm, rowHeightsMm }) : null;
  const totalW = colWidthsMm.reduce((a, b) => a + b, 0);
  const totalH = rowHeightsMm.reduce((a, b) => a + b, 0);

  function edit(setter: (fn: (prev: number[]) => number[]) => void, index: number, v: number) {
    setter((prev) => prev.map((x, i) => (i === index ? v : x)));
    setResult(null);
    setStatus("idle");
  }

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    try {
      setResult(await buildScanGridExcel({ colWidthsMm, rowHeightsMm }));
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          紙の名簿をスキャンしたPDFを読み込むと、罫線（枠）の位置から列の幅・行の高さを読み取り、同じ大きさの空欄の枠をExcelで作ります。
          文字は読み取りません。
        </p>
        <FileDropzone
          accept=".pdf,application/pdf"
          maxSizeMB={50}
          label="スキャンしたPDFをドラッグ&ドロップ"
          hint="またはタップして選択"
          onFilesSelected={handleSelect}
          onError={setScanError}
        />
      </div>

      {analyzing && <p className="text-sm text-neutral-500">罫線を読み取っています…</p>}
      {scanError && <ErrorMessage message={scanError} />}

      {scan && !analyzing && (
          <PreviewSplitLayout
            preview={
          <div data-testid="tool-preview" className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="mb-2 text-sm font-medium">検出した枠（実寸の比率）</p>
            <GridSchematic colWidthsMm={colWidthsMm} rowHeightsMm={rowHeightsMm} />
          </div>
            }
          >
          <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-sm font-medium" data-testid="scan-summary">
              {colWidthsMm.length}列 × {rowHeightsMm.length}行を検出しました（表の大きさ 幅{round1(totalW)}mm × 高さ{round1(totalH)}mm
              {Math.abs(scan.angleDeg) >= 0.1 ? `、傾き${scan.angleDeg}度を補正` : ""}）
            </p>
            {scan.pageCount > 1 && (
              <div className="flex items-end gap-2">
                <label className="flex w-32 flex-col gap-1 text-sm">
                  <span className="text-neutral-600 dark:text-neutral-300">読み取るページ</span>
                  <input
                    type="number"
                    aria-label="読み取るページ"
                    min={1}
                    max={scan.pageCount}
                    value={pageNumber}
                    onChange={(e) => setPageNumber(e.target.valueAsNumber)}
                    className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </label>
                <span className="pb-2 text-xs text-neutral-500">/ {scan.pageCount}ページ</span>
                <button
                  type="button"
                  onClick={() => file && void analyze(file, pageNumber)}
                  className="rounded-lg bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
                >
                  このページで読み取り直す
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div>
              <p className="mb-2 text-sm font-medium">列の幅（mm）— ずれていたら直せます</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {colWidthsMm.map((w, i) => (
                  <NumberCell key={i} label={`列${i + 1}の幅`} value={w} onChange={(v) => edit(setColWidthsMm, i, v)} />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">行の高さ（mm）</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {rowHeightsMm.map((h, i) => (
                  <NumberCell key={i} label={`行${i + 1}の高さ`} value={h} onChange={(v) => edit(setRowHeightsMm, i, v)} />
                ))}
              </div>
            </div>
          </div>

          {validation && <ErrorMessage message={validation} />}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={status === "processing" || !!validation}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            枠のExcelを作成
          </button>
          <ProcessingStatus state={status} successLabel="作成しました" />
          {error && <ErrorMessage message={error} />}
          {result && (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
              <RewardedDownloadGate onDownload={() => downloadBlob(result, buildScanGridFileName())} label="Excelファイルをダウンロード" />
            </div>
          )}
          </PreviewSplitLayout>
      )}
    </div>
  );
}
