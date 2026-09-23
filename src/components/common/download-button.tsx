"use client";

import { downloadBlob } from "@/lib/utils/format";

export function DownloadButton({
  blob,
  filename,
  label = "ダウンロード",
}: {
  blob: Blob;
  filename: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => downloadBlob(blob, filename)}
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 12m0 0l4.5-4.5M12 12V3"
        />
      </svg>
      {label}
    </button>
  );
}
