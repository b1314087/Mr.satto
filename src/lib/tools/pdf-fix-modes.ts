/**
 * 「PDF修正」総合ツールの機能（モード）の定義（工程12）。
 *
 * PDF修正は、既存のPDF関連ツールを1つの画面にまとめた画面。各機能の中身は既存ツールの画面をそのまま使う。
 * 記入・注釈・白消し（旧 PDF記入・注釈）は工程2で、ページ番号（旧 PDFページ番号追加）・透かし（旧 PDF透かし）は工程3で、
 * 独立したページを廃止した。旧URLはPDF修正へ転送し、ページ番号・透かしは ?mode=<mode> で、その機能を選んだ状態で開く。
 * 画面（クライアント）から読むため、重いツール一覧データ（data.ts）には依存させず、ここに軽い定数として持つ。
 * data.ts のツールIDとの一致は tests/tools/pdf-fix.spec.ts で検証している。
 */

export const PDF_FIX_TOOL_ID = "pdf-fix";
export const PDF_FIX_TOOL_PATH = "/tools/pdf-fix";

export type PdfFixMode = "annotate" | "page-numbers" | "watermark" | "redact";

export interface PdfFixModeInfo {
  mode: PdfFixMode;
  /** 切り替えボタンの表示名 */
  label: string;
  /** 独立したページだったころの名前（旧URLから転送されてきた人への案内・テスト用） */
  formerName: string;
  /** 独立したページだったころのツールID（旧URL /tools/<formerToolId> は、PDF修正へ転送する） */
  formerToolId: string;
  /** 機能の説明（1文） */
  description: string;
}

export const PDF_FIX_MODES: PdfFixModeInfo[] = [
  {
    mode: "annotate",
    label: "記入・注釈・白消し",
    formerName: "PDF記入・注釈",
    formerToolId: "pdf-fill-annotate",
    description: "文字・チェック・図形・手書き・画像・印影を追加できます。白消しで文字を隠して、上から書き直すこともできます。黒塗り（見た目だけ）も置けます。",
  },
  {
    mode: "page-numbers",
    label: "ページ番号",
    formerName: "PDFページ番号追加",
    formerToolId: "pdf-add-page-numbers",
    description: "各ページに、開始番号・位置・大きさを選んでページ番号を入れます。",
  },
  {
    mode: "watermark",
    label: "透かし",
    formerName: "PDF透かし",
    formerToolId: "pdf-watermark",
    description: "各ページに、「社外秘」などの文字を透かしとして入れます。",
  },
  {
    // 黒塗り・墨消し（旧 PDF黒塗り・墨消し）は、独立したページを廃止し、PDF修正の中で使う（旧URLは ?mode=redact へ転送）
    mode: "redact",
    label: "墨消し",
    formerName: "PDF黒塗り・墨消し",
    formerToolId: "pdf-redact",
    description: "隠したい範囲を指定し、元の文字・画像のデータごと黒塗りで消した新しいPDFを作ります。",
  },
];

export function getPdfFixMode(mode: PdfFixMode): PdfFixModeInfo {
  return PDF_FIX_MODES.find((m) => m.mode === mode) ?? PDF_FIX_MODES[0];
}

/** URLの ?mode= の値を、PDF修正の機能として読み取る（知らない値は null） */
export function parsePdfFixMode(value: string | null): PdfFixMode | null {
  return PDF_FIX_MODES.some((m) => m.mode === value) ? (value as PdfFixMode) : null;
}

// ---------------------------------------------------------------------------
// 新工程1：「やりたい操作」のプルダウン
// ---------------------------------------------------------------------------
//
// PDF修正で今できる操作（既存の機能だけ。新しい機能は増やしていない）を、1つのプルダウンにまとめる。
// - PDFの上に置く操作（文字・チェック・図形・手書き・画像・印影・白消し・黒塗り・選択）は、記入・注釈の画面の操作。
//   切り替えても、置いたものは消えない（同じ記入・注釈の画面のまま、操作だけが変わる）。
// - ページ番号・透かしは、全ページにまとめて入れる別の画面。切り替えても、記入・注釈の編集内容は残る。

/** 記入・注釈の画面の中の操作（pdf-fill-annotate-tool.tsx の ToolMode と同じ値） */
export type PdfFixAnnotateOperation = "text" | "checkbox" | "shape" | "ink" | "image" | "stamp" | "whiteout" | "blackout" | "select";
export type PdfFixOperation = PdfFixAnnotateOperation | "page-numbers" | "watermark" | "redact";

export interface PdfFixOperationInfo {
  value: PdfFixOperation;
  /** プルダウンの表示名 */
  label: string;
  /** プルダウンのまとまり */
  group: "place" | "pages" | "remove";
  /** どの画面で行うか */
  mode: PdfFixMode;
  /** 使い方（PDFの上での置き方・動かし方・大きさの変え方） */
  howTo: string;
}

const MOVE_RESIZE = "置いたものは、ドラッグで動かし、選んだときに右下に出るつまみで大きさを変えられます（ページの外には出ません）。";

export const PDF_FIX_OPERATIONS: PdfFixOperationInfo[] = [
  { value: "text", label: "文字を書き込む", group: "place", mode: "annotate", howTo: "PDFの上の書きたい場所をクリックすると、文字の入力欄が置かれます。置いた文字はドラッグで動かせます（ページの外には出ません）。文字の大きさは、下の欄で変えられます。" },
  { value: "checkbox", label: "チェックマーク（✓・×・○）を付ける", group: "place", mode: "annotate", howTo: `付けたい場所をクリックします。枠を外すと、マークだけを置けます。${MOVE_RESIZE}` },
  { value: "shape", label: "図形（四角・円・線）を描く", group: "place", mode: "annotate", howTo: `図形の種類を選び、描きたい場所をクリックします。${MOVE_RESIZE}` },
  { value: "ink", label: "手書きで書く", group: "place", mode: "annotate", howTo: "PDFの上をドラッグして書きます。書いた線は「置いたものを選ぶ・動かす」で動かせます。" },
  { value: "image", label: "画像を貼る", group: "place", mode: "annotate", howTo: `画像を選んでから、貼りたい場所をクリックします。${MOVE_RESIZE}` },
  { value: "stamp", label: "印影（電子印鑑）を押す", group: "place", mode: "annotate", howTo: `印影の画像を選んでから、押したい場所をクリックします。${MOVE_RESIZE}` },
  { value: "whiteout", label: "白消し（白く塗って隠す・書き直す）", group: "place", mode: "annotate", howTo: `隠したい場所をクリックすると、白い四角形を置きます。書き直すときは、上に「文字を書き込む」で入力します。${MOVE_RESIZE}` },
  { value: "blackout", label: "黒塗り（見た目だけ）", group: "place", mode: "annotate", howTo: `隠したい場所をクリックすると、黒い四角形を置きます。元のデータは残ります（墨消しではありません）。${MOVE_RESIZE}` },
  { value: "select", label: "置いたものを選ぶ・動かす・大きさを変える", group: "place", mode: "annotate", howTo: `置いたものをクリックすると選べます。${MOVE_RESIZE}` },
  { value: "page-numbers", label: "ページ番号を入れる", group: "pages", mode: "page-numbers", howTo: "全ページに、開始番号・位置・大きさを選んでページ番号を入れます。" },
  { value: "watermark", label: "透かしを入れる", group: "pages", mode: "watermark", howTo: "全ページに、「社外秘」などの文字を透かしとして入れます。" },
  {
    value: "redact",
    label: "墨消し（元の文字ごと黒塗りで消す）",
    group: "remove",
    mode: "redact",
    howTo:
      "PDFの上をドラッグして、隠したい範囲を囲みます。囲んだページを画像にして黒を焼き込むため、元の文字・画像のデータは残りません（コピー・検索でも読めません）。個人情報などを確実に消したいときに使います。",
  },
];

export function getPdfFixOperation(value: PdfFixOperation): PdfFixOperationInfo {
  return PDF_FIX_OPERATIONS.find((o) => o.value === value) ?? PDF_FIX_OPERATIONS[0];
}
