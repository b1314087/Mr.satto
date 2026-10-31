import type { RequiredPlan } from "@/lib/plans/types";

/**
 * ツール間のファイル受け渡し（工程16）の型。
 *
 * 受け渡しは「送り出し（send）」と「受け取り（receive）」を別々に宣言する有向の関係。
 * A が送り出せて B が受け取れるとき、A → B だけが成り立つ（B → A は B の送り出しと A の受け取りの宣言しだい）。
 * 宣言のないツールは、送り出しも受け取りもしない（安全側）。宣言は src/lib/handoff/config.ts の1か所だけ。
 */

/** 受け渡しで扱うファイルの種類（拡張子だけでなく、ファイルの先頭のバイトでも確かめる。file-kind.ts） */
export type HandoffFileKind =
  | "pdf"
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "csv"
  | "tsv"
  | "txt"
  | "md"
  | "json"
  | "xlsx"
  | "docx"
  | "pptx"
  | "zip";

export const HANDOFF_FILE_KIND_LABELS: Record<HandoffFileKind, string> = {
  pdf: "PDF",
  png: "PNG画像",
  jpeg: "JPG画像",
  webp: "WebP画像",
  gif: "GIF画像",
  csv: "CSV",
  tsv: "TSV",
  txt: "テキスト",
  md: "Markdown",
  json: "JSON",
  xlsx: "Excel（.xlsx）",
  docx: "Word（.docx）",
  pptx: "PowerPoint（.pptx）",
  zip: "ZIP",
};

/** 種類ごとのMIMEタイプ（結果のファイルにMIMEタイプが付いていないときに補う） */
export const HANDOFF_FILE_KIND_MIME: Record<HandoffFileKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

/**
 * ツールの役割。受け渡しの向きを考えるための分類。
 * - generate: 入力ファイルなしで書類・画像などを作る（他のツールからは受け取らない）
 * - edit: 受け取ったファイルを同じ形式のまま直す
 * - convert: 受け取ったファイルを別の形式にする
 * - inspect: 受け取ったファイルを調べる（結果は元のファイルではないので、原則として送り出さない）
 */
export type ToolRole = "generate" | "edit" | "convert" | "inspect";

export interface HandoffReceiveSpec {
  /** 受け取れる種類。"any" はどの種類でもよい（ZIP作成・ハッシュ計算など） */
  kinds: readonly HandoffFileKind[] | "any";
  /** 1回の受け渡しで受け取れるファイル数 */
  maxFiles: number;
  /** 1ファイルあたりの上限（MB）。ツールのファイル選択欄の上限と同じ値にする（テストで確認） */
  maxFileSizeMB: number;
}

export interface HandoffSendSpec {
  /** 処理結果として送り出しうる種類（ボタンを出すかの事前判定に使う。実際の判定は結果のファイルそのもので行う） */
  kinds: readonly HandoffFileKind[];
}

export interface ToolHandoffSpec {
  role: ToolRole;
  /** 未設定なら、他のツールからは受け取らない */
  receive?: HandoffReceiveSpec;
  /** 未設定なら、処理結果を他のツールへ送り出さない */
  send?: HandoffSendSpec;
}

/** 受け渡し先の候補（サーバーで作り、画面へ渡す軽い形） */
export interface HandoffTarget {
  id: string;
  name: string;
  receive: HandoffReceiveSpec;
  requiredPlan: RequiredPlan;
}

/** 判定に使う、送り出すファイル1件の情報 */
export interface HandoffFileInfo {
  name: string;
  /** 判別できなかった場合は null（"any" を受け取るツールにだけ渡せる） */
  kind: HandoffFileKind | null;
  size: number;
}
