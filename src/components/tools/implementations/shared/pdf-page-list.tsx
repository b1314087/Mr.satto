"use client";

/**
 * PDFページ削除・PDFページ並び替えツールが共通で使うページ一覧UI。
 * ページのサムネイル画像は生成せず（pdfjs-distでの全ページレンダリングは
 * 重くなりやすいため）、ページ番号ベースの一覧で操作する。
 */

/** 削除ツール用：ページ番号のチェックリスト */
export function PdfPageCheckList({
  pageCount,
  selected,
  onToggle,
}: {
  pageCount: number;
  selected: Set<number>;
  onToggle: (pageNumber: number) => void;
}) {
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
      {pages.map((pageNumber) => {
        const isSelected = selected.has(pageNumber);
        return (
          <button
            key={pageNumber}
            type="button"
            onClick={() => onToggle(pageNumber)}
            aria-pressed={isSelected}
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 px-2 py-3 text-sm font-medium transition-colors ${
              isSelected
                ? "border-red-500 bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400"
                : "border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
            }`}
          >
            <span>{pageNumber}</span>
            {isSelected && <span className="text-[10px]">削除</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 並び替えツール用：現在の並び順を上下ボタンで操作するリスト */
export function PdfPageOrderList({
  order,
  onReorder,
}: {
  order: number[];
  onReorder: (nextOrder: number[]) => void;
}) {
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next);
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {order.map((pageNumber, index) => (
        <li
          key={`${pageNumber}-${index}`}
          className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <span className="text-neutral-700 dark:text-neutral-200">
            {index + 1}番目 <span className="text-neutral-400">（元ページ {pageNumber}）</span>
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={`${index + 1}番目を上へ移動`}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === order.length - 1}
              aria-label={`${index + 1}番目を下へ移動`}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
            >
              ↓
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
