"use client";

import { useState } from "react";
import { PdfMergeTool } from "./pdf-merge-tool";
import { PdfSplitTool } from "./pdf-split-tool";
import { PdfDeletePagesTool } from "./pdf-delete-pages-tool";
import { PdfExtractPagesTool } from "./pdf-extract-pages-tool";
import { PdfReorderPagesTool } from "./pdf-reorder-pages-tool";
import { PdfRotateTool } from "./pdf-rotate-tool";
import { PDF_EDIT_MODES, getPdfEditMode, type PdfEditMode } from "@/lib/tools/pdf-edit-modes";
import { useAnnounceToolMode } from "@/lib/guides/tool-mode";

/**
 * PDF編集の総合画面。結合・分割・ページ削除・ページ抽出・並び替え・回転を、操作の切り替えで使い分ける。
 *
 * 各操作の中身は、これまでの個別ツールの画面をそのまま使う（処理も表示も変えない）。
 * この画面が足すのは「操作の切り替え」と「選択中のPDFの引き継ぎ」だけ。
 * - 操作を切り替えると、前の操作の結果・選択・入力はリセットされる（古い結果をダウンロードさせない）。
 * - 選んだPDFは、操作を切り替えても引き継ぐ（2026-11：PDFを入れたあとでも操作を変えられるように）。
 *   結合で複数のPDFを選んでいたときは、1つのPDFを扱う操作には先頭のPDFを渡し、結合に戻ると全部が戻る。
 * - 個別URL（/tools/pdf-split など）で開いたときは、その操作を選んだ状態で表示する（initialMode）。
 * 処理はすべてブラウザ内で行い、PDFは送信しない。
 * 操作の画面は、切り替えたときに読み込みで待たされないよう、まとめて読み込む（個別の動的読み込みにはしない）。
 */


export interface PdfEditToolProps {
  /** 最初に選んでおく操作（個別URLのツールごとに違う） */
  initialMode?: PdfEditMode;
}

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function PdfEditTool({ initialMode = "merge" }: PdfEditToolProps) {
  const [mode, setMode] = useState<PdfEditMode>(initialMode);
  // 使い方の幕に、いま選ばれているモードを知らせる（幕を開くと、このモードの使い方の図が出る）
  useAnnounceToolMode(mode);
  // 操作の間で引き継ぐPDF（結合では全部、1つのPDFを扱う操作では先頭の1つを使う）
  const [sharedFiles, setSharedFiles] = useState<File[]>([]);
  const info = getPdfEditMode(mode);

  const singleFileProps = {
    initialFile: sharedFiles[0] ?? null,
    // 1つのPDFを扱う操作でPDFを選び直したら、先頭を入れ替える（外したら先頭を外す）
    onFileChange: (f: File | null) => setSharedFiles((prev) => (f ? [f, ...prev.slice(1)] : prev.slice(1))),
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="PDFの操作" data-testid="pdf-edit-modes" className="flex flex-wrap gap-2">
          {PDF_EDIT_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`pdf-edit-mode-${m.mode}`}
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="pdf-edit-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
      </div>

      {/* key: 操作を切り替えたら、前の操作の状態（結果・選択・入力）を必ず捨てて作り直す */}
      <div key={mode}>
        {mode === "merge" && <PdfMergeTool initialFiles={sharedFiles} onFilesChange={setSharedFiles} />}
        {mode === "split" && <PdfSplitTool {...singleFileProps} />}
        {mode === "delete" && <PdfDeletePagesTool {...singleFileProps} />}
        {mode === "extract" && <PdfExtractPagesTool {...singleFileProps} />}
        {mode === "reorder" && <PdfReorderPagesTool {...singleFileProps} />}
        {mode === "rotate" && <PdfRotateTool {...singleFileProps} />}
      </div>
    </div>
  );
}
