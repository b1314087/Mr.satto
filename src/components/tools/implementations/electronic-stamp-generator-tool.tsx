"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { FilePickButton } from "@/components/common/file-pick-button";
import { Button } from "@/components/ui/button";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { closePdfDocument } from "@/lib/pdf/pdfjs-client";
import {
  IMPORTED_STAMP_DESIGN_UNAVAILABLE,
  STAMP_COLORS,
  STAMP_LIMITS,
  STAMP_QR_DESIGNS,
  StampExportProcessor,
  appendStampQr,
  autoTrimTransparentMargins,
  canEmbedStampQrInImage,
  canPlaceStampQr,
  embedStampQrInImage,
  stampQrMinSizePx,
  cropCanvasRegion,
  generateStampCanvas,
  loadCustomStampFont,
  loadStampImageToCanvas,
  loadStampPdf,
  generateStampSerial,
  removeLightBackground,
  renderStampPdfPage,
  resizeCanvasByScale,
  unloadCustomStampFont,
  type StampColorId,
  type StampQrDesign,
  type StampShape,
  type StampTextLayout,
} from "@/lib/processors/browser/electronic-stamp";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob } from "@/lib/utils/format";
import { SliderField } from "@/components/common/slider-field";

/**
 * 電子印鑑生成ツール（Phase 16）。
 *
 * 重要: これは「印影画像（透明PNG）を作る・取り込むためのツール」であり、
 * 法的な効力を持つ電子署名・デジタル署名・電子契約を提供するものではない。
 * UI文言でもその旨を明示し、「電子署名」という語は使用しない。
 *
 * 「文字から作る」「印鑑を取り込む」の2モードを持つ。処理はすべて
 * ブラウザのCanvas上で完結し、画像・PDFの中身をサーバーへ送信したり、
 * localStorage/sessionStorage/IndexedDBへ保存したりすることは一切ない。
 *
 * 固有番号とQRコード：「印影画像を生成する」を押したときに、ランダムな固有番号を1つ発行し、その番号だけを
 * 入れたQRコードと番号を印影に入れる(electronic-stamp.ts の generateStampSerial)。完成した画像(Blob)を
 * そのまま保持するので、同じ印影を何度ダウンロードしても番号は変わらない。もう一度生成すると新しい番号になる。
 * 編集中のプレビューには、番号を発行する前なので、従来の配置ではQRコードの置き場所だけを、①〜③のデザインでは
 * 実在しない番号(STAMP_QR_PREVIEW_SERIAL)のQRコードで見た目を示す。
 *
 * QRコードのデザイン：編集画面で選んだデザインはプレビューに出る。生成したあと、完成のポップアップでデザインを
 * 切り替えると、生成したときの設定と同じ固有番号のまま、印影を描き直す(番号は発行し直さない)。
 */

/** 生成した印影を、同じ固有番号のまま、別のデザインで描き直すための関数 */
interface StampRerender {
  render: (design: StampQrDesign) => HTMLCanvasElement | null;
  fits: (design: StampQrDesign) => boolean;
  designs: StampQrDesign[];
}

type Mode = "text" | "import";
type ImportStep = "select" | "crop" | "adjust";

interface Box {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

const DEFAULT_BOX: Box = { xPct: 15, yPct: 15, wPct: 70, hPct: 70 };
const MIN_SIZE_PCT = 5;
const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

function clampBox(next: Box): Box {
  const wPct = Math.min(Math.max(next.wPct, MIN_SIZE_PCT), 100);
  const hPct = Math.min(Math.max(next.hPct, MIN_SIZE_PCT), 100);
  const xPct = Math.min(Math.max(next.xPct, 0), 100 - wPct);
  const yPct = Math.min(Math.max(next.yPct, 0), 100 - hPct);
  return { xPct, yPct, wPct, hPct };
}

/** 透明背景が分かるよう、プレビューの背後に敷くチェッカー柄 */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, #d4d4d4 25%, transparent 25%), linear-gradient(-45deg, #d4d4d4 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d4 75%), linear-gradient(-45deg, transparent 75%, #d4d4d4 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  backgroundColor: "#f5f5f5",
};

const COLOR_OPTIONS: { id: StampColorId; label: string }[] = [
  { id: "red", label: "朱色" },
  { id: "black", label: "黒" },
  { id: "blue", label: "青" },
];

function extToSuffix(): string {
  return "png";
}

export function ElectronicStampGeneratorTool() {
  const [mode, setMode] = useState<Mode>("text");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);
  /** 完成した印影の固有番号(QRコードを入れないときは null) */
  const [serial, setSerial] = useState<string | null>(null);
  /** QRコードのデザイン(文字から作る・取り込むで別々に覚える) */
  const [textDesign, setTextDesign] = useState<StampQrDesign>("inText");
  const [importDesign, setImportDesign] = useState<StampQrDesign>("standard");
  /** 完成した印影を、同じ番号のまま描き直す関数(番号を入れた印影のときだけ) */
  const [rerender, setRerender] = useState<StampRerender | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  function resetResult() {
    if (result) URL.revokeObjectURL(result.url);
    setRerender(null);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleExport(canvas: HTMLCanvasElement, issuedSerial: string | null, nextRerender?: StampRerender) {
    setStatus("processing");
    setError(null);
    try {
      const output = await new StampExportProcessor().process({ canvas });
      if (result) URL.revokeObjectURL(result.url);
      setRerender(issuedSerial && nextRerender ? nextRerender : null);
      setSerial(issuedSerial);
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "印影画像の生成に失敗しました");
      setStatus("error");
    }
  }

  /**
   * デザインを切り替える。完成のポップアップから切り替えたとき(redraw)は、完成した印影を、同じ番号のまま描き直す。
   * 編集画面での切り替えは、プレビュー(これから生成する印影)だけを変える
   */
  function changeDesign(target: Mode, design: StampQrDesign, redraw = false) {
    if (target === "text") setTextDesign(design);
    else setImportDesign(design);
    if (!redraw) return;
    if (target !== mode || !result || !serial || !rerender || !rerender.fits(design)) return;
    const canvas = rerender.render(design);
    if (canvas) void handleExport(canvas, serial, rerender);
  }

  const currentDesign = mode === "text" ? textDesign : importDesign;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setMode("text");
            resetResult();
          }}
          aria-pressed={mode === "text"}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            mode === "text"
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          文字から作る
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("import");
            resetResult();
          }}
          aria-pressed={mode === "import"}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            mode === "import"
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          印鑑を取り込む
        </button>
      </div>

      <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
        本ツールで作成・取り込みできるのは「印影画像」です。法的な効力を持つ電子署名・デジタル署名を提供するものではありません。
      </p>

      {mode === "text" ? (
        <TextStampPanel onExport={handleExport} status={status} design={textDesign} onDesignChange={(d) => changeDesign("text", d)} />
      ) : (
        <ImportStampPanel onExport={handleExport} status={status} design={importDesign} onDesignChange={(d) => changeDesign("import", d)} />
      )}

      <ProcessingStatus state={status} processingLabel="生成中..." successLabel="印影画像が完成しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <div className="rounded-lg border border-neutral-200 p-2 dark:border-neutral-700" style={CHECKER_STYLE}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result.url} alt="生成された印影画像のプレビュー" className="max-h-56 max-w-full object-contain" />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px（透明PNG）
          </p>
          {serial && (
            <p className="text-sm text-neutral-700 dark:text-neutral-200">
              固有番号：<span data-testid="stamp-serial" className="font-mono font-semibold">{serial}</span>
              <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
                QRコードには、この番号だけが入っています（名前などは入っていません）。番号はこのブラウザの中で作り、どこにも送信・保存していません。
              </span>
            </p>
          )}
          {serial && rerender && rerender.designs.length > 1 && (
            <fieldset className="flex flex-col gap-1.5" data-testid="result-qr-design">
              <legend className="mb-1 text-xs font-medium text-neutral-700 dark:text-neutral-200">
                QRコードのデザインを変える（固有番号はそのまま）
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {rerender.designs.map((id) => {
                  const fits = rerender.fits(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      data-testid={`result-qr-design-${id}`}
                      aria-pressed={currentDesign === id}
                      disabled={!fits || status === "processing"}
                      title={fits ? undefined : "この印影の大きさでは入りません"}
                      onClick={() => changeDesign(mode, id, true)}
                      className={`rounded-lg px-2.5 py-1 text-xs ${currentDesign === id ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"} disabled:opacity-40`}
                    >
                      {designLabel(id, mode)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          <RewardedDownloadGate
            label="PNGをダウンロード"
            onDownload={() => downloadBlob(result.blob, serial ? `electronic-stamp-${serial}.${extToSuffix()}` : `electronic-stamp.${extToSuffix()}`)}
          />
        </ResultPopup>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A. 文字から印影を生成
// ---------------------------------------------------------------------------

function TextStampPanel({
  onExport,
  status,
  design,
  onDesignChange,
}: {
  onExport: (canvas: HTMLCanvasElement, serial: string | null, rerender?: StampRerender) => void | Promise<void>;
  status: ProcessingState;
  design: StampQrDesign;
  onDesignChange: (design: StampQrDesign) => void;
}) {
  const [text, setText] = useState("印");
  const [shape, setShape] = useState<StampShape>("round");
  const [layout, setLayout] = useState<StampTextLayout>("vertical");
  const [sizePx, setSizePx] = useState(300);
  const [fontScale, setFontScale] = useState(1);
  const [borderWidthRatio, setBorderWidthRatio] = useState(0.05);
  const [paddingRatio, setPaddingRatio] = useState(0.08);
  const [color, setColor] = useState<StampColorId>("red");
  const [offsetXPct, setOffsetXPct] = useState(0);
  const [offsetYPct, setOffsetYPct] = useState(0);
  const [withQr, setWithQr] = useState(true);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const latestCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // カスタムフォント（篆書体・印相体・古印体・隷書体など、ユーザー自身が
  // 入手したフォントファイル）の読み込み状態。本ツールは特定の印影用書体を
  // 同梱していない（無料で配布できるライセンスのものがほぼ存在しないため。
  // electronic-stamp.tsのloadCustomStampFont冒頭コメント参照）。
  const [customFont, setCustomFont] = useState<{ cssFontFamily: string; fileName: string } | null>(null);
  const [fontLoading, setFontLoading] = useState(false);
  const [fontError, setFontError] = useState<string | null>(null);
  const [boldText, setBoldText] = useState(true);
  const customFontRef = useRef<string | null>(null);

  useEffect(() => {
    customFontRef.current = customFont?.cssFontFamily ?? null;
  }, [customFont]);

  // アンマウント時に読み込んだカスタムフォントをブラウザの登録から解放する
  useEffect(() => {
    return () => {
      if (customFontRef.current) unloadCustomStampFont(customFontRef.current);
    };
  }, []);

  async function handleFontFile(file: File | undefined) {
    if (!file) return;
    setFontError(null);
    setFontLoading(true);
    try {
      const loaded = await loadCustomStampFont(file);
      if (customFontRef.current) unloadCustomStampFont(customFontRef.current);
      setCustomFont(loaded);
      setBoldText(false); // 印影用フォントは書体自体が太いことが多く、合成太字で形が崩れるのを避ける
    } catch (err) {
      setFontError(err instanceof Error ? err.message : "フォントファイルを読み込めませんでした。");
    } finally {
      setFontLoading(false);
    }
  }

  function resetToDefaultFont() {
    if (customFontRef.current) unloadCustomStampFont(customFontRef.current);
    setCustomFont(null);
    setBoldText(true);
    setFontError(null);
  }

  useEffect(() => {
    const target = previewRef.current;
    if (!target) return;
    const generated = generateStampCanvas({
      text: text.trim() || "印",
      shape,
      layout,
      sizePx,
      fontScale,
      borderWidthRatio,
      paddingRatio,
      color,
      offsetXPct,
      offsetYPct,
      fontFamily: customFont?.cssFontFamily,
      fontWeight: boldText ? "bold" : "normal",
      // 編集中は番号を発行しない(従来の配置は置き場所だけ、①〜③は実在しない番号で見た目を示す)
      ...(withQr ? { qr: { serial: null, design } } : {}),
    });
    latestCanvasRef.current = generated;
    target.width = generated.width;
    target.height = generated.height;
    const ctx = target.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(generated, 0, 0);
    }
  }, [
    text,
    shape,
    layout,
    sizePx,
    fontScale,
    borderWidthRatio,
    paddingRatio,
    color,
    offsetXPct,
    offsetYPct,
    customFont,
    boldText,
    withQr,
    design,
  ]);

  const stampText = text.trim() || "印";
  const fitsFor = (d: StampQrDesign) => canPlaceStampQr({ sizePx, shape, borderWidthRatio, text: stampText, layout, design: d });
  const qrFits = fitsFor(design);
  const qrMinSize = withQr && !qrFits ? stampQrMinSizePx({ sizePx, shape, borderWidthRatio, text: stampText, layout, design }) : null;

  // デザインの選択肢の見本(今の設定の印影を、各デザインで描いたもの。実在しない番号で描く)。
  // Canvasはブラウザでしか作れないため、見本の表示部品が、表示したあとで描く(thumb は描く関数)
  const designThumbs = useMemo(() => {
    if (!withQr) return null;
    const base = {
      text: stampText,
      shape,
      layout,
      sizePx,
      fontScale,
      borderWidthRatio,
      paddingRatio,
      color,
      offsetXPct,
      offsetYPct,
      fontFamily: customFont?.cssFontFamily,
      fontWeight: boldText ? ("bold" as const) : ("normal" as const),
    };
    return Object.fromEntries(
      STAMP_QR_DESIGNS.map((d) => [
        d.id,
        canPlaceStampQr({ sizePx, shape, borderWidthRatio, text: stampText, layout, design: d.id })
          ? () => generateStampCanvas({ ...base, qr: { serial: null, design: d.id } })
          : null,
      ])
    ) as Record<StampQrDesign, (() => HTMLCanvasElement) | null>;
  }, [withQr, stampText, shape, layout, sizePx, fontScale, borderWidthRatio, paddingRatio, color, offsetXPct, offsetYPct, customFont, boldText]);

  /** 「印影画像を生成する」：固有番号を発行し、その番号のQRコードを入れた印影を作る */
  function exportWithSerial() {
    const issued = withQr && qrFits ? generateStampSerial() : null;
    // 生成したときの設定を覚えておき、あとでデザインだけを変えて、同じ番号のまま描き直せるようにする
    const snapshot = {
      text: stampText,
      shape,
      layout,
      sizePx,
      fontScale,
      borderWidthRatio,
      paddingRatio,
      color,
      offsetXPct,
      offsetYPct,
      fontFamily: customFont?.cssFontFamily,
      fontWeight: boldText ? ("bold" as const) : ("normal" as const),
    };
    const canvas = generateStampCanvas({ ...snapshot, ...(issued ? { qr: { serial: issued, design } } : {}) });
    const fits = (d: StampQrDesign) =>
      canPlaceStampQr({ sizePx: snapshot.sizePx, shape: snapshot.shape, borderWidthRatio: snapshot.borderWidthRatio, text: snapshot.text, layout: snapshot.layout, design: d });
    const rerender: StampRerender | undefined = issued
      ? {
          designs: STAMP_QR_DESIGNS.map((d) => d.id),
          fits,
          render: (d) => (fits(d) ? generateStampCanvas({ ...snapshot, qr: { serial: issued, design: d } }) : null),
        }
      : undefined;
    void onExport(canvas, issued, rerender);
  }

  const textTooLong = Array.from(text).length > STAMP_LIMITS.maxTextLength;

  return (
    <PreviewSplitLayout
      preview={
      <div className="flex flex-col items-center justify-center gap-2">
        <div data-testid="tool-preview" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700" style={CHECKER_STYLE}>
          <canvas ref={previewRef} aria-label="印影のプレビュー" className="max-h-72 max-w-full" />
        </div>
              </div>
      }
    >
      <div className="flex flex-1 flex-col gap-4">
        <div>
          <label htmlFor="stamp-text-input" className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-200">
            文字
          </label>
          <input
            id="stamp-text-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={STAMP_LIMITS.maxTextLength + 4}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="例）印、山田、承認"
          />
          {textTooLong && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              文字数は{STAMP_LIMITS.maxTextLength}文字以内でご利用ください。
            </p>
          )}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">印影タイプ</legend>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={shape === "round"}
              onClick={() => setShape("round")}
              className={`rounded-lg px-3 py-1.5 text-sm ${shape === "round" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              丸印
            </button>
            <button
              type="button"
              aria-pressed={shape === "square"}
              onClick={() => setShape("square")}
              className={`rounded-lg px-3 py-1.5 text-sm ${shape === "square" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              角印
            </button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">文字の向き</legend>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={layout === "vertical"}
              onClick={() => setLayout("vertical")}
              className={`rounded-lg px-3 py-1.5 text-sm ${layout === "vertical" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              縦書き
            </button>
            <button
              type="button"
              aria-pressed={layout === "horizontal"}
              onClick={() => setLayout("horizontal")}
              className={`rounded-lg px-3 py-1.5 text-sm ${layout === "horizontal" ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
            >
              横書き
            </button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">色</legend>
          <div className="flex gap-2">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={color === c.id}
                onClick={() => setColor(c.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${color === c.id ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
              >
                <span
                  aria-hidden="true"
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: STAMP_COLORS[c.id] }}
                />
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
          印影サイズ（{sizePx}px）
          <input
            type="range"
            min={STAMP_LIMITS.minStampSizePx}
            max={STAMP_LIMITS.maxStampSizePx}
            step={10}
            value={sizePx}
            onChange={(e) => setSizePx(Number(e.target.value))}
          />
        </label>

        <QrOption checked={withQr} onChange={setWithQr} />
        {withQr && designThumbs && (
          <QrDesignPicker
            value={design}
            onChange={onDesignChange}
            choices={STAMP_QR_DESIGNS.map((d) => ({
              ...d,
              thumb: designThumbs[d.id],
              note: designThumbs[d.id] ? undefined : "この大きさ・文字数では入りません",
            }))}
          />
        )}
        {withQr && !qrFits && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            この大きさでは、QRコードを入れる場所が足りません。
            {qrMinSize !== null
              ? `印影サイズを${qrMinSize}px以上にするか、枠を細くするか、別のデザインを選んでください`
              : "文字数を減らすか、別のデザインを選んでください"}
            （このまま生成すると、QRコードの無い印影になります）。
          </p>
        )}

        <SliderField
          label="文字サイズ"
          value={Math.round(fontScale * 100)}
          min={50}
          max={150}
          step={5}
          unit="%"
          onChange={(v) => setFontScale(v / 100)}
        />

        <fieldset className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
          <legend className="mb-1 px-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">フォント</legend>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            標準では一般的なゴシック体で描画します。篆書体・印相体・古印体・隷書体などをお使いになりたい場合は、
            お手持ちのフォントファイル（.ttf / .otf / .woff / .woff2）を選択してください。これらの書体は無料で
            アプリに組み込んで配布できるライセンスのものがほぼ無いため、本ツールにはあらかじめ同梱していません。
            選択したファイルはこのブラウザの中だけで処理され、サーバーには送信されません。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <FilePickButton
              accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
              inputLabel="フォントファイルを選択"
              loading={fontLoading}
              onFilesSelected={(files) => void handleFontFile(files[0])}
            >
              フォントファイルを選択
            </FilePickButton>
            {customFont && (
              <Button variant="secondary" onClick={resetToDefaultFont}>
                標準フォントに戻す
              </Button>
            )}
          </div>
          <ProcessingStatus state={fontLoading ? "processing" : "idle"} processingLabel="読み込み中..." />
          {customFont && !fontLoading && (
            <p className="text-xs text-neutral-600 dark:text-neutral-300">使用中: {customFont.fileName}</p>
          )}
          {fontError && <ErrorMessage message={fontError} />}
          {customFont && (
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={boldText} onChange={(e) => setBoldText(e.target.checked)} />
              太字で描画する
            </label>
          )}
        </fieldset>

        <details className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-700">
          <summary className="cursor-pointer font-medium text-neutral-700 dark:text-neutral-200">
            詳細設定（枠の太さ・余白・位置調整）
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              枠の太さ
              <input
                type="range"
                min={0.01}
                max={0.1}
                step={0.005}
                value={borderWidthRatio}
                onChange={(e) => setBorderWidthRatio(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              内側の余白
              <input
                type="range"
                min={0}
                max={0.3}
                step={0.01}
                value={paddingRatio}
                onChange={(e) => setPaddingRatio(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              文字位置（左右）
              <input
                type="range"
                min={-20}
                max={20}
                step={1}
                value={offsetXPct}
                onChange={(e) => setOffsetXPct(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1 text-neutral-700 dark:text-neutral-200">
              文字位置（上下）
              <input
                type="range"
                min={-20}
                max={20}
                step={1}
                value={offsetYPct}
                onChange={(e) => setOffsetYPct(Number(e.target.value))}
              />
            </label>
          </div>
        </details>

        <button
          type="button"
          disabled={status === "processing" || text.trim() === "" || textTooLong} aria-busy={status === "processing" || undefined}
          onClick={exportWithSerial}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          印影画像を生成する
        </button>
      </div>
    </PreviewSplitLayout>
  );
}

// ---------------------------------------------------------------------------
// B. 既存の印鑑を取り込む
// ---------------------------------------------------------------------------

function ImportStampPanel({
  onExport,
  status,
  design,
  onDesignChange,
}: {
  onExport: (canvas: HTMLCanvasElement, serial: string | null, rerender?: StampRerender) => void | Promise<void>;
  status: ProcessingState;
  design: StampQrDesign;
  onDesignChange: (design: StampQrDesign) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ImportStep>("select");
  const [error, setError] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);

  // PDF関連
  const pdfDocRef = useRef<Awaited<ReturnType<typeof loadStampPdf>> | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [selectedPage, setSelectedPage] = useState(1);
  const [isPdf, setIsPdf] = useState(false);

  // 表示中の元画像（PDFの場合は選択中ページ）
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);

  // 切り抜き範囲
  const [box, setBox] = useState<Box>(DEFAULT_BOX);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "move" | "resize";
    corner?: Corner;
    startClientX: number;
    startClientY: number;
    startBox: Box;
  } | null>(null);

  // 切り抜き後〜調整
  const croppedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [removalEnabled, setRemovalEnabled] = useState(true);
  const [thresholdPercent, setThresholdPercent] = useState(55);
  const [autoTrimEnabled, setAutoTrimEnabled] = useState(true);
  const [scalePercent, setScalePercent] = useState(100);
  const [withQr, setWithQr] = useState(true);
  /** 調整後の印影(デザインの見本を描くため。finalCanvasRef と同じもの) */
  const [finalCanvas, setFinalCanvas] = useState<HTMLCanvasElement | null>(null);
  const [trimMessage, setTrimMessage] = useState<string | null>(null);
  const finalPreviewRef = useRef<HTMLCanvasElement>(null);
  const finalCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    return () => {
      if (sourceImageUrl) URL.revokeObjectURL(sourceImageUrl);
      // 画面を離れるときは、開いていたPDFを閉じる（作業用スレッドを残さない。ロードマップC 工程2）
      void closePdfDocument(pdfDocRef.current);
      pdfDocRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFromFile(f: File) {
    setError(null);
    setLoadingSource(true);
    try {
      const pdfLike = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      setIsPdf(pdfLike);
      // 前に開いていたPDF（ページ切り替えのために開いたまま持っていたもの）は、別のファイルを選んだ時点で閉じる
      const previous = pdfDocRef.current;
      pdfDocRef.current = null;
      void closePdfDocument(previous);
      if (pdfLike) {
        const pdf = await loadStampPdf(f);
        if (pdf.numPages === 0) {
          await closePdfDocument(pdf);
          throw new Error("このPDFにはページがありません。");
        }
        pdfDocRef.current = pdf;
        setPageCount(pdf.numPages);
        setSelectedPage(1);
        await renderPage(pdf, 1);
      } else {
        pdfDocRef.current = null;
        setPageCount(1);
        setSelectedPage(1);
        const canvas = await loadStampImageToCanvas(f);
        applySourceCanvas(canvas);
      }
      setBox(DEFAULT_BOX);
      setStep("crop");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした。対応形式を確認してください。");
      setStep("select");
    } finally {
      setLoadingSource(false);
    }
  }

  function applySourceCanvas(canvas: HTMLCanvasElement) {
    if (sourceImageUrl) URL.revokeObjectURL(sourceImageUrl);
    sourceCanvasRef.current = canvas;
    setSourceSize({ width: canvas.width, height: canvas.height });
    const url = canvas.toDataURL("image/png");
    setSourceImageUrl(url);
  }

  async function renderPage(pdf: Awaited<ReturnType<typeof loadStampPdf>>, pageNumber: number) {
    const canvas = await renderStampPdfPage(pdf, pageNumber, 900);
    applySourceCanvas(canvas);
  }

  async function handlePageChange(next: number) {
    if (!pdfDocRef.current || next < 1 || next > pageCount) return;
    setLoadingSource(true);
    try {
      setSelectedPage(next);
      await renderPage(pdfDocRef.current, next);
      setBox(DEFAULT_BOX);
    } catch {
      setError("ページの表示に失敗しました。");
    } finally {
      setLoadingSource(false);
    }
  }

  function handleBoxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "move", startClientX: e.clientX, startClientY: e.clientY, startBox: box };
  }

  function handleHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>, corner: Corner) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", corner, startClientX: e.clientX, startClientY: e.clientY, startBox: box };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dxPct = ((e.clientX - drag.startClientX) / rect.width) * 100;
    const dyPct = ((e.clientY - drag.startClientY) / rect.height) * 100;

    if (drag.mode === "move") {
      setBox(clampBox({ ...drag.startBox, xPct: drag.startBox.xPct + dxPct, yPct: drag.startBox.yPct + dyPct }));
      return;
    }

    let { xPct, yPct, wPct, hPct } = drag.startBox;
    const corner = drag.corner ?? "se";
    if (corner.includes("e")) wPct = drag.startBox.wPct + dxPct;
    if (corner.includes("s")) hPct = drag.startBox.hPct + dyPct;
    if (corner.includes("w")) {
      wPct = drag.startBox.wPct - dxPct;
      xPct = drag.startBox.xPct + dxPct;
    }
    if (corner.includes("n")) {
      hPct = drag.startBox.hPct - dyPct;
      yPct = drag.startBox.yPct + dyPct;
    }
    setBox(clampBox({ xPct, yPct, wPct, hPct }));
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  const NUDGE_PCT = 2;
  function handleBoxKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const delta: Record<string, Partial<Box>> = {
      ArrowLeft: { xPct: box.xPct - NUDGE_PCT },
      ArrowRight: { xPct: box.xPct + NUDGE_PCT },
      ArrowUp: { yPct: box.yPct - NUDGE_PCT },
      ArrowDown: { yPct: box.yPct + NUDGE_PCT },
    };
    const patch = delta[e.key];
    if (!patch) return;
    e.preventDefault();
    setBox(clampBox({ ...box, ...patch }));
  }

  function handleCancelCrop() {
    setBox(DEFAULT_BOX);
  }

  function handleConfirmCrop() {
    const source = sourceCanvasRef.current;
    const size = sourceSize;
    if (!source || !size) return;
    const region = {
      x: Math.round((box.xPct / 100) * size.width),
      y: Math.round((box.yPct / 100) * size.height),
      width: Math.round((box.wPct / 100) * size.width),
      height: Math.round((box.hPct / 100) * size.height),
    };
    try {
      const cropped = cropCanvasRegion(source, region);
      croppedCanvasRef.current = cropped;
      setRemovalEnabled(true);
      setThresholdPercent(55);
      setAutoTrimEnabled(true);
      setScalePercent(100);
      setStep("adjust");
    } catch {
      setError("印影部分をもう少し大きく選択してください。");
    }
  }

  useEffect(() => {
    if (step !== "adjust") return;
    const base = croppedCanvasRef.current;
    const target = finalPreviewRef.current;
    if (!base || !target) return;
    try {
      let working = base;
      if (removalEnabled) {
        working = removeLightBackground(working, thresholdPercent);
      }
      let trimmedNote: string | null = null;
      if (autoTrimEnabled) {
        const { canvas: trimmed, trimmed: didTrim } = autoTrimTransparentMargins(working, 6);
        working = trimmed;
        if (removalEnabled && !didTrim) {
          trimmedNote = "印影が検出できなかったため、余白のトリミングは行われていません。";
        }
      }
      if (scalePercent !== 100) {
        working = resizeCanvasByScale(working, scalePercent);
      }
      finalCanvasRef.current = working;
      setFinalCanvas(working);
      setTrimMessage(trimmedNote);
      // ①を選んでいるときは、プレビューにも①の見た目を出す(実在しない番号で描く)
      const shown = withQr && design === "inText" ? (embedStampQrInImage(working, null) ?? working) : working;
      target.width = shown.width;
      target.height = shown.height;
      const ctx = target.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, target.width, target.height);
        ctx.drawImage(shown, 0, 0);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "この画像では背景を完全に透明化できない場合があります。");
    }
  }, [step, removalEnabled, thresholdPercent, autoTrimEnabled, scalePercent, withQr, design]);

  // デザインの選択肢：①は印影の色・大きさで使えるかが決まる。②③は取り込んだ印影では使えない(理由を出す)
  const importChoices = useMemo(() => {
    if (step !== "adjust" || !finalCanvas || !withQr) return null;
    const embed = canEmbedStampQrInImage(finalCanvas);
    return STAMP_QR_DESIGNS.map((d) => {
      if (d.id === "inText") {
        return embed.ok
          ? { ...d, description: IMPORTED_IN_TEXT_DESCRIPTION, thumb: () => embedStampQrInImage(finalCanvas, null) }
          : { ...d, thumb: null, disabledReason: embed.reason };
      }
      if (d.id === "standard") return { ...d, label: designLabel("standard", "import"), description: "これまでどおり、印影には重ねず、印影の下に番号とQRコード（白い四角）を並べます。", thumb: null };
      return { ...d, thumb: null, disabledReason: IMPORTED_STAMP_DESIGN_UNAVAILABLE[d.id] };
    });
  }, [finalCanvas, step, withQr]);

  // 選んでいた①が使えない画像になったら、従来の配置に戻す
  const inTextUnavailable = !!importChoices?.find((c) => c.id === "inText" && "disabledReason" in c && c.disabledReason);
  useEffect(() => {
    if (inTextUnavailable && design === "inText") onDesignChange("standard");
  }, [inTextUnavailable, design, onDesignChange]);

  /** 取り込んだ印影に、選んだデザインで固有番号とQRコードを入れる(①が使えなければ従来の配置) */
  function composeImported(source: HTMLCanvasElement, issued: string, d: StampQrDesign): HTMLCanvasElement {
    if (d === "inText") {
      const embedded = embedStampQrInImage(source, issued);
      if (embedded) return embedded;
    }
    return appendStampQr(source, issued, STAMP_COLORS.black);
  }

  return (
    <div className="flex flex-col gap-5">
      {error && <ErrorMessage message={error} />}
      {step === "select" && (
        <>
          <FileDropzone
            accept="image/png,image/jpeg,application/pdf"
            label="印鑑の画像・PDFをドラッグ&ドロップ"
            hint="またはタップして選択（PNG・JPG・PDF）"
            onFilesSelected={(files) => {
              setFile(files[0]);
              void loadFromFile(files[0]);
            }}
            onError={setError}
          />
          {loadingSource && <p className="text-sm text-neutral-500 dark:text-neutral-400">読み込み中...</p>}
        </>
      )}

      {step === "crop" && sourceImageUrl && sourceSize && (
        <div className="flex flex-col gap-3">
          {file && <p className="text-xs text-neutral-500 dark:text-neutral-400">{file.name}</p>}

          {isPdf && pageCount > 1 && (
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => void handlePageChange(selectedPage - 1)}
                disabled={selectedPage <= 1 || loadingSource}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 disabled:opacity-40 dark:bg-neutral-800"
              >
                前へ
              </button>
              <span>
                {selectedPage} / {pageCount} ページ
              </span>
              <button
                type="button"
                onClick={() => void handlePageChange(selectedPage + 1)}
                disabled={selectedPage >= pageCount || loadingSource}
                className="rounded-lg bg-neutral-100 px-3 py-1.5 disabled:opacity-40 dark:bg-neutral-800"
              >
                次へ
              </button>
            </div>
          )}

          <div
            ref={containerRef}
            data-testid="stamp-crop-container"
            className="relative w-full touch-none select-none overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900 dark:border-neutral-700"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={sourceImageUrl} alt="取り込んだ印鑑のプレビュー" draggable={false} className="block h-auto w-full select-none" />
            <div
              role="group"
              tabIndex={0}
              aria-label="印影の切り抜き範囲。矢印キーで移動できます"
              onPointerDown={handleBoxPointerDown}
              onKeyDown={handleBoxKeyDown}
              data-testid="stamp-crop-box"
              className="absolute cursor-move border-2 border-blue-400 bg-blue-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
              style={{ left: `${box.xPct}%`, top: `${box.yPct}%`, width: `${box.wPct}%`, height: `${box.hPct}%` }}
            >
              {CORNERS.map((corner) => (
                <div
                  key={corner}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => handleHandlePointerDown(e, corner)}
                  aria-label={`切り抜き範囲の${corner}角をドラッグしてサイズ変更`}
                  className={`absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-white bg-blue-500 shadow ${
                    corner === "nw"
                      ? "left-0 top-0 cursor-nwse-resize"
                      : corner === "ne"
                        ? "left-full top-0 cursor-nesw-resize"
                        : corner === "sw"
                          ? "left-0 top-full cursor-nesw-resize"
                          : "left-full top-full cursor-nwse-resize"
                  }`}
                />
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCancelCrop}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
            >
              範囲をリセット
            </button>
            <button
              type="button"
              onClick={handleConfirmCrop}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              切り抜く
            </button>
          </div>
        </div>
      )}

      {step === "adjust" && (
        <PreviewSplitLayout
          preview={
          <div className="flex flex-col items-center justify-center gap-2">
            <div data-testid="tool-preview" className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700" style={CHECKER_STYLE}>
              <canvas ref={finalPreviewRef} data-testid="stamp-final-preview" aria-label="調整後の印影プレビュー" className="max-h-72 max-w-full" />
            </div>
                      </div>
          }
        >
          <div className="flex flex-1 flex-col gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={removalEnabled}
                onChange={(e) => setRemovalEnabled(e.target.checked)}
              />
              背景を自動的に透明化する
            </label>
            <label className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
              しきい値（{thresholdPercent}）
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                disabled={!removalEnabled}
                value={thresholdPercent}
                onChange={(e) => setThresholdPercent(Number(e.target.value))}
              />
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">背景が複雑な画像は、完全に分離できない場合があります。しきい値で調整してください。</p>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input
                type="checkbox"
                checked={autoTrimEnabled}
                onChange={(e) => setAutoTrimEnabled(e.target.checked)}
              />
              余白を自動的にトリミングする
            </label>
            {trimMessage && <p className="text-xs text-amber-700 dark:text-amber-400">{trimMessage}</p>}
            <QrOption checked={withQr} onChange={setWithQr} note="取り込んだ印影には、①（印影の線に組み込む）か、従来の配置（印影の下に並べる）を選べます。" />
            {importChoices && <QrDesignPicker value={design} onChange={onDesignChange} choices={importChoices} />}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">出力サイズ</legend>
              <div className="flex gap-2">
                {[50, 100, 150, 200].map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={scalePercent === p}
                    onClick={() => setScalePercent(p)}
                    className={`rounded-lg px-3 py-1.5 text-sm ${scalePercent === p ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"}`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep("crop")}
                className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                範囲を選び直す
              </button>
              <button
                type="button"
                disabled={status === "processing"} aria-busy={status === "processing" || undefined}
                onClick={() => {
                  const finalCanvas = finalCanvasRef.current;
                  if (!finalCanvas) return;
                  // 取り込んだ印影は文字の位置が分からないため、①(印影の線に組み込む)か、印影の下に並べる
                  const issued = withQr ? generateStampSerial() : null;
                  if (!issued) {
                    void onExport(finalCanvas, null);
                    return;
                  }
                  const embedOk = canEmbedStampQrInImage(finalCanvas).ok;
                  const fits = (d: StampQrDesign) => d === "standard" || (d === "inText" && embedOk);
                  const rerender: StampRerender = {
                    designs: embedOk ? ["inText", "standard"] : ["standard"],
                    fits,
                    render: (d) => (fits(d) ? composeImported(finalCanvas, issued, d) : null),
                  };
                  void onExport(composeImported(finalCanvas, issued, fits(design) ? design : "standard"), issued, rerender);
                }}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                印影画像を生成する
              </button>
            </div>
          </div>
        </PreviewSplitLayout>
      )}
    </div>
  );
}

/** 固有番号とQRコードを入れるかの選択(文字から作る・取り込むの両方で使う) */
function QrOption({ checked, onChange, note }: { checked: boolean; onChange: (v: boolean) => void; note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        固有番号とQRコードを入れる
      </label>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        生成するたびに、ランダムな固有番号（例：MS-7K9P-2XQ8-4D6A）を発行し、その番号だけを入れたQRコードを印影に入れます。
        {note ? ` ${note}` : ""}
      </p>
    </div>
  );
}

/** 取り込んだ印影で①を選んだときの説明 */
const IMPORTED_IN_TEXT_DESCRIPTION =
  "印影全体にQRコードを重ね、印影の線の部分を濃いマスと薄い色にします（文字の位置は判別せず、印影の線をそのまま使います）。印影は少し薄く見えます。";

/** デザインの名前(取り込んだ印影の従来の配置は「印影の下に並べる」) */
function designLabel(id: StampQrDesign, mode: Mode): string {
  if (id === "standard" && mode === "import") return "従来の配置（印影の下に並べる）";
  return STAMP_QR_DESIGNS.find((d) => d.id === id)?.label ?? id;
}

interface QrDesignChoice {
  id: StampQrDesign;
  label: string;
  description: string;
  /** 見本を描く関数(無ければ、見本の代わりに短い説明を出す) */
  thumb: (() => HTMLCanvasElement | null) | null;
  /** 選べない理由(取り込んだ印影の②③など) */
  disabledReason?: string;
  /** 選べるが、今の設定では入らないときの注意 */
  note?: string;
}

/** 「QRコードのデザイン」の選択肢(見本つき) */
function QrDesignPicker({ choices, value, onChange }: { choices: QrDesignChoice[]; value: StampQrDesign; onChange: (d: StampQrDesign) => void }) {
  const selected = choices.find((c) => c.id === value);
  return (
    <fieldset className="flex flex-col gap-2" data-testid="qr-design-picker">
      <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-200">QRコードのデザイン</legend>
      <div className="grid grid-cols-2 gap-2">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`qr-design-${c.id}`}
            aria-pressed={value === c.id}
            disabled={!!c.disabledReason}
            onClick={() => onChange(c.id)}
            className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
              value === c.id
                ? "border-blue-600 bg-blue-50 ring-2 ring-blue-600/30 dark:bg-blue-950/30"
                : "border-neutral-200 dark:border-neutral-700"
            }`}
          >
            <span className="flex h-24 w-24 items-center justify-center rounded" style={CHECKER_STYLE}>
              {c.thumb ? (
                <CanvasThumb draw={c.thumb} />
              ) : (
                <span className="px-1 text-center text-[10px] leading-tight text-neutral-500">
                  {c.disabledReason ? "使用できません" : c.note ?? "印影の下に並べます"}
                </span>
              )}
            </span>
            <span className="text-center font-medium leading-snug text-neutral-800 dark:text-neutral-100">{c.label}</span>
          </button>
        ))}
      </div>
      {selected && <p className="text-xs text-neutral-600 dark:text-neutral-300">{selected.description}</p>}
      {choices
        .filter((c) => c.disabledReason)
        .map((c) => (
          <p key={c.id} className="text-xs text-neutral-500 dark:text-neutral-400" data-testid={`qr-design-reason-${c.id}`}>
            {c.label}：{c.disabledReason}
          </p>
        ))}
    </fieldset>
  );
}

/** 見本の印影を、96px四方に縮めて表示する(画面の解像度に合わせて2倍で描く)。表示したあとで draw を呼んで描く */
function CanvasThumb({ draw }: { draw: () => HTMLCanvasElement | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = ref.current;
    const canvas = draw();
    if (!target || !canvas) return;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    const scale = Math.min(target.width / canvas.width, target.height / canvas.height);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, (target.width - w) / 2, (target.height - h) / 2, w, h);
  }, [draw]);
  return <canvas ref={ref} width={192} height={192} aria-hidden="true" className="h-24 w-24" />;
}
