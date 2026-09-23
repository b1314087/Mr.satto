"use client";

import { FilePreview } from "@/components/common/file-preview";

/**
 * 複数ファイルを「順序が結果に影響する」形で扱うツール
 * （PDF結合・画像→PDF）が共通で使う並び替え可能なファイル一覧。
 * 上下ボタンでの並び替え・個別削除に対応する（ドラッグ&ドロップの
 * 完全な実装はスマートフォンでの操作性確保が難しいため、
 * タップ操作でも確実に使える上下ボタン方式を採用している）。
 */
export function ReorderableFileList({
  files,
  onReorder,
  onRemove,
}: {
  files: File[];
  onReorder: (nextFiles: File[]) => void;
  onRemove: (index: number) => void;
}) {
  if (files.length === 0) return null;

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= files.length) return;
    const next = [...files];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next);
  }

  return (
    <ul className="flex flex-col gap-2">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <FilePreview file={file} />
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={`${file.name} を上へ移動`}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === files.length - 1}
              aria-label={`${file.name} を下へ移動`}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
            >
              ↓
            </button>
          </div>
          <button
            type="button"
            onClick={() => onRemove(index)}
            aria-label={`${file.name} を削除`}
            className="shrink-0 rounded-full bg-neutral-100 p-1.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  );
}
