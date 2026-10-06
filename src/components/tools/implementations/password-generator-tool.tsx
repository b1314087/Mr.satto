"use client";

import { useEffect, useState } from "react";
import { PasswordGenerateProcessor } from "@/lib/processors/browser/password";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";

const STRENGTH_LABEL = ["とても弱い", "弱い", "普通", "強い", "とても強い"];
const STRENGTH_COLOR = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-green-500",
];

export function PasswordGeneratorTool() {
  const [length, setLength] = useState(16);
  const [useUppercase, setUseUppercase] = useState(true);
  const [useLowercase, setUseLowercase] = useState(true);
  const [useNumbers, setUseNumbers] = useState(true);
  const [useSymbols, setUseSymbols] = useState(true);

  const [password, setPassword] = useState("");
  const [strength, setStrength] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<ProcessingState>("idle");

  // 長さ・文字種を変えるたびに、その設定で自動的に新しいパスワードを生成して表示する（プレビュー）。
  // 「パスワードを生成する」ボタンは同じ設定で作り直す（別の候補を出す）操作。
  useEffect(() => {
    let cancelled = false;
    new PasswordGenerateProcessor()
      .process({ length, useUppercase, useLowercase, useNumbers, useSymbols })
      .then((result) => {
        if (cancelled) return;
        setPassword(result.password);
        setStrength(result.strength);
        setError(null);
        setCopied(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setPassword("");
        setError(e instanceof Error ? e.message : "生成に失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [length, useUppercase, useLowercase, useNumbers, useSymbols]);

  async function handleGenerate() {
    if (status === "processing") return;
    setStatus("processing");
    setError(null);
    setCopied(false);
    try {
      const result = await new PasswordGenerateProcessor().process({
        length,
        useUppercase,
        useLowercase,
        useNumbers,
        useSymbols,
      });
      setPassword(result.password);
      setStrength(result.strength);
      setStatus("success");
    } catch (e) {
      setPassword("");
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy() {
    if (!password) return;
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const checkboxes: { label: string; checked: boolean; setter: (v: boolean) => void }[] = [
    { label: "大文字 (A-Z)", checked: useUppercase, setter: setUseUppercase },
    { label: "小文字 (a-z)", checked: useLowercase, setter: setUseLowercase },
    { label: "数字 (0-9)", checked: useNumbers, setter: setUseNumbers },
    { label: "記号 (!@#$ など)", checked: useSymbols, setter: setUseSymbols },
  ];

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        文字数: {length}
        <input
          type="range"
          min={4}
          max={64}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
        />
      </label>

      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {checkboxes.map((c) => (
          <label key={c.label} className="flex items-center gap-2">
            <input type="checkbox" checked={c.checked} onChange={(e) => c.setter(e.target.checked)} />
            {c.label}
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {status === "processing" ? "生成中..." : "パスワードを生成する"}
      </button>

      <ProcessingStatus state={status} processingLabel="生成中..." successLabel="パスワードを生成しました" />
      {error && <ErrorMessage message={error} />}

      {password && (
        <div
          data-testid="tool-preview"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            プレビュー（設定を変えると自動で作り直されます）
          </p>
          <div className="flex items-center justify-between gap-3">
            <code className="break-all text-lg font-semibold text-neutral-800 dark:text-neutral-100">
              {password}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              {copied ? "コピーしました" : "コピー"}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-1.5 flex-1 gap-1">
              {STRENGTH_COLOR.map((color, i) => (
                <span
                  key={i}
                  className={`h-full flex-1 rounded-full ${
                    i <= strength ? color : "bg-neutral-200 dark:bg-neutral-700"
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              強度: {STRENGTH_LABEL[strength]}
            </span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {Array.from(password).length}文字 ／ 12文字以上・3種類以上の文字種で強度が上がります
          </p>
        </div>
      )}
    </div>
  );
}
