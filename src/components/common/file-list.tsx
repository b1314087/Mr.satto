"use client";

import { FilePreview } from "./file-preview";
import { TrashIcon } from "@/components/ui/trash-icon";

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
              title="削除"
              className="ms-focus-ring absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-ms-border bg-ms-strong text-ms-muted transition-colors hover:text-ms-text hover:bg-ms-hover-tint"
            >
              <TrashIcon className="h-[18px] w-[18px]" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
