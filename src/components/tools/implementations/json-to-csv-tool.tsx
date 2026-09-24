"use client";

import { useState } from "react";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { JsonToCsvProcessor, type JsonToCsvOutput } from "@/lib/processors/browser/csv-json";
import { downloadBlob } from "@/lib/utils/format";

const PLACEHOLDER = `[
  {"name": "田中", "age": 20},
  {"name": "佐藤", "age": 25}
]`;

export function JsonToCsvTool() {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JsonToCsvOutput | null>(null);

  async function handleRun() {
    if (status === "processing") return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new JsonToCsvProcessor().process({ text: input });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "変換に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.csvText);
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        入力 (JSON配列)
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={10}
          placeholder={PLACEHOLDER}
          className="rounded-xl border border-neutral-300 px-4 py-3 font-mono text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <button
        type="button"
        onClick={handleRun}
        disabled={!input.trim() || status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        CSVに変換する
      </button>

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            変換結果（{result.rowCount}行 × {result.columnCount}列）
            <textarea
              value={result.csvText}
              readOnly
              rows={10}
              className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 font-mono text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              コピー
            </button>
            <RewardedDownloadGate
              label=".csvをダウンロード"
              onDownload={() => downloadBlob(result.blob, "output.csv")}
            />
          </div>
        </div>
      )}
    </div>
  );
}
