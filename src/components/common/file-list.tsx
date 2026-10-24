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
              className="ms-focus-ring absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-ms-border bg-ms-strong text-ms-muted transition-colors hover:text-ms-text hover:bg-ms-hover-tint"
            >
              <svg className="h-5 w-5" fill="none" viewBox="3 3 18 18" stroke="currentColor" aria-hidden="true">
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
