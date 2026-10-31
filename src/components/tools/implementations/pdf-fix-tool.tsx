"use client";

import Link from "next/link";
import { useState } from "react";
import { PdfFillAnnotateTool } from "./pdf-fill-annotate-tool";
import { PdfAddPageNumbersTool } from "./pdf-add-page-numbers-tool";
import { PdfWatermarkTool } from "./pdf-watermark-tool";
import { PDF_FIX_MODES, getPdfFixMode, type PdfFixMode } from "@/lib/tools/pdf-fix-modes";
import { WHITEOUT_NOTICE } from "@/lib/pdf-annotate/whiteout";

/**
 * PDF修正の総合画面（工程12）。記入・注釈・白消し／ページ番号／透かし を、機能の切り替えで使い分ける。
 *
 * 各機能の中身は、これまでの個別ツールの画面をそのまま使う（処理も表示も変えない）。
 * この画面が足すのは「機能の切り替え」と「選択中のPDFの引き継ぎ（機能を切り替えても同じPDFを使う）」だけ。
 * - 機能を切り替えると、前の機能の結果・入力はリセットされる（古い結果をダウンロードさせない）。選んだPDFだけを引き継ぐ。
 *   ただし「記入・注釈」で配置済みの文字・図形などがある間は、切り替える前に確認を出す
 *   （切り替えると配置したものが消えるため。確認で「編集を続ける」を選べば、編集中の状態はそのまま残る）。
 * - 他のツールからPDFを直接受け取る個別の連携（旧：PDF編集の「この結果をPDF修正で開く」）は工程15で撤去した。
 *   ツール間の受け渡しは、今後すべてのツールで共通の仕組みとして作り直す。
 * 処理はすべてブラウザ内で行い、PDFは送信・保存しない。
 */

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function PdfFixTool() {
  const [mode, setMode] = useState<PdfFixMode>("annotate");
  // 「記入・注釈」で配置済みの編集があるか（画面側から知らせてもらう）
  const [annotateHasEdits, setAnnotateHasEdits] = useState(false);
  // 確認待ちの機能の切り替え先
  const [pending, setPending] = useState<PdfFixMode | null>(null);
  // どの機能でも使う、選択中のPDF（機能を切り替えても引き継ぐ）
  const [sharedFile, setSharedFile] = useState<File | null>(null);
  const info = getPdfFixMode(mode);
  const singleFileProps = { initialFile: sharedFile, onFileChange: setSharedFile };

  // 編集が残っているのは「記入・注釈」を開いている間だけ。それ以外・編集なしのときは、確認なしで切り替える
  const confirming = pending !== null && mode === "annotate" && annotateHasEdits ? pending : null;

  function handleAnnotateDirty(hasEdits: boolean) {
    setAnnotateHasEdits(hasEdits);
    // 編集がなくなったら、残っていた確認待ちも捨てる（あとで編集を始めたときに、古い確認が突然出ないように）
    if (!hasEdits) setPending(null);
  }

  function requestMode(next: PdfFixMode) {
    if (next === mode) return;
    if (mode === "annotate" && annotateHasEdits) {
      setPending(next);
      return;
    }
    setPending(null);
    setMode(next);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="PDFの修正機能" data-testid="pdf-fix-modes" className="flex flex-wrap gap-2">
          {PDF_FIX_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`pdf-fix-mode-${m.mode}`}
              onClick={() => requestMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="pdf-fix-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
      </div>

      {confirming && (
        <div
          role="alertdialog"
          aria-label="機能の切り替えの確認"
          data-testid="pdf-fix-switch-confirm"
          className="flex flex-col gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/20 dark:text-red-200"
        >
          <p>
            {`配置した文字・図形などがあります。「${getPdfFixMode(confirming).label}」に切り替えると、これらは消えます（元に戻せません）。`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="pdf-fix-switch-cancel"
              onClick={() => setPending(null)}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-900 hover:bg-red-100 dark:border-red-800 dark:bg-transparent dark:text-red-200 dark:hover:bg-red-900/30"
            >
              編集を続ける
            </button>
            <button
              type="button"
              data-testid="pdf-fix-switch-confirm-ok"
              onClick={() => {
                const next = confirming;
                setPending(null);
                setMode(next);
              }}
              className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
            >
              消して切り替える
            </button>
          </div>
        </div>
      )}

      {mode === "annotate" && (
        <p
          data-testid="pdf-fix-whiteout-notice"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <span className="font-semibold">{WHITEOUT_NOTICE.title}</span>
          {WHITEOUT_NOTICE.body}
          個人情報などを確実に消したいときは、
          <Link href="/tools/pdf-redact" className="underline">
            PDF黒塗り・墨消し
          </Link>
          を使ってください。
        </p>
      )}

      {/* key: 機能を切り替えたら、前の機能の状態（結果・入力）を必ず捨てて作り直す */}
      <div key={mode}>
        {mode === "annotate" && <PdfFillAnnotateTool {...singleFileProps} onDirtyChange={handleAnnotateDirty} />}
        {mode === "page-numbers" && <PdfAddPageNumbersTool {...singleFileProps} />}
        {mode === "watermark" && <PdfWatermarkTool {...singleFileProps} />}
      </div>
    </div>
  );
}
