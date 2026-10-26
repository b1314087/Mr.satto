"use client";

import { useRouter } from "next/navigation";
import { PDF_HANDOFF_MAX_SIZE_MB, canHandoffPdfSize, offerPdfHandoff, pdfBlobToFile } from "@/lib/pdf/file-handoff";
import { PDF_FIX_TOOL_ID, PDF_FIX_TOOL_PATH } from "@/lib/tools/pdf-fix-modes";
import { formatBytes } from "@/lib/utils/format";

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
 * 受け取り側（PDF修正）は、ファイル選択と同じ上限（50MB）で確認する。上限を超える結果は、渡す前にここで案内する
 * （押したあとで受け取り側に断られる、という食い違いをなくすため）。受け取り側の確認は、これとは別に残してある。
 */
export function OpenInPdfFixButton({ blob, fileName, sourceLabel = "PDF編集" }: OpenInPdfFixButtonProps) {
  const router = useRouter();
  if (!canHandoffPdfSize(blob.size)) {
    return (
      <p data-testid="open-in-pdf-fix-unavailable" className="text-xs text-neutral-500 dark:text-neutral-400">
        {blob.size > 0
          ? `この結果は${PDF_HANDOFF_MAX_SIZE_MB}MBを超えている（${formatBytes(blob.size)}）ため、PDF修正へは引き継げません。ダウンロードしてお使いください。`
          : "この結果のサイズを確認できなかったため、PDF修正へは引き継げません。"}
      </p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="open-in-pdf-fix"
        onClick={() => {
          if (!canHandoffPdfSize(blob.size)) return;
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
