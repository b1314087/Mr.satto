"use client";

import { useState } from "react";
import { CsvFormatProcessor } from "@/lib/processors/browser/text";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob } from "@/lib/utils/format";

export function CsvFormatTool() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [trimCells, setTrimCells] = useState(true);
  const [removeEmptyLines, setRemoveEmptyLines] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");

  async function handleFormat() {
    if (status === "processing") return;
    setStatus("processing");
    setError(null);
    try {
      const result = await new CsvFormatProcessor().process({ text: input, trimCells, removeEmptyLines });
      setOutput(result.formatted);
      setRowCount(result.rowCount);
      setStatus("success");
    } catch (e) {
      setOutput("");
      setError(e instanceof Error ? e.message : "整形に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    const blob = new Blob([output], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, "formatted.csv");
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        CSVの内容を貼り付け
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={10}
          placeholder={"name, age,  city\nAlice ,30, Tokyo\n\nBob,25,Osaka"}
          className="rounded-xl border border-neutral-300 px-4 py-3 font-mono text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={trimCells} onChange={(e) => setTrimCells(e.target.checked)} />
          各セルの前後の空白を除去
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={removeEmptyLines}
            onChange={(e) => setRemoveEmptyLines(e.target.checked)}
          />
          空行を削除
        </label>
      </div>

      <button
        type="button"
        onClick={handleFormat}
        disabled={!input.trim() || status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {status === "processing" ? "処理中..." : "整形する"}
      </button>

      <ProcessingStatus state={status} processingLabel="処理中..." successLabel="整形が完了しました" />
      {error && <ErrorMessage message={error} />}

      {output && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{rowCount}行</p>
          <textarea
            value={output}
            readOnly
            rows={10}
            className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
          />
          <RewardedDownloadGate onDownload={handleDownload} label="CSVとしてダウンロード" />
        </div>
      )}
    </div>
  );
}
