"use client";

import { FilePreview } from "./file-preview";

export function FileList({
  files,
  onRemove,
}: {
  files: File[];
  onRemove?: (index: number) => void;
}) {
  if (files.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {files.map((file, index) => (
        <li key={`${file.name}-${index}`} className="relative">
          <FilePreview file={file} />
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={`${file.name} を削除`}
              className="absolute right-2 top-2 rounded-full bg-neutral-100 p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
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
          )}
        </li>
      ))}
    </ul>
  );
}
