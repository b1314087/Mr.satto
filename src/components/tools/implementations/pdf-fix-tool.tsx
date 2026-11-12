"use client";

import { useEffect, useState } from "react";
import { PdfFillAnnotateTool, type ToolMode } from "./pdf-fill-annotate-tool";
import { PdfAddPageNumbersTool } from "./pdf-add-page-numbers-tool";
import { PdfWatermarkTool } from "./pdf-watermark-tool";
import { PdfRedactTool } from "./pdf-redact-tool";
import {
  PDF_FIX_OPERATIONS,
  getPdfFixOperation,
  parsePdfFixMode,
  type PdfFixAnnotateOperation,
  type PdfFixMode,
  type PdfFixOperation,
} from "@/lib/tools/pdf-fix-modes";
import { WHITEOUT_NOTICE } from "@/lib/pdf-annotate/whiteout";

/**
 * PDF修正の総合画面（工程12。新工程1で、操作の選び方を「やりたい操作」のプルダウン1つにまとめた）。
 *
 * - プルダウンで選べるのは、今あるPDF修正の操作だけ（文字・チェック・図形・手書き・画像・印影・白消し・黒塗り・
 *   置いたものの選択／ページ番号・透かし。src/lib/tools/pdf-fix-modes.ts の PDF_FIX_OPERATIONS）。
 * - 選んだ操作の名前と使い方（置き方・動かし方・大きさの変え方）を、プルダウンのすぐ下に出す。
 *   選んだ操作に関係する設定だけが出る（記入・注釈の画面は、操作ごとの設定欄だけを出す）。
 * - 切り替えても、置いた文字・図形などは消えない：
 *   ・PDFの上に置く操作どうしの切り替えは、同じ記入・注釈の画面のまま操作だけを変える。
 *   ・ページ番号・透かしへ切り替えても、記入・注釈の画面は消さずに隠しておき、戻ると編集の続きができる
 *     （以前は切り替えると配置したものが消えるため、確認を出していた）。
 *   ・ページ番号・透かしの画面は、切り替えるたびに作り直す（古い結果をダウンロードさせない）。
 * - 選んだPDFは、どの操作でも引き継ぐ。記入・注釈で編集中のPDFがあるときは、そのPDFと編集はそのまま残す。
 * - 墨消し（元の文字ごと黒塗りで消す。旧 PDF黒塗り・墨消し）も、やりたい操作の1つとして、ここで使う。
 * - 旧「PDFページ番号追加」「PDF透かし」「PDF黒塗り・墨消し」のアドレスからの転送（?mode=page-numbers / ?mode=watermark / ?mode=redact）では、
 *   その操作を選んだ状態で開く。
 * 処理はすべてブラウザ内で行い、PDFは送信・保存しない。
 */

/** やりたい操作のボタンに出す、短い名前とアイコン（正式な名前はボタンにカーソルを乗せると出る） */
const PDF_FIX_OPERATION_SHORT: Record<PdfFixOperation, string> = {
  text: "文字",
  checkbox: "チェック",
  shape: "図形",
  ink: "手書き",
  image: "画像",
  stamp: "印影",
  whiteout: "白消し",
  blackout: "黒塗り",
  select: "選ぶ・動かす",
  "page-numbers": "ページ番号",
  watermark: "透かし",
  redact: "墨消し",
};
const PDF_FIX_OPERATION_ICONS: Record<PdfFixOperation, string> = {
  text: "Aa",
  checkbox: "✓",
  shape: "□",
  ink: "✎",
  image: "▣",
  stamp: "㊞",
  whiteout: "▭",
  blackout: "■",
  select: "↖",
  "page-numbers": "#",
  watermark: "◌",
  redact: "▮",
};
const PDF_FIX_OPERATION_GROUPS = [
  { group: "place", label: "PDFの上に置く（置いたあと動かせます）" },
  { group: "pages", label: "全ページにまとめて入れる" },
  { group: "remove", label: "元のデータごと消す" },
] as const;

export function PdfFixTool() {
  const [operation, setOperation] = useState<PdfFixOperation>("text");
  const info = getPdfFixOperation(operation);
  const mode: PdfFixMode = info.mode;
  // 記入・注釈の画面の中の操作（ページ番号・透かしを選んでいる間も、最後の操作を覚えておく）
  const [annotateOp, setAnnotateOp] = useState<PdfFixAnnotateOperation>("text");
  // 「記入・注釈」で配置済みの編集があるか（画面側から知らせてもらう）
  const [annotateHasEdits, setAnnotateHasEdits] = useState(false);
  // どの操作でも使う、選択中のPDF（切り替えても引き継ぐ）
  const [sharedFile, setSharedFile] = useState<File | null>(null);
  // 記入・注釈の画面が読み込んでいるPDF。編集がないときに別のPDFが選ばれていたら、記入・注釈の画面を作り直す
  const [annotateFile, setAnnotateFile] = useState<File | null>(null);
  const [annotateKey, setAnnotateKey] = useState(0);
  // ページ番号・透かしの画面は、切り替えるたびに作り直す
  const [pagesKey, setPagesKey] = useState(0);

  // 旧URLから転送されてきたとき（?mode=page-numbers など）は、その操作を最初から選んでおく
  useEffect(() => {
    const fromUrl = parsePdfFixMode(new URLSearchParams(window.location.search).get("mode"));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromUrl === "page-numbers" || fromUrl === "watermark" || fromUrl === "redact") setOperation(fromUrl);
  }, []);

  function chooseOperation(next: PdfFixOperation) {
    const nextInfo = getPdfFixOperation(next);
    if (nextInfo.mode === "annotate") {
      // ほかの画面で別のPDFを選んでいて、記入・注釈に編集がなければ、新しいPDFで開き直す
      if (mode !== "annotate" && !annotateHasEdits && sharedFile && sharedFile !== annotateFile) setAnnotateKey((k) => k + 1);
      setAnnotateOp(next as PdfFixAnnotateOperation);
    } else if (next !== operation) {
      setPagesKey((k) => k + 1);
    }
    setOperation(next);
  }

  /** 記入・注釈の画面の中で操作が変わったとき（置いたあと「選ぶ・動かす」に戻るときなど） */
  function handleAnnotateModeChange(m: ToolMode) {
    setAnnotateOp(m as PdfFixAnnotateOperation);
    setOperation(m as PdfFixAnnotateOperation);
  }

  const singleFileProps = { initialFile: sharedFile, onFileChange: setSharedFile };

  /** やりたい操作のプルダウンと、いまの操作・使い方 */
  const operationBlock = (
      <div className="flex flex-col gap-2" data-testid="pdf-fix-modes" data-mode={mode}>
        {/* やりたい操作（12個）を、アイコン付きのボタンで並べる（以前はプルダウン）。グループは以前の区分と同じ */}
        <div role="radiogroup" aria-label="やりたい操作" data-testid="pdf-fix-operation" data-value={operation} className="flex flex-col gap-2">
          {PDF_FIX_OPERATION_GROUPS.map((g) => (
            <div key={g.group} className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold text-ms-muted">{g.label}</p>
              <div className="ms-op-grid">
                {PDF_FIX_OPERATIONS.filter((o) => o.group === g.group).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={operation === o.value}
                    title={o.label}
                    data-testid={`pdf-fix-op-${o.value}`}
                    onClick={() => chooseOperation(o.value)}
                  >
                    <span aria-hidden="true" className="ms-op-icon">
                      {PDF_FIX_OPERATION_ICONS[o.value]}
                    </span>
                    {PDF_FIX_OPERATION_SHORT[o.value]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div
          data-testid="pdf-fix-mode-description"
          className="flex flex-col gap-0.5 rounded-lg bg-ms-hover-tint px-3 py-2 text-xs text-ms-text"
        >
          <p className="font-semibold" data-testid="pdf-fix-current-operation" data-operation={operation}>
            いまの操作：{info.label}
          </p>
          <p>{info.howTo}</p>
          {mode !== "annotate" && annotateHasEdits && (
            <p className="mt-1" data-testid="pdf-fix-annotate-kept">
              PDFの上に置いた文字・図形などは、そのまま残っています（「PDFの上に置く」操作を選ぶと、続きを編集できます）。
              ページ番号・透かしは、それとは別のPDFとして書き出します。
            </p>
          )}
        </div>
      </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* 記入・注釈のときは、やりたい操作を設定の列（「記入・注釈を配置」の見出しの下）に出す。ページ番号・透かしのときは、ここに出す */}
      {mode !== "annotate" && operationBlock}

      {/* 白消し・黒塗りを選んだときだけ、見た目だけ隠す方式と、本当の墨消しの違いを出す */}
      {(operation === "whiteout" || operation === "blackout") && (
        <p
          data-testid="pdf-fix-whiteout-notice"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <span className="font-semibold">{WHITEOUT_NOTICE.title}</span>
          {WHITEOUT_NOTICE.body}
          個人情報などを確実に消したいときは、
          <button type="button" onClick={() => chooseOperation("redact")} className="underline" data-testid="pdf-fix-open-redact">
            墨消し（元の文字ごと黒塗りで消す）
          </button>
          を使ってください。
          <span className="mt-2 block" data-testid="pdf-fix-redaction-methods">
            <span className="block">
              <span className="font-semibold">黒塗り（見た目だけ）＝この画面：</span>
              黒い四角形を重ねて見た目を隠します。元の文字・画像のデータはPDFの中に残ります（墨消しではありません）。
            </span>
            <span className="block">
              <span className="font-semibold">墨消し（元のデータごと削除）＝「やりたい操作」の墨消し：</span>
              範囲を指定したページを画像にして黒を焼き込み、元の文字・画像のデータを残さない新しいPDFを作ります。
            </span>
          </span>
        </p>
      )}

      {/* key: ページ番号・透かしは、切り替えたら前の結果・入力を捨てて作り直す。
          隠している記入・注釈の画面より前に置く（ページ番号・透かしの画面の、ファイルの選択欄が先に来るように） */}
      <div key={`${mode}-${pagesKey}`}>
        {mode === "page-numbers" && <PdfAddPageNumbersTool {...singleFileProps} />}
        {mode === "watermark" && <PdfWatermarkTool {...singleFileProps} />}
        {mode === "redact" && <PdfRedactTool {...singleFileProps} />}
      </div>
      {/* 記入・注釈の画面は、ほかの操作を選んでいる間も消さずに隠しておく（置いたものを消さないため） */}
      <div hidden={mode !== "annotate"} data-testid="pdf-fix-annotate-panel">
        <PdfFillAnnotateTool
          key={annotateKey}
          initialFile={sharedFile}
          onFileChange={(f) => {
            setAnnotateFile(f);
            setSharedFile(f);
          }}
          onDirtyChange={setAnnotateHasEdits}
          controlledMode={annotateOp}
          onModeChange={handleAnnotateModeChange}
          inactive={mode !== "annotate"}
          operationSlot={mode === "annotate" ? operationBlock : undefined}
          onOpenRedaction={() => chooseOperation("redact")}
        />
      </div>
    </div>
  );
}
