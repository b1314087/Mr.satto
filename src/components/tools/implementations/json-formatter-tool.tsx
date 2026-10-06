"use client";

import { useMemo, useState } from "react";
import { JsonFormatProcessor, formatJsonText } from "@/lib/processors/browser/text";
import {
  PreviewColumn,
  PreviewColumns,
  PreviewNotice,
  PreviewShell,
  PreviewText,
} from "@/components/tools/implementations/shared/before-after-table";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";

export function JsonFormatterTool() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [indent, setIndent] = useState(2);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");

  // プレビュー: 出力と同じ formatJsonText で、入力・インデントに合わせてその場で整形/圧縮した結果を表示する
  const preview = useMemo(() => {
    if (!input.trim()) return null;
    try {
      return {
        formatted: formatJsonText(input, indent, false),
        minified: formatJsonText(input, indent, true),
        error: null as string | null,
      };
    } catch (e) {
      return { formatted: null, minified: null, error: e instanceof Error ? e.message : "整形できませんでした" };
    }
  }, [input, indent]);

  async function run(minify = false) {
    if (status === "processing") return;
    setStatus("processing");
    setError(null);
    try {
      const result = await new JsonFormatProcessor().process({ text: input, indent, minify });
      setOutput(result.formatted);
      setStatus("success");
    } catch (e) {
      setOutput("");
      setError(e instanceof Error ? e.message : "整形に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy() {
    if (!output) return;
    await navigator.clipboard.writeText(output);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          入力 (JSON)
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={14}
            placeholder='{"name": "example", "value": 1}'
            className="rounded-xl border border-neutral-300 px-4 py-3 font-mono text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          出力
          <textarea
            value={output}
            readOnly
            rows={14}
            placeholder="整形結果がここに表示されます"
            className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 font-mono text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          インデント
          <select
            value={indent}
            onChange={(e) => setIndent(Number(e.target.value))}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value={2}>2スペース</option>
            <option value={4}>4スペース</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => run(false)}
          disabled={status === "processing"}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "processing" ? "処理中..." : "整形する"}
        </button>
        <button
          type="button"
          onClick={() => run(true)}
          disabled={status === "processing"}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
        >
          圧縮(minify)する
        </button>
        {output && (
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            コピー
          </button>
        )}
      </div>

      {preview && (
        <PreviewShell
          title="整形のプレビュー(入力・インデントに合わせて更新されます)"
          summary={
            preview.formatted !== null && preview.minified !== null ? (
              <span>
                整形後 {preview.formatted.split("\n").length}行 ・ 圧縮すると{preview.minified.length}文字
              </span>
            ) : undefined
          }
        >
          {preview.error && <PreviewNotice message={preview.error} />}
          {preview.formatted !== null && preview.minified !== null && (
            <PreviewColumns>
              <PreviewColumn label="整形した場合">
                <PreviewText text={preview.formatted} maxLines={30} label="整形後のプレビュー" />
              </PreviewColumn>
              <PreviewColumn label="圧縮(minify)した場合">
                <PreviewText text={preview.minified.length > 600 ? `${preview.minified.slice(0, 600)}…` : preview.minified} maxLines={30} label="圧縮後のプレビュー" />
              </PreviewColumn>
            </PreviewColumns>
          )}
        </PreviewShell>
      )}

      <ProcessingStatus state={status} processingLabel="処理中..." successLabel="整形が完了しました" />
      {error && <ErrorMessage message={error} />}
    </div>
  );
}
