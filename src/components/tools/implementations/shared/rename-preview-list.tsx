"use client";

import type { FileRenamePlanItem } from "@/lib/processors/browser/file-ops";

const MAX_ROWS = 200;

/**
 * リネームの「元の名前 → 新しい名前」ライブ一覧。
 * 表示する名前は planFileRenames()（実際のリネーム処理と同じ関数）の結果なので、
 * プレビューどおりの名前で出力される。使えない文字・空欄・重複の警告も出す。
 */
export function RenamePreviewList({
  files,
  plan,
}: {
  files: File[];
  plan: FileRenamePlanItem[];
}) {
  if (files.length === 0 || plan.length !== files.length) return null;

  const warnCount = plan.filter(
    (p) => p.hadForbiddenChars || p.dedupedFromDuplicate
  ).length;

  return (
    <div
      data-testid="tool-preview"
      className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          リネーム後のプレビュー（{files.length}件）
        </p>
        {warnCount > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {warnCount}件に注意があります（下の表示を確認してください）
          </p>
        )}
      </div>
      <ul className="flex flex-col divide-y divide-neutral-200 text-xs dark:divide-neutral-800">
        {files.slice(0, MAX_ROWS).map((file, i) => {
          const p = plan[i];
          const changed = file.name !== p.finalName;
          return (
            <li key={`${file.name}-${i}`} className="flex flex-col gap-0.5 py-1.5">
              <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                <span className="min-w-0 break-all text-neutral-500 sm:flex-1 dark:text-neutral-400">
                  {file.name}
                </span>
                <span aria-hidden className="shrink-0 text-neutral-400">
                  →
                </span>
                <span
                  className={`min-w-0 break-all font-medium sm:flex-1 ${
                    changed
                      ? "text-blue-700 dark:text-blue-300"
                      : "text-neutral-700 dark:text-neutral-200"
                  }`}
                >
                  {p.finalName}
                </span>
              </div>
              {p.hadForbiddenChars && (
                <p className="text-amber-600 dark:text-amber-400">
                  使えない文字（\ / : * ? &quot; &lt; &gt; |）は「_」に置き換えられます
                </p>
              )}
              {p.dedupedFromDuplicate && (
                <p className="text-amber-600 dark:text-amber-400">
                  同じ名前のファイルがあるため、末尾に番号が付きます
                </p>
              )}
              {p.usedOriginalName && (
                <p className="text-neutral-400">名前が空欄のため、元の名前を使います</p>
              )}
            </li>
          );
        })}
        {files.length > MAX_ROWS && (
          <li className="py-1.5 text-neutral-400">他 {files.length - MAX_ROWS} 件…</li>
        )}
      </ul>
    </div>
  );
}
