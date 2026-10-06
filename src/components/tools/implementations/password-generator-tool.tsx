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
  const [customChars, setCustomChars] = useState("");
  const customActive = Array.from(customChars.replace(/\s/g, "")).length > 0;

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
      .process({ length, useUppercase, useLowercase, useNumbers, useSymbols, customChars })
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
  }, [length, useUppercase, useLowercase, useNumbers, useSymbols, customChars]);

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
        customChars,
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

  const presets: { label: string; upper: boolean; lower: boolean; numbers: boolean; symbols: boolean }[] = [
    { label: "英字のみ", upper: true, lower: true, numbers: false, symbols: false },
    { label: "数字のみ", upper: false, lower: false, numbers: true, symbols: false },
    { label: "英数字のみ", upper: true, lower: true, numbers: true, symbols: false },
    { label: "すべて", upper: true, lower: true, numbers: true, symbols: true },
  ];

  function applyPreset(p: (typeof presets)[number]) {
    setCustomChars("");
    setUseUppercase(p.upper);
    setUseLowercase(p.lower);
    setUseNumbers(p.numbers);
    setUseSymbols(p.symbols);
  }

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

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">使う文字の種類</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">ワンタッチで選ぶ:</span>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className={`grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 ${customActive ? "opacity-40" : ""}`}>
          {checkboxes.map((c) => (
            <label key={c.label} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={c.checked}
                disabled={customActive}
                onChange={(e) => c.setter(e.target.checked)}
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">
          使う文字を自分で指定する（入力すると、この文字だけで作成します）
        </span>
        <input
          type="text"
          value={customChars}
          onChange={(e) => setCustomChars(e.target.value)}
          placeholder="例: abcdef0123456789"
          aria-label="使う文字を指定"
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {customActive
            ? `指定した文字（重複を除いて${Array.from(new Set(Array.from(customChars.replace(/\s/g, "")))).length}種類）だけを使います。上のチェックは無効になります。`
            : "空欄のときは、上で選んだ文字の種類から作成します。"}
        </span>
      </label>

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
