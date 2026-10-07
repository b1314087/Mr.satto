"use client";

import { useState } from "react";
import { create as createQr } from "qrcode";
import JsBarcode from "jsbarcode";
import { approxWidth } from "./approx-text";
import { computeFixedSizeGrid } from "@/lib/processors/browser/image-layout";
import { mmToPt, resolvePaperSizePt } from "@/lib/print/paper-sizes";
import { validateTicketVoucherInput, type TicketVoucherInput } from "@/lib/processors/browser/ticket-voucher";
import { buildTickets, layoutTicket } from "@/lib/tickets/ticket-layout";

/**
 * 整理券・金券・引換券のプレビュー。
 * ticket-voucher.ts（PDF生成）と同じ用紙サイズ・グリッド計算（computeFixedSizeGrid）・
 * 文字の配置（pt単位）を使い、用紙1ページ分をそのままSVGで表示する。
 * （フォントは近似。QRは同じ qrcode ライブラリ、バーコードは同じ jsbarcode で生成。）
 */

const COLOR_TEXT = "#212126";
const COLOR_MUTED = "#73737a";

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
  const tickets = valid ? buildTickets(form) : [];
  const perPage = cells.length;
  const pageCount = perPage > 0 ? Math.ceil(tickets.length / perPage) : 0;
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const firstIndex = safePage * perPage;
  const pageCells = cells.slice(0, Math.max(0, Math.min(perPage, tickets.length - firstIndex)));

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
          1ページに{perPage}枚 ／ 全{tickets.length}枚 ＝ {pageCount}ページ
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
          const ticket = tickets[firstIndex + i];
          const ops = layoutTicket(
            { w: cell.width, h: cell.height, showSerial: form.showSerial, showCutLines: form.showCutLines, codes: form.codes, ticket },
            approxWidth
          );
          return (
            <g key={i} transform={`translate(${cell.x} ${cell.y})`}>
              {ops.map((op, j) => {
                if (op.kind === "cutRect") {
                  return <rect key={j} x={op.x} y={op.y} width={op.w} height={op.h} fill="none" stroke={COLOR_MUTED} strokeWidth={0.5} strokeDasharray="3 2" />;
                }
                if (op.kind === "text") {
                  return (
                    <text key={j} x={op.x} y={op.y} fontSize={op.size} fill={op.size >= 12 ? COLOR_TEXT : COLOR_MUTED}>
                      {op.text}
                    </text>
                  );
                }
                if (op.kind === "qr") {
                  return <QrMark key={j} content={op.content} x={op.x} y={op.y} size={op.size} />;
                }
                const url = getBarcodeDataUrl(op.content);
                return url ? <image key={j} href={url} x={op.x} y={op.y} width={op.w} height={op.h} preserveAspectRatio="none" /> : null;
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
