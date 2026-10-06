"use client";

import { useEffect, useMemo, useState } from "react";
import { DocumentBasicForm } from "./shared/document-basic-form";
import { PartyInfoForm } from "./shared/party-info-form";
import { LineItemsEditor } from "./shared/line-items-editor";
import { TaxSettings } from "./shared/tax-settings";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { createEmptyDocumentForm, type DocumentFormState } from "@/lib/documents/types";
import { validateDocumentForm } from "@/lib/documents/validation";
import {
  layoutQuoteOrder,
  overflowMessage,
  PAGE_H,
  PAGE_W,
  type MeasureFn,
} from "@/lib/documents/quote-order-layout";
import {
  QuoteOrderPdfProcessor,
  buildQuoteOrderFileName,
  type QuoteOrderPdfOutput,
} from "@/lib/processors/browser/quote-order-pdf";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

const inputClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

/** プレビュー用の文字幅の近似(全角=文字サイズ、半角=0.55倍)。PDFでは埋め込みフォントの実測幅を使う */
const approxMeasure: MeasureFn = (text, size) => {
  let w = 0;
  for (const ch of Array.from(text)) w += ch.charCodeAt(0) < 0x250 ? size * 0.55 : size;
  return w;
};

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{children}</h2>;
}

/**
 * 見積書・注文書一体型。1回の入力で、A4 1枚の上半分に見積書、下半分に注文書を作る。
 * 注文書側は、宛先=自社(発行者)、注文者=見積書の宛先(お客様)に自動で入れ替わる。
 */
export function QuoteOrderGeneratorTool() {
  const [form, setForm] = useState<DocumentFormState>(() => createEmptyDocumentForm("estimate"));
  const [deliveryDate, setDeliveryDate] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuoteOrderPdfOutput | null>(null);

  function patch(p: Partial<DocumentFormState>) {
    setForm((prev) => ({ ...prev, ...p }));
  }

  const layout = useMemo(
    () => layoutQuoteOrder(form, { deliveryDate }, approxMeasure),
    [form, deliveryDate]
  );
  const warning = overflowMessage(layout);
  const preValidationError = validateDocumentForm(form);

  // 生成結果のObject URLは、次の結果に置き換わるとき・画面を閉じるときに解放する
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new QuoteOrderPdfProcessor().process({ form, extra: { deliveryDate } });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFの生成に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        1回の入力で、A4の1枚に「上=見積書」「下=注文書」を作ります。お客様が注文書の欄に署名・捺印して返送すれば、そのまま注文の控えになります。入力内容はこの画面上でPDFを作るためだけに使われ、サーバーへの送信・保存は行われません。
      </p>

      <section className="flex flex-col gap-3">
        <Heading>① 基本情報（見積書・注文書に共通）</Heading>
        <DocumentBasicForm form={form} onChange={patch} />
        <label className="flex flex-col gap-1.5 text-sm sm:max-w-sm">
          注文書に入れる納期（任意）
          <input
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            placeholder="例: 2026年11月30日 / 受注後2週間"
            className={inputClass}
          />
        </label>
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Heading>② 宛先（お客様）</Heading>
          <PartyInfoForm label="宛先情報" party={form.recipient} onChange={(recipient) => patch({ recipient })} />
        </div>
        <div className="flex flex-col gap-3">
          <Heading>③ 発行者（自社情報）</Heading>
          <PartyInfoForm label="発行者情報" party={form.issuer} onChange={(issuer) => patch({ issuer })} />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>④ 明細</Heading>
        <LineItemsEditor items={form.items} onChange={(items) => patch({ items })} />
      </section>

      <section className="flex flex-col gap-3">
        <Heading>⑤ 税・金額</Heading>
        <TaxSettings taxRatePercent={form.taxRatePercent} taxRounding={form.taxRounding} onChange={patch} />
      </section>

      <section className="flex flex-col gap-3">
        <Heading>⑥ プレビュー（上が見積書・下が注文書）</Heading>
        {warning && (
          <p data-testid="quote-order-overflow" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {warning}
          </p>
        )}
        <div data-testid="tool-preview" className="mx-auto w-full max-w-xl rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-700">
          <svg viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} role="img" aria-label="見積書・注文書のプレビュー" className="block w-full">
            <rect x={0} y={0} width={PAGE_W} height={PAGE_H} fill="#fff" />
            {layout.ops.map((op, i) => {
              const c = (rgb: [number, number, number]) =>
                `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
              if (op.kind === "rect") {
                return (
                  <rect
                    key={i}
                    x={op.x}
                    y={op.y}
                    width={op.w}
                    height={op.h}
                    fill={op.fill ? c(op.fill) : "none"}
                    stroke={op.stroke ? c(op.stroke) : "none"}
                    strokeWidth={0.75}
                  />
                );
              }
              if (op.kind === "line") {
                return (
                  <line
                    key={i}
                    x1={op.x1}
                    y1={op.y1}
                    x2={op.x2}
                    y2={op.y2}
                    stroke={c(op.color)}
                    strokeWidth={0.75}
                    strokeDasharray={op.dashed ? "4 3" : undefined}
                  />
                );
              }
              return (
                <text
                  key={i}
                  x={op.x}
                  y={op.y}
                  fontSize={op.size}
                  fill={c(op.color)}
                  textAnchor={op.align === "right" ? "end" : op.align === "center" ? "middle" : "start"}
                  fontFamily="'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif"
                >
                  {op.text}
                </text>
              );
            })}
          </svg>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          プレビューの文字の幅は目安です。実際のPDFでは、折り返し位置が少し変わることがあります。
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <Heading>⑦ PDF出力</Heading>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={status === "processing"}
          title={preValidationError ?? undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {status === "processing" ? "作成中..." : "見積書・注文書を作成する"}
        </button>
        <ProcessingStatus state={status} processingLabel="PDFを作成中..." successLabel="PDFを作成しました" />
        {error && <ErrorMessage message={error} />}
        {result && (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">1ページ ・ {formatBytes(result.sizeBytes)}</p>
            <RewardedDownloadGate
              onDownload={() => downloadBlob(result.blob, buildQuoteOrderFileName(form))}
              label="PDFをダウンロード"
            />
            <button
              type="button"
              onClick={() => window.open(result.url, "_blank", "noopener,noreferrer")}
              className="text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            >
              新しいタブでPDFを開く（印刷はこちらから）
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
