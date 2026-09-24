"use client";

import { useState } from "react";
import {
  TextLineCleanerProcessor,
  type TextLineSort,
} from "@/lib/processors/browser/text";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob } from "@/lib/utils/format";

const SORT_OPTIONS: { value: TextLineSort; label: string }[] = [
  { value: "none", label: "並び替えない" },
  { value: "asc", label: "昇順ソート" },
  { value: "desc", label: "降順ソート" },
];

export function TextLineCleanerTool() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [removeEmptyLines, setRemoveEmptyLines] = useState(true);
  const [trimLines, setTrimLines] = useState(true);
  const [collapseSpaces, setCollapseSpaces] = useState(false);
  const [dedupeLines, setDedupeLines] = useState(false);
  const [sort, setSort] = useState<TextLineSort>("none");
  const [counts, setCounts] = useState<{ before: number; after: number } | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (status === "processing") return;
    setStatus("processing");
    setError(null);
    try {
      const result = await new TextLineCleanerProcessor().process({
        text: input,
        removeEmptyLines,
        trimLines,
        collapseSpaces,
        dedupeLines,
        sort,
      });
      setOutput(result.result);
      setCounts({ before: result.lineCountBefore, after: result.lineCountAfter });
      setStatus("success");
    } catch (e) {
      setOutput("");
      setCounts(null);
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy() {
    if (!output) return;
    await navigator.clipboard.writeText(output);
  }

  function handleDownload() {
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, "cleaned.txt");
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        入力テキスト
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={10}
          placeholder={"整理したいテキストを貼り付けてください\n（1行に1項目）"}
          className="rounded-xl border border-neutral-300 px-4 py-3 font-mono text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={removeEmptyLines}
            onChange={(e) => setRemoveEmptyLines(e.target.checked)}
          />
          空行を削除する
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={trimLines}
            onChange={(e) => setTrimLines(e.target.checked)}
          />
          各行の先頭・末尾の空白を削除する
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={collapseSpaces}
            onChange={(e) => setCollapseSpaces(e.target.checked)}
          />
          連続するスペースを1つにまとめる
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={dedupeLines}
            onChange={(e) => setDedupeLines(e.target.checked)}
          />
          重複した行を削除する
        </label>

        <div className="flex flex-col gap-1.5 pt-1 text-sm text-neutral-600 dark:text-neutral-300">
          並び替え
          <div className="flex flex-wrap gap-2">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSort(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  sort === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={handleRun}
        disabled={!input.trim() || status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        整理する
      </button>

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {counts && (
        <label className="flex flex-col gap-1.5 text-sm">
          結果（{counts.before}行 → {counts.after}行）
          <textarea
            value={output}
            readOnly
            rows={10}
            className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 font-mono text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      )}

      {counts && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            コピー
          </button>
          <RewardedDownloadGate onDownload={handleDownload} label=".txtをダウンロード" />
        </div>
      )}
    </div>
  );
}
