import type { OnOffCopy } from "@/lib/seo/fiscal-calendar-copy";

/**
 * ツール説明文のうち、複数ファイルの一括処理（プレミアムプランの機能）に関わる部分。
 * tool-content.ts には課金オン時の文言（on）を書き、課金オフ時（プランがなく、だれでも一括処理を使える）は
 * feature-copy.ts が off の文言へ差し替える。
 *
 * 上限の枚数は src/lib/batch/batch-config.ts の BATCH_LIMITS と一致させること（テストで確認している）。
 */

// 画像形式変換（JPG変換・PNG変換・WebP変換のページと共通）
export const FORMAT_CONVERT_META_BATCH: OnOffCopy = {
  on: "1枚ずつの変換は無料で、プレミアムプランでは複数の画像をまとめて変換してZIPで保存できます。",
  off: "複数の画像をまとめて変換してZIPで保存できます。",
};
export const FORMAT_CONVERT_LEAD_BATCH: OnOffCopy = {
  on: "プレミアムプランでは、複数の画像をまとめて変換することもできます。",
  off: "複数の画像をまとめて変換することもできます。",
};
export const FORMAT_CONVERT_HOWTO_SELECT: OnOffCopy = {
  on: "変換したい画像をドラッグ&ドロップ、またはタップして選択します（1ファイルあたり上限50MB。プレミアムプランでは最大30枚まとめて選べます）。",
  off: "変換したい画像をドラッグ&ドロップ、またはタップして選択します（最大30枚まとめて選べます・1ファイルあたり上限50MB）。",
};
export const FORMAT_CONVERT_BATCH_ANSWER: OnOffCopy = {
  on: "はい。プレミアムプランでは、最大30枚までまとめて選んで変換できます。変換した画像が2枚以上のときは、ZIPファイルにまとめてダウンロードできます。無料プランでは1枚ずつ変換できます。1ファイルあたりの上限は50MBです。",
  off: "はい。最大30枚までまとめて選んで変換できます。変換した画像が2枚以上のときは、ZIPファイルにまとめてダウンロードできます。1ファイルあたりの上限は50MBです。",
};

// 画像一括変換
export const BATCH_CONVERT_META_NOTE: OnOffCopy = {
  on: "複数の画像をまとめて変換する一括処理は、プレミアムプランの機能です（1枚ずつなら無料で変換できます）。",
  off: "",
};
export const BATCH_CONVERT_LIMIT_ANSWER: OnOffCopy = {
  on: "プレミアムプランでは、一度に30枚まで変換できます（1ファイルあたり50MBまで）。無料プランでは1枚ずつ変換できます。多くの画像を一度に処理すると、お使いの端末の性能によって時間がかかる場合があります。",
  off: "一度に30枚まで変換できます（1ファイルあたり50MBまで）。多くの画像を一度に処理すると、お使いの端末の性能によって時間がかかる場合があります。",
};

// 背景透過
export const BACKGROUND_REMOVER_META_BATCH: OnOffCopy = {
  on: "プレミアムプランでは、複数枚をまとめて処理できます。",
  off: "複数枚をまとめて処理できます。",
};
export const BACKGROUND_REMOVER_HOWTO_SELECT: OnOffCopy = {
  on: "画像を選びます（プレミアムプランでは、最大10枚まとめて選べます）。",
  off: "画像を選びます（最大10枚まとめて選べます）。",
};

// 画像一括余白・文字入れ
export const PADDING_TEXT_META_BATCH: OnOffCopy = {
  on: "プレミアムプランでは、複数の画像をまとめてZIPで書き出せます。",
  off: "複数の画像をまとめてZIPで書き出せます。",
};
export const PADDING_TEXT_LEAD_NOTE: OnOffCopy = {
  on: "複数の画像をまとめて扱う一括処理（最大30枚）は、プレミアムプランの機能です。",
  off: "",
};
export const PADDING_TEXT_HOWTO_SELECT: OnOffCopy = {
  on: "画像をドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは最大30枚まで選べます）。",
  off: "画像をドラッグ&ドロップ、またはタップして選択します（最大30枚まで選べます）。",
};
export const PADDING_TEXT_BATCH_ANSWER: OnOffCopy = {
  on: "はい。プレミアムプランでは、「一括出力」を押すと、複数枚の画像をZIPファイルとしてまとめてダウンロードできます（最大30枚）。1枚の場合は、そのまま保存されます。",
  off: "はい。「一括出力」を押すと、1枚の場合はそのまま、複数枚の場合はZIPファイルとしてまとめてダウンロードできます（最大30枚）。",
};

// 画像圧縮・画像リサイズ・PDF圧縮（新しく一括処理に対応）
export const IMAGE_COMPRESS_BATCH_ANSWER: OnOffCopy = {
  on: "はい。プレミアムプランでは、最大30枚の画像に同じ設定をまとめて適用し、圧縮した画像をZIPでまとめて保存できます。無料プランでは1枚ずつ圧縮できます。",
  off: "はい。最大30枚の画像に同じ設定をまとめて適用し、圧縮した画像をZIPでまとめて保存できます。",
};
export const IMAGE_RESIZE_BATCH_ANSWER: OnOffCopy = {
  on: "はい。プレミアムプランでは、最大30枚の画像をまとめてリサイズし、ZIPでまとめて保存できます。縦横比を固定すると、指定した幅に合わせて画像ごとに高さを決めます。無料プランでは1枚ずつリサイズできます。",
  off: "はい。最大30枚の画像をまとめてリサイズし、ZIPでまとめて保存できます。縦横比を固定すると、指定した幅に合わせて画像ごとに高さを決めます。",
};
export const PDF_COMPRESS_BATCH_ANSWER: OnOffCopy = {
  on: "はい。プレミアムプランでは、最大10個のPDFを同じ設定で1つずつ順番に圧縮し、圧縮したPDFをZIPでまとめて保存できます。無料プランでは1つずつ圧縮できます。",
  off: "はい。最大10個のPDFを同じ設定で1つずつ順番に圧縮し、圧縮したPDFをZIPでまとめて保存できます。",
};

export const BATCH_COPY_PAIRS: OnOffCopy[] = [
  FORMAT_CONVERT_META_BATCH,
  FORMAT_CONVERT_LEAD_BATCH,
  FORMAT_CONVERT_HOWTO_SELECT,
  FORMAT_CONVERT_BATCH_ANSWER,
  BATCH_CONVERT_META_NOTE,
  BATCH_CONVERT_LIMIT_ANSWER,
  BACKGROUND_REMOVER_META_BATCH,
  BACKGROUND_REMOVER_HOWTO_SELECT,
  PADDING_TEXT_META_BATCH,
  PADDING_TEXT_LEAD_NOTE,
  PADDING_TEXT_HOWTO_SELECT,
  PADDING_TEXT_BATCH_ANSWER,
  IMAGE_COMPRESS_BATCH_ANSWER,
  IMAGE_RESIZE_BATCH_ANSWER,
  PDF_COMPRESS_BATCH_ANSWER,
];
