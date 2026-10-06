"use client";

import type { ReactNode } from "react";
import type { XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

/**
 * 表(CSV/Excel)の「処理前 → 処理後」を並べて見せるプレビュー部品。
 * 変更されるセル・削除される行/列・対象範囲を色で示す。
 * table-fixed + truncate で、列数が多くてもスマートフォンで横スクロールを出さない。
 */

/** プレビュー計算の対象にする最大行数(これを超えるファイルは先頭だけで計算して表示する) */
export const PREVIEW_COMPUTE_ROWS = 3000;

export type GridMark = "changed" | "removed" | "target";

export interface GridCell {
  text: string;
  mark?: GridMark;
  /** 結合セル(横方向)。結合で隠れるセルは行の配列に含めない */
  colSpan?: number;
  align?: "left" | "center";
  vAlign?: "top" | "middle";
}

const MARK_CLASS: Record<GridMark, string> = {
  changed: "bg-amber-100 dark:bg-amber-900/40",
  removed: "bg-red-100 text-red-700 line-through dark:bg-red-900/30 dark:text-red-300",
  target: "bg-blue-100 dark:bg-blue-900/40",
};

/** Excelのセル値を表示用の文字列にする(日付はyyyy-mm-dd) */
export function xlsxCellToText(value: XlsxCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** 文字列の二次元配列をGridCellの行列にする(mark でセルごとの色を決める) */
export function toGridRows(
  rows: string[][],
  mark?: (row: number, col: number, text: string) => GridMark | undefined
): GridCell[][] {
  return rows.map((row, r) => row.map((text, c) => ({ text, mark: mark?.(r, c, text) })));
}

/** Excelのセル値の二次元配列を文字列の二次元配列にする(列数をそろえる) */
export function xlsxRowsToText(rows: XlsxCellValue[][], minCols = 0): string[][] {
  const cols = rows.reduce((max, r) => Math.max(max, r.length), minCols);
  return rows.map((row) => Array.from({ length: cols }, (_, c) => xlsxCellToText(row[c])));
}

export function PreviewGrid({
  rows,
  maxRows = 10,
  maxCols = 6,
  headerRow = true,
  ariaLabel,
  totalRows,
  rowLabels,
}: {
  rows: GridCell[][];
  maxRows?: number;
  maxCols?: number;
  headerRow?: boolean;
  ariaLabel?: string;
  /** rows が先頭だけを渡したものの場合の、全体の行数(「全N行」の表示用) */
  totalRows?: number;
  /** 各行の左に出す行番号(Excelの行番号など)。rows と同じ並び */
  rowLabels?: (string | number)[];
}) {
  if (rows.length === 0) {
    return <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">表示できる行がありません</p>;
  }
  const spanOf = (row: GridCell[]) => row.reduce((sum, cell) => sum + (cell.colSpan ?? 1), 0);
  const shown = rows.slice(0, maxRows);
  const totalCols = shown.reduce((max, row) => Math.max(max, spanOf(row)), 1);
  const colCount = Math.min(maxCols, totalCols);
  const rowTotal = totalRows ?? rows.length;

  return (
    <div className="flex flex-col gap-1" aria-label={ariaLabel}>
      <table className="w-full table-fixed border-collapse overflow-hidden rounded-lg border border-neutral-200 text-xs dark:border-neutral-800">
        <tbody>
          {shown.map((row, i) => {
            const cells: ReactNode[] = [];
            let used = 0;
            for (let c = 0; c < row.length && used < colCount; c++) {
              const cell = row[c];
              const span = Math.min(cell.colSpan ?? 1, colCount - used);
              used += span;
              cells.push(
                <td
                  key={c}
                  colSpan={span}
                  title={cell.text}
                  style={{ whiteSpace: "pre" }}
                  className={`overflow-hidden text-ellipsis border border-neutral-200 px-2 py-1 dark:border-neutral-800 ${
                    cell.mark === "removed" ? "" : "text-neutral-700 dark:text-neutral-200"
                  } ${
                    cell.align === "center" ? "text-center" : ""
                  } ${cell.vAlign === "middle" ? "align-middle" : "align-top"} ${cell.mark ? MARK_CLASS[cell.mark] : ""}`}
                >
                  {cell.text}
                </td>
              );
            }
            while (used < colCount) {
              cells.push(<td key={`pad-${used}`} className="border border-neutral-200 dark:border-neutral-800" />);
              used++;
            }
            return (
              <tr key={i} className={headerRow && i === 0 ? "bg-neutral-100 font-medium dark:bg-neutral-800" : ""}>
                {rowLabels && (
                  <th
                    scope="row"
                    style={{ width: "2.5rem" }}
                    className="border border-neutral-200 bg-neutral-50 px-1 py-1 text-center text-[10px] font-normal text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900"
                  >
                    {rowLabels[i]}
                  </th>
                )}
                {cells}
              </tr>
            );
          })}
        </tbody>
      </table>
      {(rowTotal > maxRows || totalCols > maxCols) && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          {rowTotal > maxRows ? `先頭${maxRows}行` : "全行"}
          {totalCols > maxCols ? `・先頭${maxCols}列` : ""}のみ表示(全{rowTotal}行
          {totalCols > maxCols ? `・全${totalCols}列` : ""})
        </p>
      )}
    </div>
  );
}

/** 凡例(色の意味) */
export function PreviewLegend({ items }: { items: { mark: GridMark; label: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
      {items.map((item) => (
        <li key={item.mark} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-3 rounded-sm border border-neutral-300 dark:border-neutral-600 ${MARK_CLASS[item.mark].split(" ").filter((c) => c.startsWith("bg-") || c.startsWith("dark:bg-")).join(" ")}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** プレビューの外枠。ルートに data-testid="tool-preview" を持つ */
export function PreviewShell({
  title,
  summary,
  children,
  legend,
  notes,
  loading = false,
}: {
  title: string;
  summary?: ReactNode;
  children?: ReactNode;
  legend?: { mark: GridMark; label: string }[];
  notes?: ReactNode[];
  loading?: boolean;
}) {
  return (
    <section
      aria-label={title}
      data-testid="tool-preview"
      className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{title}</p>
      {summary && <div className="text-xs text-neutral-600 dark:text-neutral-300">{summary}</div>}
      {loading && <p className="text-xs text-neutral-400">読み込み中…</p>}
      {children}
      {legend && <PreviewLegend items={legend} />}
      {notes?.map((note, i) => (
        <p key={i} className="text-xs text-neutral-400 dark:text-neutral-500">
          {note}
        </p>
      ))}
    </section>
  );
}

/** ラベル付きの1カラム(処理前/処理後など)。md以上で2列に並べる */
export function PreviewColumns({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>;
}

export function PreviewColumn({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</p>
      {children}
    </div>
  );
}

/** 変換結果などの文字列を等幅で表示する(長い場合は先頭の行だけ) */
export function PreviewText({ text, maxLines = 14, label }: { text: string; maxLines?: number; label?: string }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).join("\n");
  return (
    <div className="flex flex-col gap-1">
      <pre
        aria-label={label}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
      >
        {shown}
      </pre>
      {lines.length > maxLines && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          先頭{maxLines}行のみ表示(全{lines.length}行)
        </p>
      )}
    </div>
  );
}

/** 警告・エラー(処理後に出せないときの理由)を表示する */
export function PreviewNotice({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      {message}
    </p>
  );
}

/** 変更のあった行を優先して表示するための行インデックス(見出し行+変更行。無ければ先頭から) */
export function pickPreviewRowIndexes(changedRows: Set<number>, total: number, max: number): number[] {
  if (changedRows.size === 0) return Array.from({ length: Math.min(total, max) }, (_, i) => i);
  const picked = [0];
  for (let i = 1; i < total && picked.length < max; i++) {
    if (changedRows.has(i)) picked.push(i);
  }
  return picked;
}

/**
 * 処理前・処理後の表を並べるプレビュー枠。ルートに data-testid="tool-preview" を持つ。
 * after を省略すると処理前だけ(読み込み中・設定不足など)。afterError があれば処理後の代わりに表示する。
 */
export function BeforeAfterPreview({
  title = "処理前後のプレビュー",
  summary,
  before,
  after,
  afterError,
  beforeLabel = "処理前",
  afterLabel = "処理後",
  legend,
  notes,
  maxRows = 10,
  maxCols = 6,
  headerRow = true,
  loading = false,
  extra,
  totalRows,
  afterTotalRows,
  header,
  beforeRowLabels,
  afterRowLabels,
}: {
  title?: string;
  summary?: ReactNode;
  before: GridCell[][] | null;
  after?: GridCell[][] | null;
  afterError?: string | null;
  beforeLabel?: string;
  afterLabel?: string;
  legend?: { mark: GridMark; label: string }[];
  notes?: ReactNode[];
  maxRows?: number;
  maxCols?: number;
  headerRow?: boolean;
  loading?: boolean;
  extra?: ReactNode;
  /** before/after が先頭だけの場合の全体の行数(「全N行」の表示用) */
  totalRows?: number;
  /** 処理後の全体の行数(省略すると totalRows と同じ) */
  afterTotalRows?: number;
  /** 表の上に出す部品(シートタブなど) */
  header?: ReactNode;
  beforeRowLabels?: (string | number)[];
  afterRowLabels?: (string | number)[];
}) {
  return (
    <PreviewShell title={title} summary={summary} legend={legend} notes={notes} loading={loading}>
      {header}
      {!before && afterError && <PreviewNotice message={afterError} />}
      {before && (
        <PreviewColumns>
          <PreviewColumn label={beforeLabel}>
            <PreviewGrid rows={before} maxRows={maxRows} maxCols={maxCols} headerRow={headerRow} totalRows={totalRows} rowLabels={beforeRowLabels} />
          </PreviewColumn>
          <PreviewColumn label={afterLabel}>
            {afterError ? (
              <PreviewNotice message={afterError} />
            ) : after ? (
              <PreviewGrid rows={after} maxRows={maxRows} maxCols={maxCols} headerRow={headerRow} totalRows={afterTotalRows ?? totalRows} rowLabels={afterRowLabels} />
            ) : (
              <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">
                設定を入力すると、ここに結果が表示されます
              </p>
            )}
          </PreviewColumn>
        </PreviewColumns>
      )}
      {extra}
    </PreviewShell>
  );
}

/** プレビュー計算用に、各シートの行数を先頭 PREVIEW_COMPUTE_ROWS 行までにする */
export function limitSheetRows<T extends { rows: unknown[] }>(
  sheets: T[]
): { sheets: T[]; limited: boolean } {
  const limited = sheets.some((s) => s.rows.length > PREVIEW_COMPUTE_ROWS);
  if (!limited) return { sheets, limited };
  return {
    sheets: sheets.map((s) => (s.rows.length > PREVIEW_COMPUTE_ROWS ? { ...s, rows: s.rows.slice(0, PREVIEW_COMPUTE_ROWS) } : s)),
    limited,
  };
}

/** プレビューするシートの切り替えタブ(シートが1枚のときは何も出さない) */
export function SheetTabs({
  names,
  active,
  onChange,
}: {
  names: string[];
  active: number;
  onChange: (index: number) => void;
}) {
  if (names.length <= 1) return null;
  return (
    <div role="tablist" aria-label="プレビューするシート" className="flex flex-wrap gap-1">
      {names.map((name, i) => (
        <button
          key={`${name}-${i}`}
          type="button"
          role="tab"
          aria-selected={i === active}
          onClick={() => onChange(i)}
          className={`rounded-md px-2.5 py-1 text-xs ${
            i === active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          }`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
