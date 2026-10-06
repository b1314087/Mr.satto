"use client";

import { useState } from "react";
import { approxWrap } from "./approx-text";
import { mmToPt, resolvePaperSizePt } from "@/lib/print/paper-sizes";
import type { RosterColumnSetting } from "@/lib/processors/browser/roster-template";

/**
 * 名簿テンプレートのプレビュー。
 * roster-template.ts（PDF出力）と同じA4・余白15mm・列幅/行高さ(mm→pt)・改ページ位置・
 * 見出し行の繰り返しで、1ページ分をそのままSVGに描く。Excel出力も同じ列構成・列幅。
 * （フォントは近似のため、折り返し位置が実際のPDFと少し異なることがあります。）
 */

const PAGE_MARGIN_MM = 15;

export function RosterPreview({
  headers,
  rows,
  columns,
  rowHeightMm,
  headerHeightMm,
}: {
  headers: string[];
  rows: string[][];
  columns: RosterColumnSetting[];
  rowHeightMm: number;
  headerHeightMm: number;
}) {
  const [page, setPage] = useState(0);

  const pageSize = resolvePaperSizePt("A4", "portrait");
  const margin = mmToPt(PAGE_MARGIN_MM);
  const headerH = mmToPt(headerHeightMm);
  const rowH = mmToPt(rowHeightMm);

  if (!(headerH > 0) || !(rowH > 0) || columns.some((c) => !(c.widthMm > 0))) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">列幅・高さを正しく入力すると、プレビューが表示されます。</p>;
  }

  const widths = columns.map((c) => mmToPt(c.widthMm));
  const xs: number[] = [];
  let acc = margin;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }
  const right = acc;
  const overflow = right > pageSize.width - margin + 0.01;
  const colIdx = columns.map((c) => headers.indexOf(c.sourceHeader));

  const rowsPerPage = Math.max(1, Math.floor((pageSize.height - margin * 2 - headerH) / rowH + 1e-9));
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage);

  const lineColor = "#999a9e";
  const thin = "#cccdd1";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <span>
          A4縦 ／ 1ページ{rowsPerPage}行 ／ 全{rows.length}行 ＝ {pageCount}ページ
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
      {overflow && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          列幅の合計がA4の印刷可能幅を超えています（PDFは作成できません。Excelは作成できます）。
        </p>
      )}

      <svg
        viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
        role="img"
        aria-label="名簿の印刷イメージ"
        className="mx-auto block w-full max-w-xl border border-neutral-300 bg-white shadow-sm"
        style={{ fontFamily: "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif" }}
      >
        <rect x={0} y={0} width={pageSize.width} height={pageSize.height} fill="#fff" />
        {/* 見出し行（各ページの先頭に繰り返し） */}
        <rect x={margin} y={margin} width={right - margin} height={headerH} fill="#eef1f6" />
        {columns.map((c, i) => {
          const lines = approxWrap(c.label, 9, widths[i] - 6);
          const startY = margin + headerH / 2 - ((lines.length - 1) * 11) / 2 + 3;
          return lines.map((line, li) => (
            <text key={`h${i}-${li}`} x={xs[i] + widths[i] / 2} y={startY + li * 11} fontSize={9} textAnchor="middle" fill="#212126">
              {line}
            </text>
          ));
        })}
        {[...xs, right].map((x, i) => (
          <line key={`hv${i}`} x1={x} y1={margin} x2={x} y2={margin + headerH} stroke={lineColor} strokeWidth={0.75} />
        ))}
        <line x1={margin} y1={margin} x2={right} y2={margin} stroke={lineColor} strokeWidth={0.75} />
        <line x1={margin} y1={margin + headerH} x2={right} y2={margin + headerH} stroke={lineColor} strokeWidth={0.75} />

        {/* データ行 */}
        {pageRows.map((row, ri) => {
          const top = margin + headerH + ri * rowH;
          return (
            <g key={ri}>
              {columns.map((_, i) => {
                const idx = colIdx[i];
                const value = idx >= 0 ? (row[idx] ?? "") : "";
                const lines = approxWrap(value, 9, widths[i] - 6).slice(0, 3);
                const startY = top + rowH / 2 - ((lines.length - 1) * 11) / 2 + 3;
                return lines.map((line, li) => (
                  <text key={`c${i}-${li}`} x={xs[i] + 4} y={startY + li * 11} fontSize={9} fill="#212126">
                    {line}
                  </text>
                ));
              })}
              {[...xs, right].map((x, i) => (
                <line key={`v${i}`} x1={x} y1={top} x2={x} y2={top + rowH} stroke={thin} strokeWidth={0.5} />
              ))}
              <line x1={margin} y1={top + rowH} x2={right} y2={top + rowH} stroke={thin} strokeWidth={0.5} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
