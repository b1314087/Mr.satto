/**
 * 「使い方」の図解（ツールページの「使い方」パネル）のデータの形。
 *
 * 図は、実際のツール画面にある部品（ドロップ枠・選択ボタン・入力欄・実行ボタンなど）を、
 * 実際の表示名のまま小さく描いたもの。各ステップで「いま操作する部品」を青い枠と番号付きの矢印で示す。
 * 部品の表示名は、実際の画面（src/components/tools/implementations/*.tsx）と同じにすること。
 * 画面にない部品・表示名は書かない。
 *
 * 描き方は src/components/guide/guide-figure.tsx。PC用（横長・設定とプレビューを左右に並べる）と
 * スマホ用（縦長・上から順に並べる）を、同じデータから描き分ける。
 */

/** プレビュー欄の中身の種類（中に描く絵が変わる） */
export type GuidePreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "sheet"
  | "doc"
  | "text"
  | "qr"
  | "calendar"
  | "seats"
  | "shift"
  | "label"
  | "envelope"
  | "ticket"
  | "stamp"
  | "gradient"
  | "invoice"
  | "files";

/** 図に描く部品 */
export type GuidePart =
  /** ファイルのドロップ枠（読み込む前）。表示名は実際の枠と同じ */
  | { k: "drop"; label: string }
  /** 読み込んだファイルの行（ファイル名・「ファイルを変更／追加」） */
  | { k: "file"; name: string; add?: boolean }
  /** セグメントボタン（1つを選ぶ） */
  | { k: "seg"; label?: string; options: string[]; on: number }
  /** オン・オフのチップ（いくつでも選べる） */
  | { k: "chips"; label?: string; options: string[]; on: number[] }
  /** ボタンの並び（モードの切り替えなど。on は押している状態のボタン、-1 ならなし） */
  | { k: "btns"; options: string[]; on: number }
  /** 入力欄 */
  | { k: "input"; label: string; value: string }
  /** 入力欄2つを横に並べたもの */
  | { k: "input2"; labels: [string, string]; values: [string, string] }
  /** スライダー（value は 0〜1 のつまみの位置） */
  | { k: "slider"; label: string; value: number; text?: string }
  /** チェックボックス */
  | { k: "check"; label: string; on: boolean }
  /** プルダウン */
  | { k: "select"; label: string; value: string }
  /** 複数行の入力欄・結果欄（lines は中に描く行の見本） */
  | { k: "text"; label?: string; lines: string[] }
  /** 表（読み込んだ表のプレビューなど） */
  | { k: "table"; cols?: number; rows?: number }
  /** 見出し（番号付きの見出しは n を付ける） */
  | { k: "head"; text: string; n?: number }
  /** 詳細設定などの折りたたみ（閉じた状態） */
  | { k: "adv"; title: string; summary?: string }
  /** 実行ボタン（青いボタン） */
  | { k: "run"; label: string }
  /** そのほかのボタン（白いボタン） */
  | { k: "btn"; label: string }
  /** プレビュー欄 */
  | { k: "preview"; kind: GuidePreviewKind; caption?: string };

export interface GuideStep {
  /** ステップの短い見出し（スライドの右に大きく出す。例：「画像を選ぶ」） */
  title: string;
  /**
   * 見出しの下の説明文。書かないときは、いま操作する部品から自動で作る
   * （src/lib/guides/describe.ts。例：実行ボタンなら「『圧縮する』を押します。」）
   */
  desc?: string;
  /** 図に描く部品（上から順） */
  parts: GuidePart[];
  /** いま操作する部品（parts の番号）。完了の画面を出すときは "popup" */
  focus: number | "popup";
  /**
   * 完成の画面（「できあがりました」のポップアップ）を重ねて描く。
   * label はポップアップの中のボタン名（既定は「ダウンロード」）
   */
  popup?: { label?: string };
}

export interface ToolGuide {
  /** PCで設定とプレビューを左右に並べる画面か（実際の画面と同じにする） */
  split?: boolean;
  steps: GuideStep[];
}
