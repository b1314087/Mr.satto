"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { RunBar } from "@/components/ui/run-bar";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { ExcelToWordProcessor, readExcelWorkbookInfo, type ExcelToWordOutput, type ExcelWorkbookInfo } from "@/lib/office-convert/excel-to-word";
import { MAX_OFFICE_FILE_MB } from "@/lib/office-convert/file-check";
import { ConversionChecks } from "./office-convert-checks";

/**
 * Excel→Word変換。表は、Wordで編集できる表として書き出す。
 * 最優先：Wordの表・画像を、ページの印刷できる範囲からはみ出させない（src/lib/office-convert/excel-word-fit.ts）。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */
export function ExcelToWordTool() {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<ExcelWorkbookInfo | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [allowLandscape, setAllowLandscape] = useState(true);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExcelToWordOutput | null>(null);
  const [progress, setProgress] = useState("");
  const [preview, setPreview] = useState<{ state: "idle" | "loading" | "ready" | "error"; file?: File; message?: string }>({ state: "idle" });

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    readExcelWorkbookInfo(file)
      .then((i) => {
        if (cancelled) return;
        setInfo(i);
        setSelected(i.sheets.filter((s) => !s.hidden && !s.empty).map((s) => s.name));
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした");
        setFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  function handleSelect(files: File[]) {
    setFile(files[0] ?? null);
    setInfo(null);
    setSelected([]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setPreview({ state: "idle" });
  }

  function toggleSheet(name: string) {
    setSelected((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
  }

  async function handleRun() {
    if (!file || !info) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setPreview({ state: "idle" });
    try {
      const ordered = info.sheets.map((s) => s.name).filter((n) => selected.includes(n));
      const output = await new ExcelToWordProcessor().process({ file, sheetNames: ordered, allowAutoLandscape: allowLandscape, onProgress: setProgress });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "変換に失敗しました");
      setStatus("error");
    } finally {
      setProgress("");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}.docx`);
  }

  async function handlePreview() {
    if (!result) return;
    setPreview({ state: "loading" });
    try {
      // できあがったWord文書を、Word→PDF変換と同じ描き方でページにして見せる（Word本体の表示とは細部が違う場合があります）
      const { WordToPdfProcessor } = await import("@/lib/processors/browser/word-to-pdf");
      const docxFile = new File([result.blob], "preview.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      const pdf = await new WordToPdfProcessor().process({ file: docxFile });
      setPreview({ state: "ready", file: new File([pdf.blob], "preview.pdf", { type: "application/pdf" }) });
    } catch (e) {
      setPreview({ state: "error", message: e instanceof Error ? e.message : "プレビューを作れませんでした" });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        表はWordで編集できる表になります。用紙の大きさ・向き・余白はExcelの印刷設定を引き継ぎ、表がページからはみ出さないように列の幅を調整します。
      </p>

      <FileDropzone
        compact={!!file}
        // .xls も選べるようにして、選ばれたときに「.xlsxで保存し直す」案内を出す（変換はしない）
        accept=".xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12"
        maxSizeMB={MAX_OFFICE_FILE_MB}
        label="Excelファイル(.xlsx・.xlsm)をドラッグ&ドロップ"
        hint={`またはタップして選択（上限${MAX_OFFICE_FILE_MB}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => handleSelect([])} />}

      {file && !info && !error && <p className="text-xs text-neutral-400">シートを読み込んでいます…</p>}

      {info && (
        <section aria-label="変換するシート" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="excel-to-word-sheets">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変換するシート</p>
          <div className="flex flex-col gap-1.5">
            {info.sheets.map((s) => (
              <label key={s.name} className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                <input type="checkbox" checked={selected.includes(s.name)} disabled={s.empty} onChange={() => toggleSheet(s.name)} />
                <span>{s.name}</span>
                {s.hidden && <span className="text-xs text-neutral-400">（非表示のシート）</span>}
                {s.empty && <span className="text-xs text-neutral-400">（空のシート）</span>}
              </label>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={allowLandscape} onChange={(e) => setAllowLandscape(e.target.checked)} />
            <span>
              表が縦向きのページに収まらないときは、横向きのページにする
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">オフにすると、元の向きのまま列の幅を縮める・列の途中でページを分けることで収めます。</span>
            </span>
          </label>
        </section>
      )}

      {info && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || selected.length === 0}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            Wordに変換する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel={progress || "変換しています…"} successLabel="Word文書ができました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <div className="flex flex-col gap-3" data-testid="excel-to-word-result">
            <ul className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
              {result.sheets.map((s) => (
                <li key={s.name} data-testid="excel-to-word-sheet-report">
                  「{s.name}」：{s.paper}・{s.orientation === "landscape" ? "横" : "縦"}向き
                  {s.rotated ? "（収めるため横向きに変更）" : ""}・{s.rows.toLocaleString()}行×{s.cols}列
                  {s.columnPages > 1 ? `・列を${s.columnPages}ページに分割` : ""}
                  {s.shrinkPercent < 100 ? `・列の幅${s.shrinkPercent}%` : ""}
                  {s.images + s.charts > 0 ? `・画像${s.images}個・グラフ${s.charts}個` : ""}
                </li>
              ))}
            </ul>
            <ConversionChecks checks={result.checks} warnings={result.warnings} />
            <RewardedDownloadGate onDownload={handleDownload} label="Word文書をダウンロード" />
            <div className="flex flex-col gap-2">
              {preview.state !== "ready" && (
                <button type="button" onClick={handlePreview} disabled={preview.state === "loading"} className="w-fit text-xs text-blue-700 underline disabled:opacity-50 dark:text-blue-300">
                  {preview.state === "loading" ? "ページのプレビューを作っています…" : "ページのプレビューを見る"}
                </button>
              )}
              {preview.state === "error" && <p className="text-xs text-red-600">{preview.message}</p>}
              {preview.state === "ready" && preview.file && (
                <>
                  <PdfThumbnails file={preview.file} maxPages={6} width={150} title="ページのプレビュー（先頭の6ページまで）" />
                  <p className="text-[11px] text-neutral-500">プレビューはブラウザの中で作った簡易的な表示です。Wordで開いたときと、文字の幅などの細部が違う場合があります。</p>
                </>
              )}
            </div>
          </div>
        </ResultPopup>
      )}
    </div>
  );
}
