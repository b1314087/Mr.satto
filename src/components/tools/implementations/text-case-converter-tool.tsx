"use client";

import { useEffect, useState } from "react";
import { TextCaseConvertProcessor, type TextCaseMode } from "@/lib/processors/browser/text";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob } from "@/lib/utils/format";

const MODE_OPTIONS: { value: TextCaseMode; label: string; hint: string }[] = [
  { value: "upper", label: "すべて大文字", hint: "ABC" },
  { value: "lower", label: "すべて小文字", hint: "abc" },
  { value: "title", label: "単語の先頭を大文字", hint: "Hello World" },
  { value: "sentence", label: "文の先頭を大文字", hint: "Hello world. Next." },
];

/**
 * テキスト大文字・小文字変換（Phase 8）。
 * 入力するたびに即座に変換結果を表示する（char-count-toolと同じ「都度実行」方式）。
 * 日本語（ひらがな・カタカナ・漢字）はアルファベットではないため、
 * どのモードでも変換されずそのまま残る。
 */
export function TextCaseConverterTool() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<TextCaseMode>("upper");
  const [output, setOutput] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    new TextCaseConvertProcessor().process({ text: input, mode }).then((r) => {
      if (!cancelled) setOutput(r.result);
    });
    return () => {
      cancelled = true;
    };
  }, [input, mode]);

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境ではコピーをスキップし、テキストエリアからの
      // 手動選択に任せる（このツールでは他にエラー表示すべき処理が無いため無視する）
    }
  }

  function handleDownload() {
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, "converted.txt");
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        入力テキスト
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={8}
          placeholder="変換したい文章を入力または貼り付けてください"
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

      <label className="flex flex-col gap-1.5 text-sm">
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
        {output && (
          <RewardedDownloadGate onDownload={handleDownload} label=".txtをダウンロード" />
        )}
      </div>
    </div>
  );
}
