"use client";

import { useEffect, useMemo } from "react";
import { formatBytes } from "@/lib/utils/format";

export function FilePreview({ file }: { file: File }) {
  const isImage = file.type.startsWith("image/");
  // オブジェクトURLはレンダー中に同期的に生成し、破棄だけをEffectで行う
  const url = useMemo(() => (isImage ? URL.createObjectURL(file) : null), [file, isImage]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      {isImage && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="h-14 w-14 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-xl dark:bg-neutral-800">
          📄
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
          {file.name}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {formatBytes(file.size)}
        </p>
      </div>
    </div>
  );
}
