"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ParagraphCompare,
  ParagraphLegend,
  SpaceLegend,
  type ParagraphItem,
} from "@/components/tools/implementations/shared/paragraph-compare";
import { PreviewNotice, PreviewShell } from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { loadDocxPackage } from "@/lib/word/docx-text-ops";
import {
  WordParagraphCleanupProcessor,
  previewParagraphCleanup,
  type ParagraphCleanupOptions,
} from "@/lib/processors/browser/word-paragraph-cleanup";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import {
  COLUMN_SPACE_MAX_MM,
  COLUMN_SPACE_MIN_MM,
  DEFAULT_COLUMN_SPACE_MM,
  type ColumnCount,
  type ColumnSettings,
} from "@/lib/word/columns";
import { RunBar } from "@/components/ui/run-bar";

/** 段区切りの段落番号の入力（「3, 8」など）を番号の並びにする。読めないときは null */
function parseBreakList(text: string): number[] | null {
  const parts = text.split(/[,、，\s]+/).map((t) => t.trim()).filter(Boolean);
  const nums = parts.map((t) => Number(t.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))));
  return nums.every((n) => Number.isInteger(n) && n >= 1) ? nums : null;
}

const ACCEPT = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const OPTION_ITEMS: { key: keyof ParagraphCleanupOptions; label: string }[] = [
  { key: "fullToHalfSpace", label: "全角スペースを半角に変換" },
  { key: "halfToFullSpace", label: "半角スペースを全角に変換" },
  { key: "collapseRepeatedSpaces", label: "連続するスペースを1つにまとめる" },
  { key: "collapseConsecutiveBlankLines", label: "連続する空白行を1行にまとめる" },
  { key: "removeBlankLines", label: "空白行をすべて削除する" },
];

/** 整理をしない設定（段落の一覧を作るときに使う） */
const DEFAULT_OFF: ParagraphCleanupOptions = {
  fullToHalfSpace: false,
  halfToFullSpace: false,
  collapseRepeatedSpaces: false,
  collapseConsecutiveBlankLines: false,
  removeBlankLines: false,
};

const DEFAULT_OPTIONS: ParagraphCleanupOptions = {
  fullToHalfSpace: false,
  halfToFullSpace: false,
  collapseRepeatedSpaces: true,
  collapseConsecutiveBlankLines: true,
  removeBlankLines: false,
};

/**
 * Word段落整理・段組み（工程3で段組みの変更を追加）。
 * 段落の整理（スペース・空白行）と、段組み（1・2・3段、段の間隔、段区切り。文書全体または選んだ段落の範囲）を、
 * それぞれ単独でも、組み合わせても行える。変更するのは word/document.xml だけ（src/lib/word/docx-text-ops.ts）。
 */
export function WordParagraphCleanupTool() {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<ParagraphCleanupOptions>(DEFAULT_OPTIONS);
  // 段組み
  const [columnsEnabled, setColumnsEnabled] = useState(false);
  const [columnCount, setColumnCount] = useState<ColumnCount>(2);
  const [columnSpaceText, setColumnSpaceText] = useState(String(DEFAULT_COLUMN_SPACE_MM));
  const [columnScope, setColumnScope] = useState<"all" | "range">("all");
  const [rangeStartText, setRangeStartText] = useState("1");
  const [rangeEndText, setRangeEndText] = useState("1");
  const [breakText, setBreakText] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    beforeText: string;
    afterText: string;
    removedParagraphCount: number;
    columns: { sectionsChanged: number; columnBreaksInserted: number } | null;
    cleaned: boolean;
  } | null>(null);

  // プレビュー: 出力と同じ整理処理(applyParagraphCleanup)を、読み込んだdocument.xmlに適用して段落を並べる
  const { data: pkg, error: previewError, loading } = useAsyncFileData(file, loadDocxPackage);
  const preview = useMemo(() => {
    if (!pkg) return null;
    try {
      const result = previewParagraphCleanup(pkg.documentXmlText, options);
      const before: ParagraphItem[] = result.paragraphs.map((p) => ({
        text: p.before,
        removed: p.after === null,
        changed: p.after !== null && p.after !== p.before,
      }));
      const after: ParagraphItem[] = result.paragraphs
        .filter((p) => p.after !== null)
        .map((p) => ({ text: p.after as string, changed: p.after !== p.before }));
      return { error: null as string | null, before, after, removed: result.removedParagraphCount };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "プレビューを作成できませんでした", before: [], after: [], removed: 0 };
    }
  }, [pkg, options]);

  // 段落の一覧（段組みの範囲・段区切りの番号は、この一覧の番号＝整理の前の段落の番号で指定する）
  const paragraphTexts = useMemo(() => {
    if (!pkg) return null;
    try {
      return previewParagraphCleanup(pkg.documentXmlText, DEFAULT_OFF).paragraphs.map((p) => p.before);
    } catch {
      return null;
    }
  }, [pkg]);
  const paragraphCount = paragraphTexts?.length ?? 0;

  // 段組みの設定（入力が正しくないときは、その理由）
  const columnSettings = useMemo((): { settings: ColumnSettings | null; error: string | null } => {
    if (!columnsEnabled) return { settings: null, error: null };
    const spaceMm = Number(columnSpaceText);
    if (columnSpaceText.trim() === "" || !Number.isFinite(spaceMm) || spaceMm < COLUMN_SPACE_MIN_MM || spaceMm > COLUMN_SPACE_MAX_MM) {
      return { settings: null, error: `段の間隔は${COLUMN_SPACE_MIN_MM}〜${COLUMN_SPACE_MAX_MM}mmの範囲で入力してください。` };
    }
    const breaks = breakText.trim() === "" ? [] : parseBreakList(breakText);
    if (breaks === null) return { settings: null, error: "段区切りを入れる段落の番号は、「3, 8」のように数字をカンマで区切って入力してください。" };
    if (breaks.some((n) => n > paragraphCount)) return { settings: null, error: `段区切りの段落の番号は、1〜${paragraphCount}の間で入力してください。` };
    if (columnScope === "all") return { settings: { count: columnCount, spaceMm, scope: "all", columnBreaks: breaks }, error: null };
    const start = Number(rangeStartText);
    const end = Number(rangeEndText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > paragraphCount || start > end) {
      return { settings: null, error: `段組みにする範囲は、1〜${paragraphCount}段落の間で、開始が終了以下になるように入力してください。` };
    }
    if (breaks.some((n) => n < start || n > end)) return { settings: null, error: `段区切りは、段組みにする範囲（${start}〜${end}段落）の中の段落に入れてください。` };
    return { settings: { count: columnCount, spaceMm, scope: "range", rangeStart: start, rangeEnd: end, columnBreaks: breaks }, error: null };
  }, [columnsEnabled, columnSpaceText, breakText, paragraphCount, columnScope, columnCount, rangeStartText, rangeEndText]);
  const rangeHighlight =
    columnsEnabled && columnScope === "range" ? { start: Number(rangeStartText), end: Number(rangeEndText) } : null;
  const breakSet = new Set(columnsEnabled ? (parseBreakList(breakText) ?? []) : []);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setRangeStartText("1");
    setRangeEndText("1");
    setBreakText("");
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function toggleOption(key: keyof ParagraphCleanupOptions) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const hasAnyOption = Object.values(options).some(Boolean);
  const canRun = (hasAnyOption || columnsEnabled) && columnSettings.error === null;
  const runLabel = columnsEnabled ? (hasAnyOption ? "整理と段組みの変更を実行する" : "段組みを変更する") : "整理を実行する";

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new WordParagraphCleanupProcessor().process({ file, options, columns: columnSettings.settings });
      setResult({ ...output, cleaned: hasAnyOption });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-${result.cleaned ? "cleaned" : "columns"}.docx`);
  }

  /** 新工程1：段組みだけを変えたいとき（整理のチェックをすべて外し、段組みの設定を開く） */
  function chooseColumnsOnly() {
    setOptions((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, false])) as unknown as ParagraphCleanupOptions);
    setColumnsEnabled(true);
    setResult(null);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 新工程1：段組み（2段・3段）がこのツールにあることを、最初に分かるようにする */}
      <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="word-tool-guide">
        スペース・空白行の整理と、段組みの変更（1段・2段・3段）ができます。
      </p>
      <FileDropzone
        compact={!!file}
        accept={ACCEPT}
        maxSizeMB={50}
        label="Wordファイル（.docx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-2">
          {/* 整理すること（いくつでも選べる）。オン・オフのチップで選ぶ（チェックボックスと同じ扱い） */}
          <p id="word-cleanup-options-label" className="text-sm font-medium text-ms-text">
            整理すること<span className="ml-1 text-xs font-normal text-ms-muted">（いくつでも選べます）</span>
          </p>
          <div role="group" aria-labelledby="word-cleanup-options-label" className="ms-toggle-chips">
            {OPTION_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="checkbox"
                aria-checked={options[item.key]}
                onClick={() => toggleOption(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="word-columns">
          <label className="flex items-center gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
            <input
              type="checkbox"
              checked={columnsEnabled}
              onChange={(e) => {
                setColumnsEnabled(e.target.checked);
                setResult(null);
              }}
              data-testid="word-columns-enable"
            />
            段組みを変更する（1段・2段・3段）
          </label>
          {(!columnsEnabled || hasAnyOption) && (
            <button
              type="button"
              data-testid="word-columns-only"
              onClick={chooseColumnsOnly}
              className="w-fit rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
            >
              整理はせずに、段組みだけを変更する
            </button>
          )}
          {columnsEnabled && (
            <div className="flex flex-col gap-3 text-sm text-neutral-600 dark:text-neutral-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ms-muted">段数</span>
                <div role="radiogroup" aria-label="段組みの数" className="ms-seg ms-seg-sm">
                {([1, 2, 3] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={columnCount === n}
                    data-testid={`word-columns-count-${n}`}
                    onClick={() => {
                      setColumnCount(n);
                      setResult(null);
                    }}
                  >
                    {n}段
                  </button>
                ))}
                </div>
              </div>
              <label className="flex flex-wrap items-center gap-2">
                段の間隔
                <input
                  type="number"
                  min={COLUMN_SPACE_MIN_MM}
                  max={COLUMN_SPACE_MAX_MM}
                  step={0.1}
                  value={columnSpaceText}
                  aria-label="段の間隔（mm）"
                  onChange={(e) => {
                    setColumnSpaceText(e.target.value);
                    setResult(null);
                  }}
                  className="w-24 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
                mm
                <span className="text-xs text-neutral-500 dark:text-neutral-400">（段の幅はすべて同じになります）</span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ms-muted">範囲</span>
                <div role="radiogroup" aria-label="段組みにする範囲" className="ms-seg ms-seg-sm">
                {(
                  [
                    { v: "all", label: "文書全体" },
                    { v: "range", label: "選んだ段落の範囲" },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    role="radio"
                    aria-checked={columnScope === o.v}
                    data-testid={`word-columns-scope-${o.v}`}
                    onClick={() => {
                      setColumnScope(o.v);
                      setResult(null);
                    }}
                  >
                    {o.label}
                  </button>
                ))}
                </div>
              </div>
              {columnScope === "range" && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      max={paragraphCount}
                      value={rangeStartText}
                      aria-label="段組みにする範囲の最初の段落"
                      onChange={(e) => {
                        setRangeStartText(e.target.value);
                        setResult(null);
                      }}
                      className="w-20 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    段落目から
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      max={paragraphCount}
                      value={rangeEndText}
                      aria-label="段組みにする範囲の最後の段落"
                      onChange={(e) => {
                        setRangeEndText(e.target.value);
                        setResult(null);
                      }}
                      className="w-20 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    段落目まで
                  </label>
                  <span className="basis-full text-xs text-neutral-500 dark:text-neutral-400">
                    範囲の前後に「セクション区切り（現在の位置から）」を入れて、範囲だけを段組みにします（Wordで文字列を選んで段組みを設定したときと同じ形です）。
                  </span>
                </div>
              )}
              <label className="flex flex-wrap items-center gap-2">
                段区切りを入れる段落
                <input
                  type="text"
                  value={breakText}
                  placeholder="例：5, 9（空欄なら入れません）"
                  aria-label="段区切りを入れる段落の番号"
                  onChange={(e) => {
                    setBreakText(e.target.value);
                    setResult(null);
                  }}
                  className="w-56 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <span className="basis-full text-xs text-neutral-500 dark:text-neutral-400">
                  指定した段落から次の段に送ります（Wordの「段区切り」）。番号は下の一覧の番号です。
                </span>
              </label>
              {columnSettings.error && (
                <p className="text-xs text-red-600 dark:text-red-400" data-testid="word-columns-error">
                  {columnSettings.error}
                </p>
              )}
              {paragraphTexts && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    段落の一覧（本文の段落。表の中の段落は含みません）{rangeHighlight ? "：青い段落が段組みにする範囲です" : ""}
                  </p>
                  <ol
                    aria-label="段落の一覧"
                    data-testid="word-paragraph-numbers"
                    className="flex max-h-64 flex-col gap-0.5 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    {paragraphTexts.slice(0, 500).map((text, i) => {
                      const n = i + 1;
                      const inRange = rangeHighlight !== null && n >= rangeHighlight.start && n <= rangeHighlight.end;
                      return (
                        <li
                          key={i}
                          data-in-range={inRange || undefined}
                          className={`flex gap-2 rounded px-1.5 py-0.5 ${inRange ? "bg-blue-100 dark:bg-blue-900/40" : ""}`}
                        >
                          <span className="w-8 shrink-0 text-right text-neutral-400">{n}</span>
                          <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-200">
                            {breakSet.has(n) && <span className="mr-1 rounded bg-amber-200 px-1 text-amber-900">段区切り</span>}
                            {text.trim() === "" ? <span className="italic text-neutral-400">(空白行)</span> : text}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                  {paragraphTexts.length > 500 && (
                    <p className="text-xs text-neutral-400 dark:text-neutral-500">先頭500段落のみ表示（全{paragraphTexts.length}段落）</p>
                  )}
                </div>
              )}
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                変えるのは段組みの設定だけです（本文・表・画像は変えません。見え方はWordなどが決めます）。
                段組みだけを変えたいときは、上の「整理すること」をすべて外してください。
              </p>
            </div>
          )}
        </div>
      )}

      {file && (preview || previewError || loading) && (
        <PreviewShell
          title="整理後の文章プレビュー(選択に合わせて更新されます)"
          loading={loading}
          summary={preview && !preview.error && <span>削除される空白行: {preview.removed}行</span>}
          notes={["本文直下の段落のテキストを表示しています(表の中の文字は整形のみ反映され、ここには表示されません)。"]}
        >
          {previewError && <PreviewNotice message={previewError} />}
          {preview?.error && <PreviewNotice message={preview.error} />}
          {preview && !preview.error && (
            <>
              <ParagraphCompare before={preview.before} after={preview.after} beforeLabel="整理前" afterLabel="整理後" />
              <ParagraphLegend items={[{ kind: "changed", label: "文字が変わる段落" }, { kind: "removed", label: "削除される空白行" }]} />
              <SpaceLegend />
            </>
          )}
        </PreviewShell>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing" || !canRun} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {runLabel}
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel={columnsEnabled && !hasAnyOption ? "段組みの変更が完了しました" : "整理が完了しました"} />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除した空白行: {result.removedParagraphCount}行
            {result.columns &&
              ` ・ 段組みを変更したセクション: ${result.columns.sectionsChanged}か所${
                result.columns.columnBreaksInserted > 0 ? ` ・ 入れた段区切り: ${result.columns.columnBreaksInserted}か所` : ""
              }`}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">変更前</p>
              <textarea
                value={result.beforeText}
                readOnly
                rows={10}
                className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">変更後</p>
              <textarea
                value={result.afterText}
                readOnly
                rows={10}
                className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
          </div>
          <div>
            <RewardedDownloadGate onDownload={handleDownload} label="Wordファイルをダウンロード" />
          </div>
        </div>
      )}
    </div>
  );
}
