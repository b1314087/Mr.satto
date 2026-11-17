"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { RunBar } from "@/components/ui/run-bar";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import type { OfficeKind, OfficeResetResult } from "@/lib/office-reset/ooxml-reset";

/**
 * Excel・Word・PowerPoint の「書式」と「ページ・印刷の設定」を標準に戻すツール（2026-11-17）。
 * 中身（文字・数値・数式・表・画像など）は残す。処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

const MAX_MB = 50;

const TEXT: Record<
  OfficeKind,
  { accept: string; label: string; intro: string; format: string; formatHint: string; page: string; pageHint: string; mime: string; download: string }
> = {
  xlsx: {
    accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excelファイル(.xlsx)をドラッグ&ドロップ",
    intro: "Excelファイルの書式と、ページ・印刷の設定を、新しく作ったときと同じ標準の状態に戻します。セルの値・数式・結合・グラフなどの中身はそのまま残します。",
    format: "書式を標準に戻す",
    formatHint: "フォント・文字の大きさ・色・太字・塗りつぶし・罫線・配置（游ゴシック 11pt・罫線なしに）。数値の表示形式（日付・金額など）は残します",
    page: "ページ・印刷の設定を標準に戻す",
    pageHint: "用紙の大きさ・向き・余白・拡大縮小・印刷範囲・ヘッダー/フッター・改ページ・列の幅・行の高さ・表示の拡大率",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    download: "Excelファイル(.xlsx)をダウンロード",
  },
  docx: {
    accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word文書(.docx)をドラッグ&ドロップ",
    intro: "Word文書の書式と、ページの設定を、新しく作ったときと同じ標準の状態に戻します。文章・見出し・箇条書き・表・画像などの中身はそのまま残します。",
    format: "書式を標準に戻す",
    formatHint: "文字（フォント・大きさ・色・太字など）・段落（配置・字下げ・行の間隔）・スタイル・表の罫線と塗りつぶし（10.5pt・標準のスタイルに）。見出しと箇条書きの区別は残します",
    page: "ページの設定を標準に戻す",
    pageHint: "用紙A4・縦向き・余白「標準」（上35mm・下左右30mm）・1段組み・ページの罫線・行数（文字グリッド）",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    download: "Word文書(.docx)をダウンロード",
  },
  pptx: {
    accept: ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PowerPointファイル(.pptx)をドラッグ&ドロップ",
    intro: "PowerPointの書式と、スライドのサイズを標準の状態に戻します。スライドの文字・画像・グラフ・ノート・アニメーションなどの中身はそのまま残します。",
    format: "書式を標準に戻す",
    formatHint: "文字（フォント・大きさ・色・太字など）・段落（配置・行の間隔・箇条書き）・タイトルや本文の枠の色・表のセルの色・スライドごとの背景を、レイアウトとテーマの標準に",
    page: "スライドのサイズを標準に戻す",
    pageHint: "ワイド画面（16:9）に。図形・画像は、縦横の比を保ったまま収まるように調整します",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    download: "PowerPointファイル(.pptx)をダウンロード",
  },
};

export function OfficeResetTool({ kind }: { kind: OfficeKind }) {
  const t = TEXT[kind];
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState(true);
  const [page, setPage] = useState(true);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OfficeResetResult | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0] ?? null);
    setStatus("idle");
    setError(null);
    setResult(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const { resetOfficeFile, OfficeResetError } = await import("@/lib/office-reset/ooxml-reset");
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 画面の「処理しています」を先に表示してから、重い処理を始める
      await new Promise((r) => setTimeout(r, 30));
      try {
        setResult(resetOfficeFile(bytes, kind, { format, page }));
        setStatus("success");
      } catch (e) {
        setError(e instanceof OfficeResetError ? e.message : "ファイルを読み取れませんでした。ファイルが壊れているか、対応していない形式の可能性があります。");
        setStatus("error");
      }
    } catch {
      setError("処理の準備に失敗しました。ページを読み込み直してから、もう一度お試しください。");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    const blob = new Blob([result.bytes as BlobPart], { type: t.mime });
    downloadBlob(blob, `${stripExtension(file.name)}_標準.${kind}`);
  }

  return (
    <div className="flex flex-col gap-6" data-testid={`office-reset-${kind}-tool`}>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{t.intro}</p>

      <FileDropzone
        compact={!!file}
        accept={t.accept}
        maxSizeMB={MAX_MB}
        label={t.label}
        hint={`またはタップして選択（上限${MAX_MB}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => handleSelect([])} />}

      {file && (
        <fieldset className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <legend className="px-1 text-xs font-semibold text-neutral-600 dark:text-neutral-300">標準に戻すもの</legend>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={format} onChange={(e) => setFormat(e.target.checked)} data-testid="office-reset-format" />
            <span>
              <span className="font-semibold">{t.format}</span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t.formatHint}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={page} onChange={(e) => setPage(e.target.checked)} data-testid="office-reset-page" />
            <span>
              <span className="font-semibold">{t.page}</span>
              <span className="block text-xs text-neutral-500 dark:text-neutral-400">{t.pageHint}</span>
            </span>
          </label>
        </fieldset>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || (!format && !page)}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            data-testid="office-reset-run"
          >
            標準に戻す
          </button>
          {!format && !page && <span className="text-xs text-red-600">標準に戻すものを、1つ以上選んでください。</span>}
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel="標準に戻しています…" successLabel="標準に戻したファイルができました" />
      {error && <ErrorMessage message={error} testId="office-reset-error" />}

      {result && (
        <ResultPopup>
          <div className="flex flex-col gap-3 text-xs" data-testid="office-reset-result">
            <div>
              <p className="mb-1 font-semibold text-neutral-700 dark:text-neutral-200">標準に戻したもの</p>
              <ul className="list-disc space-y-0.5 pl-5 text-neutral-600 dark:text-neutral-300">
                {result.done.map((d) => (
                  <li key={d} data-testid="office-reset-done">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 font-semibold text-neutral-700 dark:text-neutral-200">そのまま残したもの</p>
              <p className="text-neutral-600 dark:text-neutral-300" data-testid="office-reset-kept">
                {result.kept.join("・")}
              </p>
            </div>
            {result.notes.length > 0 && (
              <ul className="list-disc space-y-0.5 rounded-lg border border-amber-200 bg-amber-50 p-2 pl-6 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <RewardedDownloadGate onDownload={handleDownload} label={t.download} />
          </div>
        </ResultPopup>
      )}
    </div>
  );
}
