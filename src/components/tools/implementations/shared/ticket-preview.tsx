"use client";

import { useState } from "react";
import { create as createQr } from "qrcode";
import JsBarcode from "jsbarcode";
import { approxWrap } from "./approx-text";
import { computeFixedSizeGrid } from "@/lib/processors/browser/image-layout";
import { mmToPt, resolvePaperSizePt } from "@/lib/print/paper-sizes";
import { validateTicketVoucherInput, type TicketVoucherInput } from "@/lib/processors/browser/ticket-voucher";

/**
 * 整理券・金券・引換券のプレビュー。
 * ticket-voucher.ts（PDF生成）と同じ用紙サイズ・グリッド計算（computeFixedSizeGrid）・
 * 文字の配置（pt単位）を使い、用紙1ページ分をそのままSVGで表示する。
 * （フォントは近似。QRは同じ qrcode ライブラリ、バーコードは同じ jsbarcode で生成。）
 */

const COLOR_TEXT = "#212126";
const COLOR_MUTED = "#73737a";

function applySerialTemplate(template: string, serial: number, digits: number): string {
  if (!template.includes("{n}")) return template;
  return template.replaceAll("{n}", String(serial).padStart(Math.max(1, digits), "0"));
}

const barcodeCache = new Map<string, string | null>();

/** バーコード画像(data URL)。内容ごとにキャッシュする。SSR時(document無し)は null */
function getBarcodeDataUrl(text: string): string | null {
  if (typeof document === "undefined") return null;
  if (barcodeCache.has(text)) return barcodeCache.get(text) ?? null;
  const url = renderBarcodeDataUrl(text);
  if (barcodeCache.size > 500) barcodeCache.clear();
  barcodeCache.set(text, url);
  return url;
}

function renderBarcodeDataUrl(text: string): string | null {
  try {
    const canvas = document.createElement("canvas");
    JsBarcode(canvas, text, { format: "CODE128", displayValue: false, margin: 4, height: 60, width: 2 });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function QrMark({ content, x, y, size }: { content: string; x: number; y: number; size: number }) {
  let qr;
  try {
    qr = createQr(content, { errorCorrectionLevel: "M" });
  } catch {
    return null;
  }
  const n = qr.modules.size;
  const unit = size / (n + 2); // 余白(margin=1)を含めた全体を size に収める
  const rects = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        rects.push(
          <rect key={`${r}-${c}`} x={x + (c + 1) * unit} y={y + (r + 1) * unit} width={unit + 0.01} height={unit + 0.01} fill="#000" />
        );
      }
    }
  }
  return <g>{rects}</g>;
}

export function TicketPreview({ form }: { form: TicketVoucherInput }) {
  const [page, setPage] = useState(0);

  const valid = validateTicketVoucherInput(form) === null;
  const pageSize = resolvePaperSizePt(form.paperSizeId, form.orientation);
  const cellWPt = mmToPt(form.cellWidthMm);
  const cellHPt = mmToPt(form.cellHeightMm);
  const cells = valid
    ? computeFixedSizeGrid({
        canvasWidthPx: pageSize.width,
        canvasHeightPx: pageSize.height,
        marginPx: mmToPt(form.marginMm),
        gapPx: mmToPt(form.gapMm),
        cellWidthPx: cellWPt,
        cellHeightPx: cellHPt,
      })
    : [];
  const perPage = cells.length;
  const pageCount = perPage > 0 ? Math.ceil(form.count / perPage) : 0;
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const firstIndex = safePage * perPage;
  const pageCells = cells.slice(0, Math.max(0, Math.min(perPage, form.count - firstIndex)));

  // PDFと同じく幅20mm超のときだけバーコードを描画する
  const barcodeEnabled = form.showBarcode && cellWPt > mmToPt(20);

  if (!valid) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">入力内容を修正すると、ここにプレビューが表示されます。</p>;
  }
  if (perPage === 0) {
    return (
      <p className="text-sm text-amber-600 dark:text-amber-400">
        この用紙サイズ・余白では券が1枚も配置できません。サイズまたは余白を見直してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <span>
          1ページに{perPage}枚 ／ 全{form.count}枚 ＝ {pageCount}ページ
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              className="rounded-md bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800"
            >
              前のページ
            </button>
            <span className="tabular-nums">
              {safePage + 1} / {pageCount}ページ
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-md bg-neutral-100 px-2 py-1 disabled:opacity-40 dark:bg-neutral-800"
            >
              次のページ
            </button>
          </div>
        )}
      </div>

      <svg
        viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
        role="img"
        aria-label="券の印刷イメージ"
        className="mx-auto block w-full max-w-xl border border-neutral-300 bg-white shadow-sm"
        style={{ fontFamily: "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif" }}
      >
        <rect x={0} y={0} width={pageSize.width} height={pageSize.height} fill="#fff" />
        {pageCells.map((cell, i) => {
          const serial = form.serialStart + firstIndex + i;
          const { x: left, y: top, width: w, height: h } = cell;
          const pad = Math.min(w, h) * 0.06;
          let y = top + pad + 10;
          const texts: React.ReactNode[] = [];
          if (form.title.trim()) {
            for (const line of approxWrap(form.title, 12, w - pad * 2).slice(0, 2)) {
              texts.push(<text key={`t${y}`} x={left + pad} y={y} fontSize={12} fill={COLOR_TEXT}>{line}</text>);
              y += 15;
            }
          }
          if (form.date.trim()) {
            texts.push(<text key="d" x={left + pad} y={y} fontSize={8} fill={COLOR_MUTED}>{form.date}</text>);
            y += 12;
          }
          if (form.amount.trim()) {
            texts.push(<text key="a" x={left + pad} y={y} fontSize={16} fill={COLOR_TEXT}>{form.amount}</text>);
            y += 20;
          }
          if (form.freeText.trim()) {
            for (const line of approxWrap(form.freeText, 8, w - pad * 2).slice(0, 3)) {
              texts.push(<text key={`f${y}`} x={left + pad} y={y} fontSize={8} fill={COLOR_MUTED}>{line}</text>);
              y += 11;
            }
          }
          if (form.showSerial) {
            texts.push(
              <text key="s" x={left + pad} y={top + h - pad - 8} fontSize={8} fill={COLOR_MUTED}>
                {`No. ${String(serial).padStart(Math.max(1, form.serialDigits), "0")}`}
              </text>
            );
          }
          const codeSize = Math.min(w, h) * 0.28;
          const barcodeContent = applySerialTemplate(form.barcodeContent || "{n}", serial, form.serialDigits);
          const barcodeUrl = barcodeEnabled ? getBarcodeDataUrl(barcodeContent) : null;
          const bh = Math.min(h * 0.18, 28);
          return (
            <g key={i}>
              {form.showCutLines && (
                <rect x={left} y={top} width={w} height={h} fill="none" stroke={COLOR_MUTED} strokeWidth={0.5} strokeDasharray="3 2" />
              )}
              {texts}
              {form.showQr && codeSize > 8 && (
                <QrMark
                  content={applySerialTemplate(form.qrContent || "{n}", serial, form.serialDigits)}
                  x={left + w - pad - codeSize}
                  y={top + pad}
                  size={codeSize}
                />
              )}
              {barcodeUrl && (
                <image href={barcodeUrl} x={left + pad} y={top + h - pad - bh} width={w - pad * 2} height={bh} preserveAspectRatio="none" />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
