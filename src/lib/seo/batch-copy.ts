import type { OnOffCopy } from "@/lib/seo/fiscal-calendar-copy";
import { BATCH_LIMITS } from "@/lib/batch/batch-config";

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
  on: `変換したい画像をドラッグ&ドロップ、またはタップして選択します（1ファイルあたり上限50MB。プレミアムプランでは最大${BATCH_LIMITS["image-format-convert"]}枚まとめて選べます）。`,
  off: `変換したい画像をドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-format-convert"]}枚まとめて選べます・1ファイルあたり上限50MB）。`,
};
export const FORMAT_CONVERT_BATCH_ANSWER: OnOffCopy = {
  on: `はい。プレミアムプランでは、最大${BATCH_LIMITS["image-format-convert"]}枚までまとめて選んで変換できます。変換した画像が2枚以上のときは、ZIPファイルにまとめてダウンロードできます。無料プランでは1枚ずつ変換できます。1ファイルあたりの上限は50MBです。`,
  off: `はい。最大${BATCH_LIMITS["image-format-convert"]}枚までまとめて選んで変換できます。変換した画像が2枚以上のときは、ZIPファイルにまとめてダウンロードできます。1ファイルあたりの上限は50MBです。`,
};

// 画像一括変換
export const BATCH_CONVERT_META_NOTE: OnOffCopy = {
  on: "複数の画像をまとめて変換する一括処理は、プレミアムプランの機能です（1枚ずつなら無料で変換できます）。",
  off: "",
};
export const BATCH_CONVERT_LIMIT_ANSWER: OnOffCopy = {
  on: `プレミアムプランでは、一度に${BATCH_LIMITS["image-format-convert"]}枚まで変換できます（1ファイルあたり50MBまで）。無料プランでは1枚ずつ変換できます。多くの画像を一度に処理すると、お使いの端末の性能によって時間がかかる場合があります。`,
  off: `一度に${BATCH_LIMITS["image-format-convert"]}枚まで変換できます（1ファイルあたり50MBまで）。多くの画像を一度に処理すると、お使いの端末の性能によって時間がかかる場合があります。`,
};

// 背景透過
export const BACKGROUND_REMOVER_META_BATCH: OnOffCopy = {
  on: "プレミアムプランでは、複数枚をまとめて処理できます。",
  off: "複数枚をまとめて処理できます。",
};
export const BACKGROUND_REMOVER_HOWTO_SELECT: OnOffCopy = {
  on: `画像を選びます（プレミアムプランでは、最大${BATCH_LIMITS["background-remover"]}枚まとめて選べます）。`,
  off: `画像を選びます（最大${BATCH_LIMITS["background-remover"]}枚まとめて選べます）。`,
};

// 画像一括余白・文字入れ
export const PADDING_TEXT_META_BATCH: OnOffCopy = {
  on: "プレミアムプランでは、複数の画像をまとめてZIPで書き出せます。",
  off: "複数の画像をまとめてZIPで書き出せます。",
};
export const PADDING_TEXT_LEAD_NOTE: OnOffCopy = {
  on: `複数の画像をまとめて扱う一括処理（最大${BATCH_LIMITS["image-padding-text"]}枚）は、プレミアムプランの機能です。`,
  off: "",
};
export const PADDING_TEXT_HOWTO_SELECT: OnOffCopy = {
  on: `画像をドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは最大${BATCH_LIMITS["image-padding-text"]}枚まで選べます）。`,
  off: `画像をドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-padding-text"]}枚まで選べます）。`,
};
export const PADDING_TEXT_BATCH_ANSWER: OnOffCopy = {
  on: `はい。プレミアムプランでは、「一括出力」を押すと、複数枚の画像をZIPファイルとしてまとめてダウンロードできます（最大${BATCH_LIMITS["image-padding-text"]}枚）。1枚の場合は、そのまま保存されます。`,
  off: `はい。「一括出力」を押すと、1枚の場合はそのまま、複数枚の場合はZIPファイルとしてまとめてダウンロードできます（最大${BATCH_LIMITS["image-padding-text"]}枚）。`,
};

// 画像圧縮・画像リサイズ・PDF圧縮（新しく一括処理に対応）
export const IMAGE_COMPRESS_BATCH_ANSWER: OnOffCopy = {
  on: `はい。プレミアムプランでは、最大${BATCH_LIMITS["image-compress"]}枚の画像に同じ設定をまとめて適用し、圧縮した画像をZIPでまとめて保存できます。無料プランでは1枚ずつ圧縮できます。`,
  off: `はい。最大${BATCH_LIMITS["image-compress"]}枚の画像に同じ設定をまとめて適用し、圧縮した画像をZIPでまとめて保存できます。`,
};
export const IMAGE_RESIZE_BATCH_ANSWER: OnOffCopy = {
  on: `はい。プレミアムプランでは、最大${BATCH_LIMITS["image-compress"]}枚の画像をまとめてリサイズし、ZIPでまとめて保存できます。縦横比を固定すると、指定した幅に合わせて画像ごとに高さを決めます。無料プランでは1枚ずつリサイズできます。`,
  off: `はい。最大${BATCH_LIMITS["image-compress"]}枚の画像をまとめてリサイズし、ZIPでまとめて保存できます。縦横比を固定すると、指定した幅に合わせて画像ごとに高さを決めます。`,
};
export const PDF_COMPRESS_BATCH_ANSWER: OnOffCopy = {
  on: `はい。プレミアムプランでは、最大${BATCH_LIMITS["pdf-compress"]}個のPDFを同じ設定で1つずつ順番に圧縮し、圧縮したPDFをZIPでまとめて保存できます。無料プランでは1つずつ圧縮できます。`,
  off: `はい。最大${BATCH_LIMITS["pdf-compress"]}個のPDFを同じ設定で1つずつ順番に圧縮し、圧縮したPDFをZIPでまとめて保存できます。`,
};

// ---------------------------------------------------------------------------
// 2026-11：一括処理を15ツールに追加（よくある質問の答え）
// ---------------------------------------------------------------------------

/** 一括処理のよくある質問の答え（課金オンはプレミアムの機能だと書き、課金オフではプランの話をしない） */
function batchAnswer(limitText: string, body: string, note = ""): OnOffCopy {
  return {
    on: `はい。プレミアムプランでは、最大${limitText}を${body}、ZIPでまとめて保存できます。${note}無料プランでは1つずつ処理できます。`,
    off: `はい。最大${limitText}を${body}、ZIPでまとめて保存できます。${note}`,
  };
}

export const PDF_TO_IMAGE_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["pdf-to-image"]}個のPDF`,
  "同じ形式（PNG・JPG）で1つずつ順番に画像にして"
);
export const IMAGE_CROP_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["image-crop"]}枚の画像`,
  "まとめて切り抜いて",
  "自由トリミングでは1枚目で決めた範囲を同じ割合の位置で、SNSサイズでは画像ごとに中央を切り抜いて同じサイズにします。"
);
export const IMAGE_ROTATE_FLIP_BATCH_ANSWER = batchAnswer(`${BATCH_LIMITS["image-rotate-flip"]}枚の画像`, "同じ角度・向きでまとめて回転・反転して");
export const IMAGE_METADATA_REMOVE_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["image-metadata-remove"]}枚の画像`,
  "1枚ずつ順番に撮影日時・位置情報などを取り除いて"
);
export const IMAGE_WATERMARK_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["image-watermark"]}枚の画像`,
  "同じ文字・位置の透かしでまとめて処理して",
  "文字の大きさは、画像ごとの大きさに合わせて同じ割合にそろえます。"
);
export const IMAGE_TILE_SPLIT_BATCH_ANSWER = batchAnswer(`${BATCH_LIMITS["image-tile-split"]}枚の画像`, "同じ行数・列数でまとめて分割して");
export const IMAGE_MOSAIC_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["image-mosaic"]}枚の画像`,
  "1枚目で決めた範囲と同じ割合の位置で、まとめてモザイク・ぼかしをかけて",
  "同じ大きさの画像（スクリーンショットなど）なら、同じ位置になります。"
);
export const PDF_FIX_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["pdf-fix"]}個のPDF`,
  "同じ設定でまとめてページ番号や透かしを入れて",
  "文字・図形などを置く操作と墨消しは、PDFごとに場所が違うため1つずつ行います。"
);
export const WORD_TO_PDF_BATCH_ANSWER = batchAnswer(`${BATCH_LIMITS["word-to-pdf"]}個のWord文書`, "1つずつ順番にPDFに変換して");
export const EXCEL_TO_PDF_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["excel-to-pdf"]}個のExcelファイル`,
  "同じ向き・ページの収め方で1つずつ順番にPDFに変換して",
  "まとめて変換するときは、ファイルごとに、表示されているシートをすべてPDFにします。"
);
export const PDF_PASSWORD_PROTECT_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["pdf-password-protect"]}個のPDF`,
  "同じパスワード・同じ許可で1つずつ順番に保護して"
);
export const PDF_RESIZE_PAGES_BATCH_ANSWER = batchAnswer(`${BATCH_LIMITS["pdf-resize-pages"]}個のPDF`, "同じ用紙サイズ・同じ方法でまとめて変更して");
export const PDF_METADATA_REMOVE_BATCH_ANSWER = batchAnswer(`${BATCH_LIMITS["pdf-metadata-remove"]}個のPDF`, "1つずつ順番にメタデータを削除して");
export const PDF_CROP_PAGES_BATCH_ANSWER = batchAnswer(`${BATCH_LIMITS["pdf-crop-pages"]}個のPDF`, "同じ余白でまとめて調整して");
export const FILE_UNZIP_BATCH_ANSWER = batchAnswer(
  `${BATCH_LIMITS["file-unzip"]}個のZIP`,
  "1つずつ順番に解凍して",
  "まとめて保存するときは、どのZIPの中身か分かるよう、ファイル名の前に元のZIPの名前を付けます。"
);

// 2026-11：一括処理を15ツールに追加（使い方の「ファイルを選ぶ」手順）
export const PDF_TO_IMAGE_HOWTO_SELECT: OnOffCopy = {
  on: `PDFをドラッグ&ドロップ、またはタップして選択します（1ファイル上限50MB。プレミアムプランでは最大${BATCH_LIMITS["pdf-to-image"]}個まとめて選べます）。`,
  off: `PDFをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["pdf-to-image"]}個まとめて選べます・1ファイル上限50MB）。`,
};
export const IMAGE_CROP_HOWTO_SELECT: OnOffCopy = {
  on: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（SNSサイズ・自由トリミングは、プレミアムプランでは最大${BATCH_LIMITS["image-crop"]}枚まとめて選べます）。`,
  off: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（SNSサイズ・自由トリミングは、最大${BATCH_LIMITS["image-crop"]}枚まとめて選べます）。`,
};
export const IMAGE_ROTATE_FLIP_HOWTO_SELECT: OnOffCopy = {
  on: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（JPG・PNG・WebPなど。1ファイル上限50MB。プレミアムプランでは最大${BATCH_LIMITS["image-rotate-flip"]}枚まとめて選べます）。`,
  off: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（JPG・PNG・WebPなど。最大${BATCH_LIMITS["image-rotate-flip"]}枚まとめて選べます・1ファイル上限50MB）。`,
};
export const IMAGE_ROTATE_HOWTO_SELECT: OnOffCopy = {
  on: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（1ファイル上限50MB。プレミアムプランでは最大${BATCH_LIMITS["image-rotate-flip"]}枚まとめて選べます）。`,
  off: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-rotate-flip"]}枚まとめて選べます・1ファイル上限50MB）。`,
};
export const IMAGE_METADATA_REMOVE_HOWTO_SELECT: OnOffCopy = {
  on: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["image-metadata-remove"]}枚まとめて選べます）。`,
  off: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-metadata-remove"]}枚まとめて選べます）。`,
};
export const IMAGE_WATERMARK_HOWTO_SELECT: OnOffCopy = {
  on: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["image-watermark"]}枚まとめて選べ、同じ透かしを入れられます）。`,
  off: `画像ファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-watermark"]}枚まとめて選べ、同じ透かしを入れられます）。`,
};
export const IMAGE_TILE_SPLIT_HOWTO_SELECT: OnOffCopy = {
  on: `画像をドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["image-tile-split"]}枚まとめて選べます）。`,
  off: `画像をドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-tile-split"]}枚まとめて選べます）。`,
};
export const IMAGE_MOSAIC_HOWTO_SELECT: OnOffCopy = {
  on: `画像をドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["image-mosaic"]}枚まとめて選べ、1枚目で決めた範囲を同じ割合の位置で当てはめます）。`,
  off: `画像をドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["image-mosaic"]}枚まとめて選べ、1枚目で決めた範囲を同じ割合の位置で当てはめます）。`,
};
export const PDF_FIX_HOWTO_SELECT: OnOffCopy = {
  on: `PDFをドラッグ&ドロップ、またはタップして選択します（1ファイル上限50MB。ページ番号・透かしは、プレミアムプランでは最大${BATCH_LIMITS["pdf-fix"]}個まとめて選べます）。`,
  off: `PDFをドラッグ&ドロップ、またはタップして選択します（1ファイル上限50MB。ページ番号・透かしは、最大${BATCH_LIMITS["pdf-fix"]}個まとめて選べます）。`,
};
export const WORD_TO_PDF_HOWTO_SELECT: OnOffCopy = {
  on: `Word文書(.docx)をドラッグ&ドロップ、またはタップして選択します（1ファイル上限30MB。プレミアムプランでは最大${BATCH_LIMITS["word-to-pdf"]}個まとめて選べます）。`,
  off: `Word文書(.docx)をドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["word-to-pdf"]}個まとめて選べます・1ファイル上限30MB）。`,
};
export const EXCEL_TO_PDF_HOWTO_SELECT: OnOffCopy = {
  on: `Excelファイル(.xlsx)をドラッグ&ドロップ、またはタップして選択します（1ファイル上限30MB。プレミアムプランでは最大${BATCH_LIMITS["excel-to-pdf"]}個まとめて選べます）。`,
  off: `Excelファイル(.xlsx)をドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["excel-to-pdf"]}個まとめて選べます・1ファイル上限30MB）。`,
};
export const PDF_PASSWORD_PROTECT_HOWTO_SELECT: OnOffCopy = {
  on: `PDFファイルを選びます（先頭ページがプレビューされます。プレミアムプランでは最大${BATCH_LIMITS["pdf-password-protect"]}個まとめて選べ、同じパスワードを設定できます）。`,
  off: `PDFファイルを選びます（先頭ページがプレビューされます。最大${BATCH_LIMITS["pdf-password-protect"]}個まとめて選べ、同じパスワードを設定できます）。`,
};
export const PDF_RESIZE_PAGES_HOWTO_SELECT: OnOffCopy = {
  on: `PDFファイルをドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["pdf-resize-pages"]}個まとめて選べます）。`,
  off: `PDFファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["pdf-resize-pages"]}個まとめて選べます）。`,
};
export const PDF_METADATA_REMOVE_HOWTO_SELECT: OnOffCopy = {
  on: `PDFファイルをドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["pdf-metadata-remove"]}個まとめて選べ、1つずつ順番に削除します）。`,
  off: `PDFファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["pdf-metadata-remove"]}個まとめて選べ、1つずつ順番に削除します）。`,
};
export const PDF_CROP_PAGES_HOWTO_SELECT: OnOffCopy = {
  on: `PDFファイルをドラッグ&ドロップ、またはタップして選択します（プレミアムプランでは、最大${BATCH_LIMITS["pdf-crop-pages"]}個まとめて選べ、同じ余白で調整できます）。`,
  off: `PDFファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["pdf-crop-pages"]}個まとめて選べ、同じ余白で調整できます）。`,
};
export const FILE_UNZIP_HOWTO_SELECT: OnOffCopy = {
  on: `ZIPファイルをドラッグ&ドロップ、またはタップして選択します（1ファイル上限200MB。プレミアムプランでは最大${BATCH_LIMITS["file-unzip"]}個まとめて選べます）。`,
  off: `ZIPファイルをドラッグ&ドロップ、またはタップして選択します（最大${BATCH_LIMITS["file-unzip"]}個まとめて選べます・1ファイル上限200MB）。`,
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
  PDF_TO_IMAGE_BATCH_ANSWER,
  IMAGE_CROP_BATCH_ANSWER,
  IMAGE_ROTATE_FLIP_BATCH_ANSWER,
  IMAGE_METADATA_REMOVE_BATCH_ANSWER,
  IMAGE_WATERMARK_BATCH_ANSWER,
  IMAGE_TILE_SPLIT_BATCH_ANSWER,
  IMAGE_MOSAIC_BATCH_ANSWER,
  PDF_FIX_BATCH_ANSWER,
  WORD_TO_PDF_BATCH_ANSWER,
  EXCEL_TO_PDF_BATCH_ANSWER,
  PDF_PASSWORD_PROTECT_BATCH_ANSWER,
  PDF_RESIZE_PAGES_BATCH_ANSWER,
  PDF_METADATA_REMOVE_BATCH_ANSWER,
  PDF_CROP_PAGES_BATCH_ANSWER,
  FILE_UNZIP_BATCH_ANSWER,
  PDF_TO_IMAGE_HOWTO_SELECT,
  IMAGE_CROP_HOWTO_SELECT,
  IMAGE_ROTATE_FLIP_HOWTO_SELECT,
  IMAGE_ROTATE_HOWTO_SELECT,
  IMAGE_METADATA_REMOVE_HOWTO_SELECT,
  IMAGE_WATERMARK_HOWTO_SELECT,
  IMAGE_TILE_SPLIT_HOWTO_SELECT,
  IMAGE_MOSAIC_HOWTO_SELECT,
  PDF_FIX_HOWTO_SELECT,
  WORD_TO_PDF_HOWTO_SELECT,
  EXCEL_TO_PDF_HOWTO_SELECT,
  PDF_PASSWORD_PROTECT_HOWTO_SELECT,
  PDF_RESIZE_PAGES_HOWTO_SELECT,
  PDF_METADATA_REMOVE_HOWTO_SELECT,
  PDF_CROP_PAGES_HOWTO_SELECT,
  FILE_UNZIP_HOWTO_SELECT,
];
