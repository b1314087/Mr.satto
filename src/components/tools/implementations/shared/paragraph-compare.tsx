"use client";

import type { ReactNode } from "react";
import { PreviewColumn, PreviewColumns } from "@/components/tools/implementations/shared/before-after-table";

/**
 * Word(.docx)の段落テキストを「処理前 → 処理後」で並べて見せる部品。
 * スペースの違い(全角/半角/連続)や空白行が見えるよう、空白を記号で表示する。
 */

export interface ParagraphItem {
  text: string;
  /** 変更される(された)段落 */
  changed?: boolean;
  /** 削除される(された)段落 */
  removed?: boolean;
}

/** 半角スペースを「·」、全角スペースを薄い色の「□」風の背景付きで見せる */
function renderVisibleSpaces(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = "";
  let key = 0;
  const flush = () => {
    if (buffer) {
      nodes.push(buffer);
      buffer = "";
    }
  };
  for (const ch of text) {
    if (ch === " ") {
      flush();
      nodes.push(
        <span key={key++} className="text-neutral-300 dark:text-neutral-600" title="半角スペース">
          ·
        </span>
      );
    } else if (ch === "　") {
      flush();
      nodes.push(
        <span key={key++} className="rounded-sm bg-sky-100 text-sky-400 dark:bg-sky-900/40 dark:text-sky-300" title="全角スペース">
          ＿
        </span>
      );
    } else {
      buffer += ch;
    }
  }
  flush();
  return nodes;
}

export function ParagraphList({ items, maxItems, label }: { items: ParagraphItem[]; maxItems: number; label: string }) {
  const shown = items.slice(0, maxItems);
  return (
    <div className="flex flex-col gap-1">
      <ol aria-label={label} className="flex max-h-96 flex-col gap-1 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
        {shown.length === 0 && <li className="text-neutral-400">表示できる段落がありません</li>}
        {shown.map((item, i) => (
          <li
            key={i}
            className={`whitespace-pre-wrap break-words rounded px-1.5 py-0.5 text-neutral-700 dark:text-neutral-200 ${
              item.removed
                ? "bg-red-100 dark:bg-red-900/30"
                : item.changed
                  ? "bg-amber-100 dark:bg-amber-900/40"
                  : ""
            }`}
          >
            {item.text.trim() === "" ? (
              <span className="italic text-neutral-400">(空白行)</span>
            ) : (
              renderVisibleSpaces(item.text)
            )}
          </li>
        ))}
      </ol>
      {items.length > maxItems && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          先頭{maxItems}段落のみ表示(全{items.length}段落)
        </p>
      )}
    </div>
  );
}

export function ParagraphCompare({
  before,
  after,
  beforeLabel = "処理前",
  afterLabel = "処理後",
  maxItems = 30,
}: {
  before: ParagraphItem[];
  after: ParagraphItem[] | null;
  beforeLabel?: string;
  afterLabel?: string;
  maxItems?: number;
}) {
  return (
    <PreviewColumns>
      <PreviewColumn label={beforeLabel}>
        <ParagraphList items={before} maxItems={maxItems} label={beforeLabel} />
      </PreviewColumn>
      <PreviewColumn label={afterLabel}>
        {after ? (
          <ParagraphList items={after} maxItems={maxItems} label={afterLabel} />
        ) : (
          <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">
            結果を表示できません
          </p>
        )}
      </PreviewColumn>
    </PreviewColumns>
  );
}

/** スペースの凡例 */
export function SpaceLegend() {
  return (
    <p className="text-xs text-neutral-500 dark:text-neutral-400">
      表示の見方: <span className="text-neutral-400">·</span>＝半角スペース、
      <span className="rounded-sm bg-sky-100 text-sky-400 dark:bg-sky-900/40 dark:text-sky-300">＿</span>＝全角スペース
    </p>
  );
}

export function ParagraphLegend({ items }: { items: { kind: "changed" | "removed"; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
      {items.map((item) => (
        <li key={item.kind} className="flex items-center gap-1.5">
          <span
            className={`inline-block h-3 w-3 rounded-sm border border-neutral-300 dark:border-neutral-600 ${
              item.kind === "removed" ? "bg-red-100 dark:bg-red-900/30" : "bg-amber-100 dark:bg-amber-900/40"
            }`}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
