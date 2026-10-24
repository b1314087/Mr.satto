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
    <div className="flex items-center gap-3 rounded-ms-control border border-ms-border bg-ms-surface p-3 pr-12">
      {isImage && url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.name}
          className="h-14 w-14 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-ms-hover-tint text-xl">
          📄
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ms-text">
          {file.name}
        </p>
        <p className="text-xs text-ms-muted">
          {formatBytes(file.size)}
        </p>
      </div>
    </div>
  );
}
