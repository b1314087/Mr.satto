"use client";

import { useMemo, useState } from "react";
import { QrCodeProcessor } from "@/lib/processors/browser/qrcode";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { SliderField } from "@/components/common/slider-field";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob, dataUrlToBlob } from "@/lib/utils/format";
import {
  DEFAULT_MARK_DATA_URL,
  QR_LOGO_DEFAULT_PCT,
  QR_LOGO_MAX_PCT,
  QR_LOGO_MIN_PCT,
  fileToMarkDataUrl,
  type QrLogo,
  type QrLogoPosition,
} from "@/lib/qr/logo";
import { useLiveQr } from "./shared/use-live-qr";

type MarkKind = "default" | "custom" | "none";

type Ecl = "L" | "M" | "Q" | "H";

const ECL_OPTIONS: { value: Ecl; label: string }[] = [
  { value: "L", label: "L（約7%を復元）" },
  { value: "M", label: "M（約15%を復元）" },
  { value: "Q", label: "Q（約25%を復元）" },
  { value: "H", label: "H（約30%を復元）" },
];

const DEFAULT_SIZE = 320;

/** 相対輝度(0〜1)。コントラスト警告の判定に使う */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastWarning(fg: string, bg: string): string | null {
  const a = luminance(fg);
  const b = luminance(bg);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  if (ratio < 3) return "前景色と背景色の差が小さく、読み取れない可能性があります。";
  if (a > b) return "前景色が背景色より明るいと、読み取れないスキャナーがあります。";
  return null;
}

export function QrGeneratorTool() {
  const [text, setText] = useState("");
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [ecl, setEcl] = useState<Ecl>("M");
  const [fg, setFg] = useState("#000000");
  const [bg, setBg] = useState("#ffffff");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [markKind, setMarkKind] = useState<MarkKind>("default");
  const [customMark, setCustomMark] = useState<string | null>(null);
  const [markPosition, setMarkPosition] = useState<QrLogoPosition>("center");
  const [markPct, setMarkPct] = useState(QR_LOGO_DEFAULT_PCT);

  const markSrc = markKind === "default" ? DEFAULT_MARK_DATA_URL : markKind === "custom" ? customMark : null;
  const logo: QrLogo | null = useMemo(
    () => (markSrc ? { src: markSrc, position: markPosition, sizePct: markPct } : null),
    [markSrc, markPosition, markPct]
  );

  async function handleMarkFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      setCustomMark(await fileToMarkDataUrl(file));
      setMarkKind("custom");
    } catch (e) {
      setError(e instanceof Error ? e.message : "画像を読み込めませんでした");
    }
  }

  // 入力・設定を変えるたびにその場で再生成する（ボタンを押さなくても見える）
  const options = { size, errorCorrectionLevel: ecl, darkColor: fg, lightColor: bg, logo };
  const live = useLiveQr(text, options);

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    try {
      // プレビューと同じ処理・同じ設定で生成する
      await new QrCodeProcessor().process({ text, ...options });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!live.dataUrl) return;
    // data URLはfetch()を使わずに直接Blobへ変換する（CSPのconnect-srcに
    // data:を含めていないため、fetch(dataUrl)は失敗する。詳細はformat.tsの
    // dataUrlToBlob()のコメントを参照）。
    const blob = dataUrlToBlob(live.dataUrl);
    downloadBlob(blob, "qrcode.png");
  }

  const warning = contrastWarning(fg, bg);
  const colorInputClass =
    "h-9 w-12 cursor-pointer rounded-md border border-neutral-300 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900";

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        URLやテキストを入力
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="https://example.com"
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <SliderField
          label="サイズ"
          value={size}
          min={128}
          max={1024}
          step={32}
          unit="px"
          onChange={setSize}
          onReset={size !== DEFAULT_SIZE ? () => setSize(DEFAULT_SIZE) : undefined}
        />
        <label className="flex flex-col gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-200">
          誤り訂正レベル
          <select
            value={logo ? "H" : ecl}
            disabled={!!logo}
            onChange={(e) => setEcl(e.target.value as Ecl)}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-normal disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
          >
            {ECL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input type="color" value={fg} onChange={(e) => setFg(e.target.value)} className={colorInputClass} />
          前景色（QRの色）
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} className={colorInputClass} />
          背景色
        </label>
      </div>
      {warning && <p className="text-xs text-amber-600 dark:text-amber-400">{warning}</p>}

      <section className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">QRコードのマーク（ロゴ）</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="マークの種類">
          {(
            [
              { value: "default", label: "Mr.Sattoのアイコン" },
              { value: "custom", label: "自分の画像" },
              { value: "none", label: "マークなし" },
            ] as { value: MarkKind; label: string }[]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={markKind === o.value}
              onClick={() => setMarkKind(o.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                markKind === o.value
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {markKind === "custom" && (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-neutral-600 dark:text-neutral-300">マークにする画像（PNG・JPEG・SVGなど）</span>
            <input
              type="file"
              accept="image/*"
              aria-label="マークにする画像"
              onChange={(e) => {
                void handleMarkFile(e.target.files?.[0]);
                e.target.value = "";
              }}
              className="text-sm"
            />
            {!customMark && (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">画像を選ぶとQRコードに表示されます。</span>
            )}
          </label>
        )}

        {markKind !== "none" && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5" role="group" aria-label="マークの位置">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">マークの位置</p>
              <div className="flex gap-2">
                {(
                  [
                    { value: "center", label: "真ん中" },
                    { value: "bottomRight", label: "右下" },
                  ] as { value: QrLogoPosition; label: string }[]
                ).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={markPosition === o.value}
                    onClick={() => setMarkPosition(o.value)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                      markPosition === o.value
                        ? "bg-blue-600 text-white"
                        : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <SliderField
              label="マークの大きさ"
              value={markPct}
              min={QR_LOGO_MIN_PCT}
              max={QR_LOGO_MAX_PCT}
              unit="%"
              hint="QRコードの一辺に対する割合です。大きいほど読み取りにくくなります。"
              onChange={setMarkPct}
            />
          </div>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          マークを付けると、読み取れるように誤り訂正レベルが自動で「H（最高）」になります。印刷や配布の前に、スマートフォンで読み取れることを必ず確認してください。
        </p>
      </section>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!text.trim() || status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        QRコードを生成する
      </button>

      <ProcessingStatus state={status} successLabel="生成しました" />
      {(error || live.error) && <ErrorMessage message={(error ?? live.error)!} />}

      <div
        data-testid="tool-preview"
        className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">プレビュー（入力や設定に合わせて自動で更新されます）</p>
        {live.dataUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={live.dataUrl}
              alt="生成されたQRコード"
              className="h-48 w-48 rounded-lg p-2"
              style={{ backgroundColor: bg }}
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              出力サイズ: {size}×{size}px ／ 誤り訂正: {logo ? "H（マーク付きのため自動）" : ecl}
            </p>
            <RewardedDownloadGate onDownload={handleDownload} label="画像としてダウンロード" disabled={!live.fresh} />
          </>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            URLやテキストを入力すると、ここにQRコードが表示されます。
          </p>
        )}
      </div>
    </div>
  );
}
