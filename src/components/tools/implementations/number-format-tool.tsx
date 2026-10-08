"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useState } from "react";
import { NumberFormatProcessor, type NumberFormatMode } from "@/lib/processors/browser/number-format";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob } from "@/lib/utils/format";

const MODE_OPTIONS: { value: NumberFormatMode; label: string; hint: string }[] = [
  { value: "zip", label: "郵便番号", hint: "6530824 → 653-0824" },
  { value: "phone", label: "電話番号", hint: "0786910561 → 078-691-0561" },
  { value: "custom", label: "カスタム区切り", hint: "任意の位置にハイフン等を挿入" },
  { value: "comma-add", label: "カンマを追加", hint: "1234567 → 1,234,567" },
  { value: "comma-remove", label: "カンマを削除", hint: "1,234,567 → 1234567" },
  { value: "digits-only", label: "数字のみ抽出", hint: "文字を除いた数字だけを残す" },
];

/**
 * 数字・番号フォーマットツール（次工程・軽量便利ツール一括追加 Tool 3）。
 * text-case-converter-tool と同じ「入力するたびに即時変換」方式。
 * カスタム区切りモードでは、区切り位置をユーザー自身が指定できることを優先する。
 */
export function NumberFormatTool() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<NumberFormatMode>("zip");
  const [customPattern, setCustomPattern] = useState("3-4-3");
  const [customDelimiter, setCustomDelimiter] = useState("-");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    new NumberFormatProcessor()
      .process({ mode, text: input, customPattern, customDelimiter })
      .then((r) => {
        if (cancelled) return;
        setOutput(r.result);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setOutput("");
        setError(e instanceof Error ? e.message : "変換に失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [input, mode, customPattern, customDelimiter]);

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボード非対応環境では何もしない
    }
  }

  function handleDownload() {
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, "formatted.txt");
  }

  return (
    <PreviewSplitLayout
      preview={
      <div className="flex flex-col gap-4">
      <label data-testid="tool-preview" className="flex flex-col gap-1.5 text-sm">
        変換結果
        <textarea
          value={output}
          readOnly
          rows={8}
          className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 text-sm outline-none dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleCopy}
          disabled={!output}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
        >
          {copied ? "コピーしました" : "コピー"}
        </button>
        {output && <RewardedDownloadGate onDownload={handleDownload} label=".txtをダウンロード" />}
      </div>
      </div>
      }
    >
      <label className="flex flex-col gap-1.5 text-sm">
        入力（1行に1件、複数行可）
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={8}
          placeholder={"6530824\n0786910561"}
          className="rounded-xl border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setMode(opt.value)}
            className={`flex flex-col items-start gap-0.5 rounded-lg border-2 px-3 py-2 text-left text-sm transition-colors ${
              mode === opt.value
                ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                : "border-neutral-200 text-neutral-600 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-300"
            }`}
          >
            <span className="font-medium">{opt.label}</span>
            <span className="text-xs text-neutral-400">{opt.hint}</span>
          </button>
        ))}
      </div>

      {mode === "custom" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            区切り位置のパターン（例: 3-4-3）
            <input
              type="text"
              value={customPattern}
              onChange={(e) => setCustomPattern(e.target.value)}
              placeholder="3-4-3"
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            区切り文字
            <input
              type="text"
              value={customDelimiter}
              onChange={(e) => setCustomDelimiter(e.target.value)}
              placeholder="-"
              maxLength={3}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </PreviewSplitLayout>
  );
}
