"use client";

import { useState } from "react";
import { SliderField } from "@/components/common/slider-field";
import {
  DEFAULT_GRADIENT,
  GRADIENT_PRESETS,
  MAX_STOPS,
  MIN_STOPS,
  addStop,
  gradientToCss,
  gradientToCssValue,
  isValidHexColor,
  paintGradient,
  randomGradient,
  reverseStops,
  type GradientSpec,
  type GradientStop,
  type GradientType,
} from "@/lib/gradient/gradient";
import { downloadBlob } from "@/lib/utils/format";

const TYPE_OPTIONS: { value: GradientType; label: string }[] = [
  { value: "linear", label: "線形(直線)" },
  { value: "radial", label: "円形(放射)" },
  { value: "conic", label: "円錐(角度)" },
];

const PNG_SIZES: { label: string; width: number; height: number }[] = [
  { label: "1920×1080(フルHD壁紙)", width: 1920, height: 1080 },
  { label: "3840×2160(4K壁紙)", width: 3840, height: 2160 },
  { label: "1080×1080(正方形・SNS)", width: 1080, height: 1080 },
  { label: "1200×630(OGP・ブログ)", width: 1200, height: 630 },
  { label: "1080×1920(スマホ縦)", width: 1080, height: 1920 },
];

/**
 * CSSグラデーション生成。色・位置・角度を変えるとプレビューとCSSコードが即座に変わる。
 * 同じ設定をPNG画像としても書き出せる(CSSと同じ定義から描画)。処理はすべてブラウザ内。
 */
export function GradientGeneratorTool() {
  const [spec, setSpec] = useState<GradientSpec>(DEFAULT_GRADIENT);
  const [pngSize, setPngSize] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cssValue = gradientToCssValue(spec);
  const cssText = gradientToCss(spec);

  function patch(p: Partial<GradientSpec>) {
    setSpec((cur) => ({ ...cur, ...p }));
  }

  function updateStop(index: number, p: Partial<GradientStop>) {
    setSpec((cur) => ({ ...cur, stops: cur.stops.map((s, i) => (i === index ? { ...s, ...p } : s)) }));
  }

  function removeStop(index: number) {
    setSpec((cur) => (cur.stops.length <= MIN_STOPS ? cur : { ...cur, stops: cur.stops.filter((_, i) => i !== index) }));
  }

  async function copyCss() {
    try {
      await navigator.clipboard.writeText(cssText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("クリップボードにコピーできませんでした。コードを選択して手動でコピーしてください。");
    }
  }

  async function downloadPng() {
    setError(null);
    try {
      const size = PNG_SIZES[pngSize];
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvasの初期化に失敗しました");
      paintGradient(ctx, size.width, size.height, spec);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像の書き出しに失敗しました"))), "image/png")
      );
      downloadBlob(blob, `gradient-${size.width}x${size.height}.png`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "画像の書き出しに失敗しました");
    }
  }

  const usesAngle = spec.type === "linear" || spec.type === "conic";
  const usesCenter = spec.type === "radial" || spec.type === "conic";

  return (
    <div className="flex flex-col gap-6">
      <div
        data-testid="gradient-preview"
        role="img"
        aria-label="グラデーションのプレビュー"
        className="h-56 w-full rounded-2xl border border-neutral-200 dark:border-neutral-700"
        style={{ background: cssValue }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">プリセット:</span>
        {GRADIENT_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() =>
              setSpec({
                ...DEFAULT_GRADIENT,
                ...p.spec,
              })
            }
            className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            {p.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSpec(randomGradient())}
          className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300"
        >
          ランダム
        </button>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">種類</p>
          <div className="flex flex-wrap gap-2">
            {TYPE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={spec.type === o.value}
                onClick={() => patch({ type: o.value })}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  spec.type === o.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {usesAngle && (
          <SliderField label="角度" value={spec.angle} min={0} max={360} unit="°" onChange={(v) => patch({ angle: v })} />
        )}

        {spec.type === "radial" && (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">形</p>
            <div className="flex gap-2">
              {(["circle", "ellipse"] as const).map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-pressed={spec.radialShape === shape}
                  onClick={() => patch({ radialShape: shape })}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    spec.radialShape === shape
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {shape === "circle" ? "円" : "楕円"}
                </button>
              ))}
            </div>
          </div>
        )}

        {usesCenter && (
          <div className="grid gap-4 sm:grid-cols-2">
            <SliderField label="中心の位置(横)" value={spec.centerX} min={0} max={100} unit="%" onChange={(v) => patch({ centerX: v })} />
            <SliderField label="中心の位置(縦)" value={spec.centerY} min={0} max={100} unit="%" onChange={(v) => patch({ centerY: v })} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            色の指定({spec.stops.length}/{MAX_STOPS})
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => patch({ stops: reverseStops(spec.stops) })}
              className="rounded-md px-2.5 py-1 text-xs text-neutral-600 ring-1 ring-neutral-200 hover:bg-neutral-100 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-800"
            >
              色の並びを逆にする
            </button>
            <button
              type="button"
              disabled={spec.stops.length >= MAX_STOPS}
              onClick={() => patch({ stops: addStop(spec.stops) })}
              className="rounded-md px-2.5 py-1 text-xs text-blue-700 ring-1 ring-blue-200 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-300 dark:ring-blue-900"
            >
              色を追加
            </button>
          </div>
        </div>

        <ul className="flex flex-col gap-3">
          {spec.stops.map((stop, i) => (
            <li key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`色${i + 1}`}
                  value={stop.color}
                  onChange={(e) => updateStop(i, { color: e.target.value })}
                  className="h-9 w-12 cursor-pointer rounded-md border border-neutral-300 dark:border-neutral-700"
                />
                <input
                  key={stop.color}
                  type="text"
                  aria-label={`色${i + 1}のカラーコード`}
                  defaultValue={stop.color}
                  maxLength={7}
                  onChange={(e) => {
                    if (isValidHexColor(e.target.value)) updateStop(i, { color: e.target.value.toLowerCase() });
                  }}
                  className="w-24 rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <input
                type="range"
                aria-label={`色${i + 1}の位置`}
                min={0}
                max={100}
                value={stop.position}
                onChange={(e) => updateStop(i, { position: Number(e.target.value) })}
              />
              <div className="flex items-center gap-2">
                <span className="w-10 text-right text-sm tabular-nums text-neutral-600 dark:text-neutral-300">{stop.position}%</span>
                <button
                  type="button"
                  disabled={spec.stops.length <= MIN_STOPS}
                  onClick={() => removeStop(i)}
                  aria-label={`色${i + 1}を削除`}
                  className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">CSSコード</p>
          <button
            type="button"
            onClick={copyCss}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            {copied ? "コピーしました" : "コードをコピー"}
          </button>
        </div>
        <pre
          data-testid="gradient-css"
          className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-white p-3 font-mono text-xs text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
        >
          {cssText}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="画像のサイズ"
          value={pngSize}
          onChange={(e) => setPngSize(Number(e.target.value))}
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {PNG_SIZES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={downloadPng}
          className="rounded-lg bg-neutral-800 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          PNG画像として保存
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
