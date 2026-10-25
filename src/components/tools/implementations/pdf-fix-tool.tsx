"use client";

import { useEffect, useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { PdfFillAnnotateTool } from "./pdf-fill-annotate-tool";
import { PdfAddPageNumbersTool } from "./pdf-add-page-numbers-tool";
import { PdfWatermarkTool } from "./pdf-watermark-tool";
import { PDF_FIX_MODES, PDF_FIX_TOOL_ID, getPdfFixMode, type PdfFixMode } from "@/lib/tools/pdf-fix-modes";
import { takePdfHandoff, validateHandoffFile } from "@/lib/pdf/file-handoff";
import { WHITEOUT_NOTICE } from "@/lib/pdf-annotate/whiteout";
import { formatBytes } from "@/lib/utils/format";

/**
 * PDF修正の総合画面（工程12）。記入・注釈・白消し／ページ番号／透かし を、機能の切り替えで使い分ける。
 *
 * 各機能の中身は、これまでの個別ツールの画面をそのまま使う（処理も表示も変えない）。
 * この画面が足すのは「機能の切り替え」「選択中のPDFの引き継ぎ」「他のツール（PDF編集）からの処理結果の受け取り」だけ。
 * - 機能を切り替えると、前の機能の結果・入力はリセットされる（古い結果をダウンロードさせない）。選んだPDFだけを引き継ぐ。
 * - PDF編集から「PDF修正で開く」で渡されたPDFは、ブラウザのメモリ上から1回だけ受け取る（lib/pdf/file-handoff.ts）。
 *   受け取れなかった（再読み込み・別タブ・期限切れ）場合は何も起きず、通常のファイル選択から始まる。
 * 処理はすべてブラウザ内で行い、PDFは送信・保存しない。
 */

interface ReceivedHandoff {
  file: File;
  sourceLabel: string;
}

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

interface FixState {
  /** 引き継ぎの確認が終わるまで、各機能の画面は出さない（先に出すと、受け取ったPDFが反映されない） */
  ready: boolean;
  /** どの機能でも使う、選択中のPDF（機能を切り替えても引き継ぐ） */
  sharedFile: File | null;
  received: ReceivedHandoff | null;
  handoffError: string | null;
}

export function PdfFixTool() {
  const [mode, setMode] = useState<PdfFixMode>("annotate");
  const [state, setState] = useState<FixState>({ ready: false, sharedFile: null, received: null, handoffError: null });
  // 「別のファイルを選ぶ」で各機能の画面を作り直すための番号
  const [resetKey, setResetKey] = useState(0);
  const info = getPdfFixMode(mode);
  const { ready, sharedFile, received, handoffError } = state;

  // 引き継ぎはブラウザのメモリ上の外部の値なので、画面を表示したあと（クライアントだけ）で1回だけ受け取る。
  // （サーバー側の描画と食い違わないよう、描画中ではなく effect で読む。StrictModeの二重実行でも、2回目は空なので何も起きない）
  useEffect(() => {
    const handoff = takePdfHandoff(PDF_FIX_TOOL_ID);
    if (!handoff) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState((s) => (s.ready ? s : { ...s, ready: true }));
      return;
    }
    const problem = validateHandoffFile(handoff.file);
    setState(
      problem
        ? { ready: true, sharedFile: null, received: null, handoffError: problem }
        : { ready: true, sharedFile: handoff.file, received: { file: handoff.file, sourceLabel: handoff.sourceLabel }, handoffError: null }
    );
  }, []);

  const setSharedFile = (file: File | null) => setState((s) => ({ ...s, sharedFile: file }));
  const singleFileProps = { initialFile: sharedFile, onFileChange: setSharedFile };
  // 引き継いだPDFのまま使っている間だけ、引き継ぎの表示を出す（別のPDFを選んだら消す）
  const showReceived = received !== null && sharedFile === received.file;

  function chooseAnotherFile() {
    setState((s) => ({ ...s, sharedFile: null, received: null, handoffError: null }));
    setResetKey((k) => k + 1);
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
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="pdf-fix-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          処理はすべてブラウザ内で行い、PDFはMr.Sattoのサーバーに送信・保存されません。ページの結合・分割・並び替え・回転は「PDF編集」で行えます。
        </p>
      </div>

      {mode === "annotate" && (
        <p
          data-testid="pdf-fix-whiteout-notice"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <span className="font-semibold">{WHITEOUT_NOTICE.title}</span>
          {WHITEOUT_NOTICE.body}
        </p>
      )}

      {handoffError && (
        <div data-testid="pdf-fix-handoff-error" className="flex flex-col gap-2">
          <ErrorMessage message={handoffError} />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">下のファイル選択から、PDFを選び直してください。</p>
        </div>
      )}

      {showReceived && received && (
        <div
          data-testid="pdf-fix-handoff-banner"
          className="flex flex-col gap-1 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-200"
        >
          <p>
            <span className="font-semibold">{received.sourceLabel}の処理結果</span>を読み込みました：
            <span data-testid="pdf-fix-handoff-filename" className="ml-1 font-medium">
              {received.file.name}
            </span>
            （{formatBytes(received.file.size)}）
          </p>
          <p>元のファイルではなく、{received.sourceLabel}で処理したあとのPDFです。違う場合は、別のファイルを選び直せます。</p>
          <button
            type="button"
            data-testid="pdf-fix-choose-another"
            onClick={chooseAnotherFile}
            className="w-fit rounded-md border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100 dark:border-blue-800 dark:text-blue-200 dark:hover:bg-blue-900/30"
          >
            別のファイルを選ぶ
          </button>
        </div>
      )}

      {/* key: 機能を切り替えたら、前の機能の状態（結果・入力）を必ず捨てて作り直す */}
      {ready && (
        <div key={`${mode}-${resetKey}`}>
          {mode === "annotate" && <PdfFillAnnotateTool {...singleFileProps} />}
          {mode === "page-numbers" && <PdfAddPageNumbersTool {...singleFileProps} />}
          {mode === "watermark" && <PdfWatermarkTool {...singleFileProps} />}
        </div>
      )}
    </div>
  );
}
