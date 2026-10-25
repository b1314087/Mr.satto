"use client";

import { useRouter } from "next/navigation";
import { offerPdfHandoff, pdfBlobToFile } from "@/lib/pdf/file-handoff";
import { PDF_FIX_TOOL_ID, PDF_FIX_TOOL_PATH } from "@/lib/tools/pdf-fix-modes";

interface OpenInPdfFixButtonProps {
  /** 引き継ぐ処理結果のPDF（元のファイルではない） */
  blob: Blob;
  /** 引き継ぎ後に表示されるファイル名（ダウンロード時と同じ名前） */
  fileName: string;
  /** 引き継ぎ元の表示名 */
  sourceLabel?: string;
}

/**
 * 処理結果のPDFを、ダウンロード・再アップロードなしで「PDF修正」へ渡すボタン（工程12）。
 * ファイルはブラウザのメモリ上だけで受け渡す（サーバー送信・永続保存なし。仕組みは lib/pdf/file-handoff.ts）。
 */
export function OpenInPdfFixButton({ blob, fileName, sourceLabel = "PDF編集" }: OpenInPdfFixButtonProps) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="open-in-pdf-fix"
        onClick={() => {
          offerPdfHandoff(pdfBlobToFile(blob, fileName), sourceLabel, PDF_FIX_TOOL_ID);
          router.push(PDF_FIX_TOOL_PATH);
        }}
        className="inline-flex items-center gap-2 rounded-lg border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-300 dark:hover:bg-blue-950/30"
      >
        この結果をPDF修正で開く
      </button>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ダウンロードせず、このまま文字入れ・白消し・ページ番号などの修正に進めます（ファイルは送信されません）。
      </p>
    </div>
  );
}
