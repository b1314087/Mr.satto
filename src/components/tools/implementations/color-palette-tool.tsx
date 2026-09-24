"use client";

import { useState } from "react";
import { ColorPaletteProcessor, type ColorPaletteInput } from "@/lib/processors/browser/color";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";

const MODES: { value: ColorPaletteInput["mode"]; label: string }[] = [
  { value: "monochromatic", label: "モノクロマティック" },
  { value: "complementary", label: "補色" },
  { value: "analogous", label: "類似色" },
  { value: "triadic", label: "トライアド" },
];

export function ColorPaletteTool() {
  const [baseColor, setBaseColor] = useState("#2563eb");
  const [mode, setMode] = useState<ColorPaletteInput["mode"]>("monochromatic");
  const [colors, setColors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");

  async function generate(nextMode = mode, nextColor = baseColor) {
    if (status === "processing") return;
    setStatus("processing");
    setError(null);
    try {
      const result = await new ColorPaletteProcessor().process({
        baseColorHex: nextColor,
        mode: nextMode,
      });
      setColors(result.colors);
      setStatus("success");
    } catch (e) {
      setColors([]);
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy(hex: string) {
    await navigator.clipboard.writeText(hex);
    setCopied(hex);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          ベースカラー
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={baseColor}
              onChange={(e) => {
                setBaseColor(e.target.value);
              }}
              className="h-10 w-14 cursor-pointer rounded-md border border-neutral-300 dark:border-neutral-700"
            />
            <input
              value={baseColor}
              onChange={(e) => setBaseColor(e.target.value)}
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          配色パターン
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ColorPaletteInput["mode"])}
            className="rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => generate()}
          disabled={status === "processing"}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "processing" ? "生成中..." : "パレットを生成する"}
        </button>
      </div>

      <ProcessingStatus state={status} processingLabel="生成中..." successLabel="パレットを生成しました" />
      {error && <ErrorMessage message={error} />}

      {colors.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {colors.map((hex, i) => (
            <button
              key={`${hex}-${i}`}
              type="button"
              onClick={() => handleCopy(hex)}
              className="flex w-28 flex-col items-center gap-2 rounded-xl border border-neutral-200 p-2 text-xs dark:border-neutral-800"
            >
              <span
                className="h-16 w-full rounded-lg border border-black/5"
                style={{ backgroundColor: hex }}
              />
              <span className="font-mono text-neutral-600 dark:text-neutral-300">
                {copied === hex ? "コピーしました" : hex}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
