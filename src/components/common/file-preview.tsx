"use client";

import { formatBytes } from "@/lib/utils/format";
import { useObjectUrl } from "@/lib/utils/use-object-url";

export function FilePreview({ file }: { file: File }) {
  const isImage = file.type.startsWith("image/");
  // プレビュー用のURLの作成・解放は共通フックが担当する（開発モードの二重実行でも壊れない）
  const url = useObjectUrl(isImage ? file : null);

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
